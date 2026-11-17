// The forge's store: users, repositories, refs, issues, comments and pull requests, with the
// operations the REST, GraphQL, MCP and git surfaces all share. One process, one store, no database.

import {
  type GitObject,
  type ObjectType,
  ObjectStore,
  buildCommit,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  lookupPath,
  parseCommit,
  parseTag,
  peel,
  writeTreeFromPaths,
} from './git.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  commentsCount: number;
  isPullRequest: boolean;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** The base ref's tip when the pull request was opened, for mergeability and diffs. */
  baseShaAtCreation: string | null;
}

export interface Repo {
  id: number;
  owner: User;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  objects: ObjectStore;
  refs: Map<string, string>;
  issues: Issue[];
  issueSeq: number;
  pulls: PullRequest[];
  pullSeq: number;
  labels: Label[];
  labelSeq: number;
  fork: boolean;
  archived: boolean;
  /** A counter bumped on every ref or object change: a cache key for derived answers. */
  version: number;
  openIssuesCount?: number;
}

/** A 40-hex all-zero oid, git's "no object". */
export const ZERO_OID = '0'.repeat(40);

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** A node id: base64 of `type:id`, opaque to a client and stable across reads. */
export function nodeId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

export function parseNodeId(value: string): { type: string; id: number } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/u.exec(text);
    if (match === null) return null;
    return { type: match[1] as string, id: Number(match[2]) };
  } catch {
    return null;
  }
}

const DEFAULT_LABEL_COLORS = ['d73a4a', '0075ca', 'cfd3d7', 'a2eeef', '7057ff', '008672'];

/** The whole forge. */
export class Store {
  readonly users = new Map<string, User>();
  readonly repos = new Map<string, Repo>();
  private nextId = 100_000;
  private nextRepoId = 9_000;

  constructor() {
    this.addUser({ id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' });
    this.addUser({ id: 1001, login: 'teammate', name: 'teammate', email: 'teammate@example.invalid' });
    this.addUser({ id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' });
  }

  addUser(user: User): void {
    this.users.set(user.login, user);
  }

  allocateId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  findRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  findRepoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  createRepo(owner: User, name: string, options: { description?: string | null; private?: boolean; autoInit?: boolean }): Repo {
    const timestamp = nowIso();
    const repo: Repo = {
      id: this.nextRepoId + 1,
      owner,
      name,
      description: options.description ?? null,
      private: options.private === true,
      defaultBranch: 'main',
      createdAt: timestamp,
      updatedAt: timestamp,
      pushedAt: null,
      objects: new ObjectStore(),
      refs: new Map(),
      issues: [],
      issueSeq: 0,
      pulls: [],
      pullSeq: 0,
      labels: [],
      labelSeq: 0,
      fork: false,
      archived: false,
      version: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner.login, name), repo);
    return repo;
  }

  repositoriesOf(owner: string): Repo[] {
    const list: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.login === owner) list.push(repo);
    return list.sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.name < right.name ? -1 : 1));
  }

  // ------------------------------------------------------------------ refs and objects

  ref(repo: Repo, name: string): string | null {
    return repo.refs.get(name) ?? null;
  }

  headOid(repo: Repo): string | null {
    return refOf(repo, `refs/heads/${repo.defaultBranch}`);
  }

