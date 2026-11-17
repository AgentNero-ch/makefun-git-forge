// Git object model, pack codec and pkt-line framing: the byte-level half of the forge.
// Everything here is pure Node: crypto for SHA-1, zlib for the pack's compressed entries.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** The SHA-1 of an object: `type <size>\0<bytes>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\u0000`, 'binary');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** An in-memory object database shared by every ref a repository holds. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  put(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  blob(data: Buffer | string): string {
    return this.put('blob', typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  tree(entries: TreeEntry[]): string {
    return this.put('tree', buildTree(entries));
  }

  commit(input: { tree: string; parents: string[]; author: string; committer?: string; message: string; time: number; tz?: string }): string {
    return this.put('commit', buildCommit(input));
  }
}

/** Serialize a tree: entries sorted the way git sorts them (a directory name sorts as `name/`). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((left, right) => {
    const a = left.mode === '40000' ? `${left.name}/` : left.name;
    const b = right.mode === '40000' ? `${right.name}/` : right.name;
    return Buffer.compare(Buffer.from(a, 'binary'), Buffer.from(b, 'binary'));
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'binary'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let index = 0;
  while (index < data.length) {
    const space = data.indexOf(0x20, index);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const mode = data.subarray(index, space).toString('binary');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    index = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** The committer timestamp, epoch seconds. */
  time: number;
}

