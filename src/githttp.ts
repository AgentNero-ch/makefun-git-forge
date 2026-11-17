// Git smart HTTP: info/refs advertising, protocol-v2 upload-pack (ls-refs and fetch) and the
// v0 receive-pack that accepts pushes. Everything is answered from the in-process store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FLUSH,
  DELIM,
  type GitObject,
  ObjectStore,
  collectReachable,
  parseCommit,
  parseTag,
  pktLine,
  readPack,
  readPackets,
  peel,
  writePack,
  isAncestor,
} from './git.ts';
import { type Repo, type Store, ZERO_OID, nowIso, refOf } from './store.ts';

const AGENT = 'agent=github-core-clone/1.0';

/** Built packs, keyed by repository version and request: concurrent clones of one tip share the bytes. */
const packCache = new Map<string, { bytes: Buffer; at: number }>();
const PACK_CACHE_MAX = 24;

function cachedPack(repo: Repo, key: string, build: () => Buffer): Buffer {
  const cacheKey = `${repo.id}:${repo.version}:${key}`;
  const hit = packCache.get(cacheKey);
  if (hit !== undefined) return hit.bytes;
  const bytes = build();
  if (packCache.size >= PACK_CACHE_MAX) {
    const oldest = [...packCache.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    if (oldest !== undefined) packCache.delete(oldest[0]);
  }
  packCache.set(cacheKey, { bytes, at: Date.now() });
  return bytes;
}
const SIDEBAND_MAX = 32_768;

/** The advertised capabilities of a v2 upload-pack. */
function v2Capabilities(): string[] {
  return ['version 2', AGENT, 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
}

/** The advertised capabilities of a receive-pack (v0). */
function receiveCapabilities(): string[] {
  return ['report-status', 'side-band-64k', 'delete-refs', AGENT];
}

function writeBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

/** `want` lines reaching into a repository the server does not hold answer this. */
class Refusal extends Error {}

/** The service preamble every info/refs answer starts with. */
function preamble(service: string): Buffer {
  return Buffer.concat([pktLine(`# service=${service}\n`), FLUSH]);
}

const bodyCache = new Map<string, Buffer>();

/** A cached response body, rebuilt only when the repository moves. */
function cachedBody(key: string, build: () => Buffer): Buffer {
  const hit = bodyCache.get(key);
  if (hit !== undefined) return hit;
  const bytes = build();
  if (bodyCache.size > 64) bodyCache.clear();
  bodyCache.set(key, bytes);
  return bytes;
}

/** GET .../info/refs?service=git-upload-pack|git-receive-pack. */
export function handleInfoRefs(store: Store, repo: Repo, service: string, req: IncomingMessage, res: ServerResponse): void {
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').toString().includes('version=2');
  const cacheKey = `adv:${repo.id}:${repo.version}:${service}:${wantsV2 ? 2 : 0}`;
  if (bodyCache.has(cacheKey)) {
    writeBuffer(res, 200, bodyCache.get(cacheKey) as Buffer, `application/x-${service}-advertisement`);
    return;
  }
  const parts: Buffer[] = [preamble(service)];
  if (service === 'git-upload-pack' && wantsV2) {
    parts.push(...v2Capabilities().map((line) => pktLine(`${line}\n`)));
    parts.push(FLUSH);
  } else {
    const refs: Array<{ name: string; oid: string }> = [];
    const head = refOf(repo, `refs/heads/${repo.defaultBranch}`);
    if (head !== null) refs.push({ name: 'HEAD', oid: head });
    for (const [name, oid] of [...repo.refs].sort(([left], [right]) => (left < right ? -1 : 1))) refs.push({ name, oid });
    const capabilities = service === 'git-receive-pack' ? receiveCapabilities() : ['report-status', 'side-band-64k', 'ofs-delta', AGENT, 'shallow'];
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities.join(' ')}\n`));
    } else {
      refs.forEach((ref, index) => {
        const suffix = index === 0 ? `\u0000${capabilities.join(' ')}` : '';
        const symref = ref.name === 'HEAD' ? ` symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
        parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}${symref}\n`));
      });
    }
    parts.push(FLUSH);
  }
  const body = Buffer.concat(parts);
  bodyCache.set(cacheKey, body);
  writeBuffer(res, 200, body, `application/x-${service}-advertisement`);
}

function sideband(band: number, payload: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), payload]));
}

/** Frame a pack in band-1 packets, then close the section. */
function packSection(pack: Buffer): Buffer {
  const parts: Buffer[] = [pktLine('packfile\n')];
  let offset = 0;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_MAX, pack.length));
    parts.push(sideband(1, chunk));
    offset += chunk.length;
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    const [keyword, ...rest] = line.split(' ');
    const value = rest.join(' ').trim();
    if (keyword === 'want') request.wants.push(value);
    else if (keyword === 'have') request.haves.push(value);
    else if (keyword === 'shallow') request.shallow.push(value);
    else if (keyword === 'deepen') request.depth = Number.parseInt(value, 10);
    else if (keyword === 'done') request.done = true;
  }
  return request;
}

/** Objects for a fetch: the wants' closure minus what the client already has. */
function objectsForFetch(
  repo: Repo,
  request: FetchRequest,
): { oids: Set<string>; shallow: string[]; unshallow: string[] } {
  const store = repo.objects;
  const haves = new Set<string>();
  for (const have of request.haves) {
    if (!store.has(have)) continue;
    for (const oid of collectReachable(store, [have])) haves.add(oid);
  }
  const oids = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (request.depth !== null && Number.isFinite(request.depth)) {
    const depth = Math.max(1, request.depth);
    const included = new Set<string>();
    const frontier: Array<{ oid: string; generation: number }> = request.wants.map((oid) => ({ oid, generation: 0 }));
    const boundary = new Set<string>();
    while (frontier.length > 0) {
      const next: Array<{ oid: string; generation: number }> = [];
      for (const item of frontier) {
        if (included.has(item.oid)) continue;
        const object = store.get(item.oid);
        if (object === undefined || object.type !== 'commit') continue;
        included.add(item.oid);
        const info = parseCommit(object.data);
        if (info.parents.length === 0) continue;
        if (item.generation + 1 >= depth) {
          boundary.add(item.oid);
          continue;
        }
        for (const parent of info.parents) next.push({ oid: parent, generation: item.generation + 1 });
      }
      frontier.length = 0;
      frontier.push(...next);
    }
    for (const oid of included) {
      const commit = store.get(oid);
      if (commit === undefined) continue;
      oids.add(oid);
      const info = parseCommit(commit.data);
      for (const object of collectReachable(store, [info.tree])) oids.add(object);
    }
    for (const item of boundary) shallow.push(item);
    for (const oid of request.shallow) {
      if (included.has(oid) && !boundary.has(oid)) unshallow.push(oid);
    }
  } else {
    for (const want of request.wants) {
      if (!store.has(want)) throw new Refusal(`upload-pack: not our ref ${want}`);
      for (const oid of collectReachable(store, [want])) if (!haves.has(oid)) oids.add(oid);
    }
  }
  return { oids, shallow, unshallow };
}

/** POST .../git-upload-pack: a command=ls-refs or command=fetch request. */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer, res: ServerResponse): void {
  const { packets } = readPackets(body);
  const command = packets.find((packet) => packet.kind === 'data' && packet.payload.toString('utf8').startsWith('command='));
  if (command === undefined) {
    // A v0 upload-pack request: parse wants/haves and answer NAK plus a pack.
    const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').replace(/\n$/u, ''));
    const request = parseFetchArgs(lines.slice(1));
    const { oids } = objectsForFetch(repo, request);
    const pack = writePack(repo.objects, oids);
    const head = [pktLine('NAK\n'), FLUSH];
    const chunks: Buffer[] = [...head];
    let offset = 0;
    while (offset < pack.length) {
      const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_MAX, pack.length));
      chunks.push(sideband(1, chunk));
      offset += chunk.length;
    }
    chunks.push(FLUSH);
    writeBuffer(res, 200, Buffer.concat(chunks), 'application/x-git-upload-pack-result');
    return;
  }
  const name = command.payload.toString('utf8').replace(/\n$/u, '').slice('command='.length);
  const afterDelim = (() => {
    const index = packets.findIndex((packet) => packet.kind === 'delim' || packet.kind === 'flush');
    return index < 0 ? [] : packets.slice(index + 1).filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
  })();
  if (name === 'ls-refs') {
    const args = afterDelim.map((line) => line.replace(/\n$/u, ''));
    const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length).trim());
    const peelWanted = args.includes('peel');
    const symrefsWanted = args.includes('symrefs');
    const includeUnborn = args.includes('unborn');
    const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
    const parts: Buffer[] = [];
    const head = refOf(repo, `refs/heads/${repo.defaultBranch}`);
    if (matches('HEAD')) {
      if (head !== null) parts.push(pktLine(`${head} HEAD${symrefsWanted ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
      else if (includeUnborn) parts.push(pktLine(`unborn HEAD${symrefsWanted ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
    for (const [ref, oid] of [...repo.refs].sort(([left], [right]) => (left < right ? -1 : 1))) {
      if (!matches(ref)) continue;
      let line = `${oid} ${ref}`;
      if (peelWanted && ref.startsWith('refs/tags/')) {
        const object = repo.objects.get(oid);
        if (object !== undefined && object.type === 'tag') line += ` peeled:${peel(repo.objects, oid)}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
    parts.push(FLUSH);
    writeBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  if (name === 'fetch') {
    const request = parseFetchArgs(afterDelim.map((line) => line.replace(/\n$/u, '')));
    let selection: { oids: Set<string>; shallow: string[]; unshallow: string[] };
    try {
      selection = objectsForFetch(repo, request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeBuffer(res, 200, Buffer.concat([sideband(3, Buffer.from(`${message}\n`)), FLUSH]), 'application/x-git-upload-pack-result');
      return;
    }
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    if (request.haves.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      const known = request.haves.filter((oid) => repo.objects.has(oid));
      if (known.length === 0) parts.push(pktLine('NAK\n'));
      else parts.push(...known.map((oid) => pktLine(`ACK ${oid}\n`)), pktLine('ready\n'));
    }
    parts.push(FLUSH);
    if (request.depth !== null || selection.shallow.length > 0 || selection.unshallow.length > 0) {
      if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(FLUSH);
      }
    }
    const wantsKey = [...request.wants].sort().join(',');
    const havesKey = [...request.haves].sort().join(',');
    const cacheKey = `f:${wantsKey}|${request.depth ?? ''}|${request.shallow.join(',')}|${havesKey}`;
    const pack = request.haves.length === 0 && request.shallow.length === 0
      ? cachedPack(repo, cacheKey, () => writePack(repo.objects, orderForPack(repo.objects, selection.oids)))
      : writePack(repo.objects, orderForPack(repo.objects, selection.oids));
    parts.push(packSection(pack));
    writeBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  writeBuffer(res, 200, Buffer.concat([pktLine(`ERR unknown command ${name}\n`), FLUSH]), 'application/x-git-upload-pack-result');
}

/** Commits and trees before the blobs they name, so a reader can resolve as it goes. */
function orderForPack(store: ObjectStore, oids: Set<string>): string[] {
  const commits: string[] = [];
  const trees: string[] = [];
  const tags: string[] = [];
  const blobs: string[] = [];
  for (const oid of oids) {
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') commits.push(oid);
    else if (object.type === 'tree') trees.push(oid);
    else if (object.type === 'tag') tags.push(oid);
    else blobs.push(oid);
  }
  return [...commits, ...tags, ...trees, ...blobs];
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST .../git-receive-pack: unpack the pack, update refs, answer report-status. */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer, res: ServerResponse): void {
  const { packets, rest } = readPackets(body);
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    const head = nul < 0 ? text : text.slice(0, nul);
    if (nul >= 0) capabilities = text.slice(nul + 1).trim().split(' ');
    const trimmed = head.replace(/\n$/u, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/u.exec(trimmed);
    if (match === null) continue;
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  const sidebandWanted = capabilities.includes('side-band-64k');
  const reportWanted = capabilities.some((capability) => capability === 'report-status' || capability === 'report-status-v2');
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 20) {
    try {
      const objects = readPack(repo.objects, rest);
      for (const object of objects) repo.objects.put(object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lines: string[] = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? null;
      if (command.newOid === ZERO_OID) {
        if (current === null) {
          lines.push(`ng ${command.ref} branch not found`);
          continue;
        }
        if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          lines.push(`ng ${command.ref} fetch first`);
          continue;
        }
        repo.refs.delete(command.ref);
        repo.version += 1;
        lines.push(`ok ${command.ref}`);
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        lines.push(`ng ${command.ref} missing necessary objects`);
        continue;
      }
      if (current !== null && command.oldOid !== ZERO_OID && command.oldOid !== current) {
        lines.push(`ng ${command.ref} fetch first`);
        continue;
      }
      if (current !== null && command.ref.startsWith('refs/heads/')) {
        const object = repo.objects.get(command.newOid);
        const fastForward = object !== undefined && object.type === 'commit' && isAncestor(repo.objects, current, command.newOid);
        if (!fastForward) {
          lines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      repo.version += 1;
      if (command.ref.startsWith('refs/heads/')) {
        repo.pushedAt = nowIso();
        repo.updatedAt = repo.pushedAt;
        const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/'));
        if (branches.length === 1) repo.defaultBranch = command.ref.slice('refs/heads/'.length);
      }
      lines.push(`ok ${command.ref}`);
    }
  }
  const report = Buffer.concat([
    pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`),
    ...(unpackOk ? lines.map((line) => pktLine(`${line}\n`)) : []),
    FLUSH,
  ]);
  const parts: Buffer[] = [];
  if (sidebandWanted) {
    let offset = 0;
    while (offset < report.length) {
      const chunk = report.subarray(offset, Math.min(offset + SIDEBAND_MAX, report.length));
      parts.push(sideband(1, chunk));
      offset += chunk.length;
    }
    parts.push(FLUSH);
  } else if (reportWanted) {
    parts.push(report);
  }
  writeBuffer(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

/** A tag object's peeled target, for `ls-refs` and REST. */
export function peelTag(repo: Repo, oid: string): { oid: string; type: string } | null {
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type !== 'tag') return { oid, type: object.type };
  const info = parseTag(object.data);
  return { oid: info.object, type: info.type };
}

/** Whether an object is a commit and its bytes parse; used by the REST commit routes. */
export function asCommit(repo: Repo, oid: string): ReturnType<typeof parseCommit> | null {
  const object: GitObject | undefined = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}