  branches(repo: Repo): Array<{ name: string; oid: string }> {
    const list: Array<{ name: string; oid: string }> = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) list.push({ name: ref.slice('refs/heads/'.length), oid });
    }
    return list.sort((left, right) => (left.name < right.name ? -1 : 1));
  }

  tags(repo: Repo): Array<{ name: string; oid: string }> {
    const list: Array<{ name: string; oid: string }> = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/tags/')) list.push({ name: ref.slice('refs/tags/'.length), oid });
    }
    return list.sort((left, right) => (left.name < right.name ? -1 : 1));
  }

  commitOf(repo: Repo, oid: string): { oid: string; tree: string; parents: string[]; message: string; author: string; committer: string; time: number } | null {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    const info = parseCommit(object.data);
    return { oid, tree: info.tree, parents: info.parents, message: info.message, author: info.author, committer: info.committer, time: info.time };
  }

  /** The commits reachable from `oid`, newest first (a breadth-first walk over parents). */
  commitsFrom(repo: Repo, oid: string, limit = 2000): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    let frontier = [oid];
    while (frontier.length > 0 && order.length < limit) {
      const next: string[] = [];
      for (const candidate of frontier) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const commit = this.commitOf(repo, candidate);
        if (commit === null) continue;
        order.push(candidate);
        for (const parent of commit.parents) if (!seen.has(parent)) next.push(parent);
      }
      frontier = next;
    }
    return order;
  }

  /** The tree a path map describes, written into the repository's object store. */
  treeFor(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    return writeTreeFromPaths(repo.objects, files);
  }

  /** Write a commit on top of `parent` (when given) whose tree is `files`. */
  writeCommit(repo: Repo, files: Map<string, { mode: string; oid: string }>, parent: string | null, message: string, author: User): string {
    repo.version += 1;
    const tree = this.treeFor(repo, files);
    const time = Math.floor(Date.now() / 1000);
    const identity = `${author.name} <${author.email}>`;
    const data = buildCommit({ tree, parents: parent === null ? [] : [parent], author: identity, committer: identity, message, time });
    return repo.objects.put('commit', data);
  }

  /** Set a branch ref, creating it when it does not exist. */
  setBranch(repo: Repo, name: string, oid: string): void {
    repo.version += 1;
    repo.refs.set(`refs/heads/${name}`, oid);
    repo.pushedAt = nowIso();
    repo.updatedAt = repo.pushedAt;
    if (![...repo.refs.keys()].some((ref) => ref.startsWith('refs/heads/'))) repo.defaultBranch = name;
  }

  // ------------------------------------------------------------------ contents

  /** Read a path at a ref (a branch name, a tag or a commit id); null when absent. */
  readContents(repo: Repo, path: string, ref?: string | null): { entry: { mode: string; oid: string }; sha: string; commitSha: string | null } | null {
    const target = this.resolveRef(repo, ref);
    if (target === null) return null;
    const commit = this.commitOf(repo, target.oid);
    if (commit === null) return null;
    const entry = lookupPath(repo.objects, commit.tree, path);
    if (entry === null) return null;
    return { entry, sha: entry.oid, commitSha: target.oid };
  }

  /** Resolve a ref (branch, tag, commit id, or null for the default branch). */
  resolveRef(repo: Repo, ref?: string | null): { oid: string; commit: string } | null {
    const name = ref === undefined || ref === null || ref === '' ? repo.defaultBranch : ref;
    const branch = refOf(repo, `refs/heads/${name}`);
    if (branch !== null) {
      const peeled = peel(repo.objects, branch);
      return { oid: branch, commit: peeled };
    }
    const tag = refOf(repo, `refs/tags/${name}`);
    if (tag !== null) return { oid: tag, commit: peel(repo.objects, tag) };
    if (/^[0-9a-f]{40}$/u.test(name) && repo.objects.has(name)) return { oid: name, commit: peel(repo.objects, name) };
    return null;
  }

  /** Write a file at a branch, committing; creates the branch from the default branch when missing. */
  writeContents(repo: Repo, input: { path: string; content: Buffer; message: string; branch?: string | null; author: User }): { commit: string; contentSha: string; branch: string } | null {
    const branch = input.branch === undefined || input.branch === null || input.branch === '' ? repo.defaultBranch : input.branch;
    let parent = refOf(repo, `refs/heads/${branch}`);
    if (parent === null && branch !== repo.defaultBranch) parent = this.headOid(repo);
    const parentCommit = parent === null ? null : this.commitOf(repo, parent);
    const files = parentCommit === null ? new Map() : flattenTree(repo.objects, parentCommit.tree);
    // A directory write path must not collide with an existing file.
    const contentSha = repo.objects.blob(input.content);
    files.set(input.path.replace(/^\/+/u, ''), { mode: '100644', oid: contentSha });
    const commit = this.writeCommit(repo, files, parent, input.message, input.author);
    this.setBranch(repo, branch, commit);
    return { commit, contentSha, branch };
  }

  /** Delete a file at a branch, committing. */
  deleteContents(repo: Repo, input: { path: string; message: string; branch?: string | null; author: User }): { commit: string } | null {
    const branch = input.branch === undefined || input.branch === null || input.branch === '' ? repo.defaultBranch : input.branch;
    const parent = refOf(repo, `refs/heads/${branch}`);
    if (parent === null) return null;
    const commit = this.commitOf(repo, parent);
    if (commit === null) return null;
    const files = flattenTree(repo.objects, commit.tree);
    if (!files.delete(input.path.replace(/^\/+/u, ''))) return null;
    const next = this.writeCommit(repo, files, parent, input.message, input.author);
    this.setBranch(repo, branch, next);
    return { commit: next };
  }

  // ------------------------------------------------------------------ issues

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[]; user: User }): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.find((candidate) => candidate.name === name);
      if (label === undefined) return { error: `Label does not exist: ${name}` };
      labels.push(label);
    }
    repo.issueSeq += 1;
    const timestamp = nowIso();
    const issue: Issue = {
      id: this.allocateId(),
      number: repo.issueSeq,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      user: input.user,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      comments: [],
      commentsCount: 0,
      isPullRequest: false,
    };
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.find((issue) => issue.number === number) ?? null;
  }

  createLabel(repo: Repo, name: string, color = 'ededed', description: string | null = null): Label | null {
    if (repo.labels.some((label) => label.name === name)) return null;
    repo.labelSeq += 1;
    const label: Label = { id: this.allocateId(), name, color, description };
    repo.labels.push(label);
    return label;
  }

  addComment(repo: Repo, issue: Issue, body: string, user: User): Comment {
    const timestamp = nowIso();
    const comment: Comment = { id: this.allocateId(), body, user, createdAt: timestamp, updatedAt: timestamp };
    issue.comments.push(comment);
    issue.commentsCount = issue.comments.length;
    issue.updatedAt = timestamp;
    return comment;
  }

  // ------------------------------------------------------------------ pull requests

  createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string; user: User }): PullRequest | { error: string; status: number } {
    const headOid = refOf(repo, `refs/heads/${input.head}`);
    if (headOid === null) return { error: `No commits between ${input.base} and ${input.head}`, status: 422 };
    const baseOid = refOf(repo, `refs/heads/${input.base}`);
    if (baseOid === null) return { error: `Base branch not found: ${input.base}`, status: 422 };
    const existing = repo.pulls.find((pull) => pull.head === input.head && pull.base === input.base && pull.state === 'open');
    if (existing !== undefined) return { error: 'A pull request already exists for these branches', status: 422 };
    repo.pullSeq += 1;
    const timestamp = nowIso();
    const pull: PullRequest = {
      id: this.allocateId(),
      number: repo.pullSeq,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: input.head,
      base: input.base,
      user: input.user,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      baseShaAtCreation: baseOid,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo: Repo, number: number): PullRequest | null {
    return repo.pulls.find((pull) => pull.number === number) ?? null;
  }

  /** The merge base of two commits, or null when they share no history. */
  mergeBase(repo: Repo, left: string, right: string): string | null {
    const leftAncestors: string[] = [];
    const seen = new Set<string>();
    let frontier = [left];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        leftAncestors.push(oid);
        const commit = this.commitOf(repo, oid);
        if (commit !== null) for (const parent of commit.parents) next.push(parent);
      }
      frontier = next;
    }
    const leftSet = new Set(leftAncestors);
    seen.clear();
    frontier = [right];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (leftSet.has(oid)) return oid;
        const commit = this.commitOf(repo, oid);
        if (commit !== null) for (const parent of commit.parents) next.push(parent);
      }
      frontier = next;
    }
    return null;
  }

  /**
   * A three-way merge of two commits over their merge base. Returns the merged path map, or null on
   * a conflict (both sides changed the same path to different content).
   */
  threeWayMerge(repo: Repo, base: string | null, left: string, right: string): Map<string, { mode: string; oid: string }> | null {
    const baseFiles = base === null ? new Map() : flattenTree(repo.objects, (this.commitOf(repo, base) as { tree: string }).tree);
    const leftFiles = flattenTree(repo.objects, (this.commitOf(repo, left) as { tree: string }).tree);
    const rightFiles = flattenTree(repo.objects, (this.commitOf(repo, right) as { tree: string }).tree);
    const merged = new Map<string, { mode: string; oid: string }>();
    const paths = new Set<string>([...baseFiles.keys(), ...leftFiles.keys(), ...rightFiles.keys()]);
    for (const path of paths) {
      const baseEntry = baseFiles.get(path);
      const leftEntry = leftFiles.get(path);
      const rightEntry = rightFiles.get(path);
      const same = (a: { oid: string } | undefined, b: { oid: string } | undefined): boolean =>
        a === undefined ? b === undefined : b !== undefined && a.oid === b.oid;
      if (same(leftEntry, rightEntry)) {
        if (leftEntry !== undefined) merged.set(path, leftEntry);
        continue;
      }
      if (same(leftEntry, baseEntry)) {
        if (rightEntry !== undefined) merged.set(path, rightEntry);
        continue;
      }
      if (same(rightEntry, baseEntry)) {
        if (leftEntry !== undefined) merged.set(path, leftEntry);
        continue;
      }
      return null;
    }
    return merged;
  }

  /** Whether the pull request can be merged: its head and base must merge without conflict. */
  pullMergeable(repo: Repo, pull: PullRequest): { mergeable: boolean; base: string; head: string } | null {
    if (pull.state !== 'open' || pull.merged) return { mergeable: false, base: '', head: '' };
    const baseOid = refOf(repo, `refs/heads/${pull.base}`);
    const headOid = refOf(repo, `refs/heads/${pull.head}`);
    if (baseOid === null || headOid === null) return null;
    const baseCommit = this.commitOf(repo, baseOid);
    const headCommit = this.commitOf(repo, headOid);
    if (baseCommit === null || headCommit === null) return null;
    if (isAncestor(repo.objects, headOid, baseOid)) return { mergeable: false, base: baseOid, head: headOid };
    const base = this.mergeBase(repo, baseOid, headOid);
    const merged = this.threeWayMerge(repo, base, baseOid, headOid);
    return { mergeable: merged !== null, base: baseOid, head: headOid };
  }

  /** Merge a pull request; returns the merge commit oid or an error string. */
  mergePull(repo: Repo, pull: PullRequest, method: 'merge' | 'squash' | 'rebase', user: User): { sha: string } | { error: string; status: number } {
    if (pull.merged) return { error: 'Pull Request is not mergeable', status: 405 };
    if (pull.state !== 'open') return { error: 'Pull Request is not mergeable', status: 405 };
    const baseOid = refOf(repo, `refs/heads/${pull.base}`);
    const headOid = refOf(repo, `refs/heads/${pull.head}`);
    if (baseOid === null || headOid === null) return { error: 'Pull Request is not mergeable', status: 405 };
    const baseCommit = this.commitOf(repo, baseOid);
    const headCommit = this.commitOf(repo, headOid);
    if (baseCommit === null || headCommit === null) return { error: 'Pull Request is not mergeable', status: 405 };
    const time = Math.floor(Date.now() / 1000);
    const identity = `${user.name} <${user.email}>`;
    let mergeCommit: string;
    if (isAncestor(repo.objects, headOid, baseOid)) {
      // Nothing to do: the base already contains the head.
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = baseOid;
      pull.updatedAt = pull.mergedAt;
      pull.closedAt = pull.mergedAt;
      return { sha: baseOid };
    }
    const mergeBase = this.mergeBase(repo, baseOid, headOid);
    const mergedTree = this.threeWayMerge(repo, mergeBase, baseOid, headOid);
    if (mergedTree === null) return { error: 'Pull Request is not mergeable', status: 405 };
    const tree = this.treeFor(repo, mergedTree);
    const message = method === 'squash' ? `${pull.title} (#${pull.number})\n\n${pull.body}`.trim() : `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
    const parents = method === 'merge' ? [baseOid, headOid] : [baseOid];
    mergeCommit = repo.objects.put('commit', buildCommit({ tree, parents, author: identity, committer: identity, message, time }));
    this.setBranch(repo, pull.base, mergeCommit);
    // Every branch that pointed at the old base tip and is not the merged head follows the merge.
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = mergeCommit;
    pull.updatedAt = pull.mergedAt;
    pull.closedAt = pull.mergedAt;
    return { sha: mergeCommit };
  }

  /** The files a pull request changes, with line counts from the merge base to its head. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; path: string; status: string; additions: number; deletions: number; changes: number; sha: string; previous_filename?: string }> {
    const baseOid = refOf(repo, `refs/heads/${pull.base}`) ?? pull.baseShaAtCreation;
    const headOid = refOf(repo, `refs/heads/${pull.head}`);
    if (baseOid === null || headOid === null) return [];
    const baseCommit = this.commitOf(repo, baseOid);
    const headCommit = this.commitOf(repo, headOid);
    if (baseCommit === null || headCommit === null) return [];
    const mergeBase = this.mergeBase(repo, baseOid, headOid);
    const baseTree = mergeBase === null ? baseCommit.tree : (this.commitOf(repo, mergeBase) as { tree: string }).tree;
    const baseFiles = flattenTree(repo.objects, baseTree);
    const headFiles = flattenTree(repo.objects, headCommit.tree);
    const files: Array<{ filename: string; path: string; status: string; additions: number; deletions: number; changes: number; sha: string }> = [];
    for (const [path, entry] of headFiles) {
      const before = baseFiles.get(path);
      if (before !== undefined && before.oid === entry.oid) continue;
      const after = repo.objects.get(entry.oid);
      const old = before === undefined ? null : (repo.objects.get(before.oid) ?? null);
      const counts = lineCounts(old === null ? '' : old.data.toString('utf8'), after === undefined ? '' : after.data.toString('utf8'));
      files.push({
        filename: path,
        path,
        status: before === undefined ? 'added' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        sha: entry.oid,
      });
    }
    for (const path of baseFiles.keys()) {
      if (headFiles.has(path)) continue;
      const old = repo.objects.get((baseFiles.get(path) as { oid: string }).oid);
      const lines = old === undefined ? 0 : old.data.toString('utf8').split('\n').length;
      files.push({ filename: path, path, status: 'removed', additions: 0, deletions: lines, changes: lines, sha: (baseFiles.get(path) as { oid: string }).oid });
    }
    return files.sort((left, right) => (left.filename < right.filename ? -1 : 1));
  }

  /** The commits a pull request adds over its base. */
  pullCommits(repo: Repo, pull: PullRequest): string[] {
    const baseOid = refOf(repo, `refs/heads/${pull.base}`);
    const headOid = refOf(repo, `refs/heads/${pull.head}`);
    if (baseOid === null || headOid === null) return [];
    const mergeBase = this.mergeBase(repo, baseOid, headOid);
    const stop = mergeBase === null ? new Set<string>() : collectReachable(repo.objects, [mergeBase]);
    return this.commitsFrom(repo, headOid).filter((oid) => !stop.has(oid));
  }

  /** Every object a ref currently needs, for a full clone. */
  reachableOf(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(repo.objects, tips);
  }
}

/** Line counts between two text blobs: a crude but deterministic add/remove tally. */
export function lineCounts(before: string, after: string): { additions: number; deletions: number } {
  const oldLines = before === '' ? [] : before.split('\n');
  const newLines = after === '' ? [] : after.split('\n');
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const count = oldSet.get(line) ?? 0;
    if (count > 0) oldSet.set(line, count - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of oldSet.values()) deletions += count;
  return { additions, deletions };
}

/** An object's type and bytes, for a lookup that must answer null instead of throwing. */
export function objectOf(repo: Repo, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

/** Store an object of any type (used by the receive-pack side). */
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.put(type, data);
  return oid;
}

/** The tree a tag ultimately names, peeling through annotated tags. */
export function tagTarget(repo: Repo, oid: string): { oid: string; type: string } | null {
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'tag') {
    const info = parseTag(object.data);
    return { oid: info.object, type: info.type };
  }
  return { oid, type: object.type };
}

/** A ref's object id, or null when the repository does not hold it. */
export function refOf(repo: Repo, name: string): string | null {
  return repo.refs.get(name) ?? null;
}