export function buildCommit(input: { tree: string; parents: string[]; author: string; committer?: string; message: string; time: number; tz?: string }): Buffer {
  const tz = input.tz ?? '+0000';
  const committer = input.committer ?? input.author;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.time} ${tz}`);
  lines.push(`committer ${committer} ${input.time} ${tz}`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message, time: 0 };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7).trim();
    else if (line.startsWith('committer ')) info.committer = line.slice(11).trim();
  }
  const stamp = /(\d+) ([+-]\d{4})$/u.exec(info.committer);
  if (stamp !== null) info.time = Number(stamp[1]);
  return info;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7).trim();
  }
  return info;
}

/** Peel a tag chain down to the commit (or whatever the last object is) it names. */
export function peel(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 10; guard += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    const info = parseTag(object.data);
    if (info.object === '') return current;
    current = info.object;
  }
  return current;
}

/** Every object reachable from `tips`, skipping anything in `stop` and their closure. */
export function collectReachable(store: ObjectStore, tips: Iterable<string>, stop?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    if (stop !== undefined && stop.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const info = parseTag(object.data);
      if (info.object !== '') stack.push(info.object);
    }
  }
  return seen;
}

/** The commits reachable from `tip`, in parent order (parents before their ancestors are revisited). */
export function commitAncestors(store: ObjectStore, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    order.push(oid);
    const info = parseCommit(object.data);
    for (const parent of info.parents) if (!seen.has(parent)) stack.push(parent);
  }
  return order;
}

/** Whether `ancestor` is reachable from `descendant` through parent links. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    if (seen.size > 200_000) return false;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

// ------------------------------------------------------------------ pkt-line framing

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function pktLine(text: string | Buffer): Buffer {
  const payload = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const length = payload.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Split a pkt-line stream into packets; `rest` is whatever follows the last complete packet. */
export function readPackets(body: Buffer, offset = 0): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let index = offset;
  while (index + 4 <= body.length) {
    const head = body.subarray(index, index + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/u.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      index += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      index += 4;
      continue;
    }
    if (length < 4 || index + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(index + 4, index + length) });
    index += length;
  }
  return { packets, rest: body.subarray(index) };
}

// ------------------------------------------------------------------ packs

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let value = size;
  let first = (type << 4) | (value & 0x0f);
  value >>>= 4;
  while (value > 0) {
    bytes.push(first | 0x80);
    first = value & 0x7f;
    value >>>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Write a version-2 pack of `oids` (no deltas: every object full), trailer included. */
export function writePack(store: ObjectStore, oids: Iterable<string>): Buffer {
  const parts: Buffer[] = [];
  const list: string[] = [];
  for (const oid of oids) {
    if (store.has(oid)) list.push(oid);
  }
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const object = store.get(oid) as GitObject;
    parts.push(packHeader(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface RawEntry {
  type: number;
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
}

/** Parse a pack into resolved objects, applying deltas in place. */
export function readPack(store: ObjectStore, pack: Buffer): GitObject[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let index = 12;
  const entries: RawEntry[] = [];
  const offsets = new Map<number, number>();
  for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
    const at = index;
    let byte = pack[index] as number;
    index += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[index] as number;
      index += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (type === 6) {
      let byteOffset = pack[index] as number;
      index += 1;
      let value = byteOffset & 0x7f;
      while ((byteOffset & 0x80) !== 0) {
        byteOffset = pack[index] as number;
        index += 1;
        value = ((value + 1) << 7) | (byteOffset & 0x7f);
      }
      baseOffset = at - value;
    } else if (type === 7) {
      baseOid = pack.subarray(index, index + 20).toString('hex');
      index += 20;
    }
    const inflated = inflateSync(pack.subarray(index), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const consumed = inflated.engine.bytesWritten;
    index += consumed;
    entries.push({ type, data: inflated.buffer, baseOid, baseOffset });
    offsets.set(at, entries.length - 1);
  }
  // Resolve: by delta chain, memoized.
  const resolved: GitObject[] = new Array(entries.length);
  const resolveAt = (entryIndex: number): GitObject => {
    const cached = resolved[entryIndex];
    if (cached !== undefined) return cached;
    const entry = entries[entryIndex] as RawEntry;
    if (entry.type === 6 || entry.type === 7) {
      let base: GitObject | undefined;
      if (entry.baseOid !== undefined) base = store.get(entry.baseOid);
      else if (entry.baseOffset !== undefined) {
        const baseIndex = offsets.get(entry.baseOffset);
        if (baseIndex !== undefined) base = resolveAt(baseIndex);
      }
      if (base === undefined) throw new Error('a delta in the pack has no base object');
      const object: GitObject = { type: base.type, data: applyDelta(base.data, entry.data) };
      resolved[entryIndex] = object;
      return object;
    }
    const type = CODE_TYPE[entry.type];
    if (type === undefined) throw new Error(`unknown pack object type ${entry.type}`);
    const object: GitObject = { type, data: entry.data };
    resolved[entryIndex] = object;
    return object;
  };
  const objects: GitObject[] = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) objects.push(resolveAt(entryIndex));
  return objects;
}

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let index = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[index] as number;
      index += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readSize();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readSize();
  const out = Buffer.allocUnsafe(resultSize);
  let written = 0;
  while (index < delta.length) {
    const op = delta[index] as number;
    index += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset |= delta[index] as number; index += 1; }
      if (op & 0x02) { offset |= (delta[index] as number) << 8; index += 1; }
      if (op & 0x04) { offset |= (delta[index] as number) << 16; index += 1; }
      if (op & 0x08) { offset |= (delta[index] as number) << 24; index += 1; }
      if (op & 0x10) { size |= delta[index] as number; index += 1; }
      if (op & 0x20) { size |= (delta[index] as number) << 8; index += 1; }
      if (op & 0x40) { size |= (delta[index] as number) << 16; index += 1; }
      if (size === 0) size = 0x10000;
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (op !== 0) {
      delta.copy(out, written, index, index + op);
      written += op;
      index += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== resultSize) throw new Error('delta produced the wrong length');
  return out;
}

// ------------------------------------------------------------------ trees as path maps

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Every file (and symlink/executable) a tree holds, keyed by path. Directories are implicit. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const object = store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build the tree objects for a path map, returning the root tree oid. */
export function writeTreeFromPaths(store: ObjectStore, files: Map<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.tree(entries);
  };
  return build(root);
}

/** The object id at `path` inside a tree, or null. */
export function lookupPath(store: ObjectStore, treeOid: string, path: string): FlatEntry | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}
