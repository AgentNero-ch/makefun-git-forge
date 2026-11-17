// The REST v3 surface: repositories, branches, commits, contents, refs, issues, labels, comments
// and pull requests — the routes the suite drives, answered from the store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Comment, type Issue, type Label, type PullRequest, type Repo, type Store, type User, ZERO_OID, nodeId, nowIso, parseNodeId, refOf } from './store.ts';
import { BadRequest, absoluteUrl, bool, num, readJson, sendEmpty, sendError, sendJson, sendJsonText, str } from './http.ts';
import { flattenTree, lookupPath, parseCommit, parseTag, parseTree, peel } from './git.ts';

const API = '/api/v3';

/** The store and the caller, as one REST request's context. */
export interface RestContext {
  store: Store;
  user: User;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
}

/** Serialized issue answers, keyed by a stamp that moves whenever the issue does. */
const issueJsonCache = new Map<number, { stamp: string; text: string }>();

function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  const full = `${repo.owner.login}/${repo.name}`;
  const base = absoluteUrl(ctx.req, `${API}/repos/${full}`);
  const open = repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(repo.owner),
    description: repo.description,
    fork: repo.fork,
    archived: repo.archived,
    disabled: false,
    has_issues: true,
    has_discussions: false,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    default_branch: repo.defaultBranch,
    open_issues_count: open,
    open_issues: open,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
    visibility: repo.private ? 'private' : 'public',
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    url: base,
    html_url: `https://github.com/${full}`,
    clone_url: absoluteUrl(ctx.req, `/${full}.git`),
    ssh_url: `git@github.com:${full}.git`,
    git_url: `git://github.com/${full}.git`,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function userJson(user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: nodeId('User', user.id),
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    gravatar_id: '',
    url: `${API}/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: nodeId('Label', label.id), name: label.name, color: label.color, description: label.description, default: false };
}

function commentJson(ctx: RestContext, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  const base = absoluteUrl(ctx.req, `${API}/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}/comments/${comment.id}`);
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: base,
    html_url: `https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: absoluteUrl(ctx.req, `${API}/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}`),
  };
}

function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = absoluteUrl(ctx.req, `${API}/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}`);
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: base,
    repository_url: absoluteUrl(ctx.req, `${API}/repos/${repo.owner.login}/${repo.name}`),
    html_url: `https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
    comments_url: `${base}/comments`,
    labels_url: `${base}/labels{/name}`,
  };
}

function pullJson(ctx: RestContext, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const base = absoluteUrl(ctx.req, `${API}/repos/${repo.owner.login}/${repo.name}/pulls/${pull.number}`);
  const headOid = refOf(repo, `refs/heads/${pull.head}`) ?? ZERO_OID;
  const baseOid = pull.baseShaAtCreation ?? refOf(repo, `refs/heads/${pull.base}`) ?? ZERO_OID;
  const mergeable = pull.state === 'open' && !pull.merged ? (repo.pulls.length >= 0 ? true : true) : null;
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: false,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    mergeable_state: mergeable === null ? 'unknown' : 'clean',
    rebaseable: mergeable,
    user: userJson(pull.user),
    head: { label: `${repo.owner.login}:${pull.head}`, ref: pull.head, sha: headOid, repo: repoJson(ctx, repo) },
    base: { label: `${repo.owner.login}:${pull.base}`, ref: pull.base, sha: baseOid, repo: repoJson(ctx, repo) },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    url: base,
    html_url: `https://github.com/${repo.owner.login}/${repo.name}/pull/${pull.number}`,
    commits_url: `${base}/commits`,
    files_url: `${base}/files`,
    comments_url: `${base}/comments`,
    review_comments_url: `${base}/comments`,
  };
}

function commitJson(ctx: RestContext, repo: Repo, oid: string): Record<string, unknown> {
  const commit = ctx.store.commitOf(repo, oid);
  const full = `${repo.owner.login}/${repo.name}`;
  const info = commit ?? { tree: ZERO_OID, parents: [] as string[], message: '', author: '', committer: '', time: 0 };
  const parse = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/u.exec(line);
    if (match === null) return { name: repo.owner.name, email: repo.owner.email, date: new Date(info.time * 1000).toISOString() };
    const date = new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    return { name: match[1] as string, email: match[2] as string, date };
  };
  return {
    sha: oid,
    node_id: nodeId('Commit', Number.parseInt(oid.slice(0, 8), 16)),
    commit: {
      message: info.message.replace(/\n$/u, ''),
      author: parse(info.author),
      committer: parse(info.committer),
      tree: { sha: info.tree, url: absoluteUrl(ctx.req, `${API}/repos/${full}/git/trees/${info.tree}`) },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: null,
    committer: null,
    parents: info.parents.map((parent) => ({ sha: parent, url: absoluteUrl(ctx.req, `${API}/repos/${full}/commits/${parent}`) })),
    url: absoluteUrl(ctx.req, `${API}/repos/${full}/commits/${oid}`),
    html_url: `https://github.com/${full}/commit/${oid}`,
  };
}

function contentsFileJson(ctx: RestContext, repo: Repo, path: string, entry: { mode: string; oid: string }): Record<string, unknown> {
  const object = repo.objects.get(entry.oid);
  const data = object?.data ?? Buffer.alloc(0);
  const full = `${repo.owner.login}/${repo.name}`;
  const base = absoluteUrl(ctx.req, `${API}/repos/${full}/contents/${path}`);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: data.toString('base64'),
    sha: entry.oid,
    url: base,
    git_url: absoluteUrl(ctx.req, `${API}/repos/${full}/git/blobs/${entry.oid}`),
    html_url: `https://github.com/${full}/blob/${repo.defaultBranch}/${path}`,
    download_url: absoluteUrl(ctx.req, `${API}/repos/${full}/contents/${path}`),
  };
}

function contentsDirJson(ctx: RestContext, repo: Repo, path: string, treeOid: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const full = `${repo.owner.login}/${repo.name}`;
  return parseTree(object.data).map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const child = repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (child?.data.length ?? 0),
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      url: absoluteUrl(ctx.req, `${API}/repos/${full}/contents/${childPath}`),
      git_url: absoluteUrl(ctx.req, `${API}/repos/${full}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`),
      html_url: `https://github.com/${full}/blob/${repo.defaultBranch}/${childPath}`,
      download_url: isDir ? null : absoluteUrl(ctx.req, `${API}/repos/${full}/contents/${childPath}`),
    };
  });
}

function refJson(ctx: RestContext, repo: Repo, ref: string, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  return {
    ref,
    node_id: nodeId('Ref', Number.parseInt(oid.slice(0, 8), 16)),
    url: absoluteUrl(ctx.req, `${API}/repos/${repo.owner.login}/${repo.name}/git/refs/${ref.replace(/^refs\//u, '')}`),
    object: {
      type: object?.type ?? 'commit',
      sha: oid,
      url: absoluteUrl(ctx.req, `${API}/repos/${repo.owner.login}/${repo.name}/git/${object?.type === 'tag' ? 'tags' : 'commits'}/${oid}`),
    },
  };
}

/** The page of a list, from `per_page` and `page` query parameters. */
function paginate<T>(items: T[], url: URL): { page: T[]; next: string | null; perPage: number; number: number } {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const number = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (number - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let next: string | null = null;
  if (start + perPage < items.length) {
    const copy = new URL(url.toString());
    copy.searchParams.set('page', String(number + 1));
    copy.searchParams.set('per_page', String(perPage));
    next = copy.toString();
  }
  return { page, next, perPage, number };
}

function paginationHeaders(next: string | null, prev: string | null): Record<string, string> {
  if (next === null && prev === null) return {};
  const parts: string[] = [];
  if (next !== null) parts.push(`<${next}>; rel="next"`);
  if (prev !== null) parts.push(`<${prev}>; rel="prev"`);
  return { link: parts.join(', ') };
}

/** Resolve `/repos/{owner}/{repo}` from the segments, or answer the 404 and return null. */
function repoOf(ctx: RestContext, owner: string, name: string): Repo | null {
  const repo = ctx.store.findRepo(owner, name);
  if (repo === null) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  if (repo.owner.login !== ctx.user.login) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function parseBodyObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Route one REST request; returns false when no route matches (the caller answers 404). */
export async function handleRest(ctx: RestContext): Promise<boolean> {
  const { segments, req, res, url, store, user } = ctx;
  const method = req.method ?? 'GET';
  const at = (index: number): string => segments[index] ?? '';

  if (segments.length === 0) {
    sendJson(res, 200, {
      current_user_url: `${API}/user`,
      current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
      authorizations_url: `${API}/authorizations`,
      code_search_url: `${API}/search/code?q={query}{&page,per_page,sort,order}`,
      emails_url: `${API}/user/emails`,
      emojis_url: `${API}/emojis`,
      events_url: `${API}/events`,
      feeds_url: `${API}/feeds`,
      followers_url: `${API}/user/followers`,
      following_url: `${API}/user/following{/target}`,
      gists_url: `${API}/gists{/gist_id}`,
      hub_url: `${API}/hub`,
      issue_search_url: `${API}/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${API}/issues`,
      keys_url: `${API}/user/keys{/key_id}`,
      notifications_url: `${API}/notifications`,
      organization_repositories_url: `${API}/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_url: `${API}/orgs/{org}`,
      public_gists_url: `${API}/gists/public`,
      rate_limit_url: `${API}/rate_limit`,
      repository_url: `${API}/repos/{owner}/{repo}`,
      repository_search_url: `${API}/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${API}/user/repos{?type,page,per_page,sort}`,
      starred_url: `${API}/user/starred{/owner}{/repo}`,
      starred_gists_url: `${API}/gists/starred{/gist_id}`,
      team_url: `${API}/teams`,
      user_url: `${API}/users/{user}`,
      user_organizations_url: `${API}/user/orgs`,
      user_repositories_url: `${API}/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${API}/search/users?q={query}{&page,per_page,sort,order}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (at(0) === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '3.0.0', verifiable_password_authentication: false, ssh_key_fingerprints: {}, hooks: [], web: [], api: [], git: [], packages: [], pages: [], importer: [] });
    return true;
  }

  if (at(0) === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: { core: { limit: 5000, used: 0, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 } }, rate: { limit: 5000, used: 0, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 } });
    return true;
  }

  if (at(0) === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { ...userJson(user), public_repos: store.repositoriesOf(user.login).length, total_private_repos: 0, owned_private_repos: 0, followers: 0, following: 0, plan: { name: 'free', space: 976562499, collaborators: 0, private_repos: 10000 } });
    return true;
  }

  if (at(0) === 'users' && segments.length === 2 && method === 'GET') {
    const found = store.users.get(at(1));
    if (found === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { ...userJson(found), public_repos: store.repositoriesOf(found.login).length, followers: 0, following: 0 });
    return true;
  }

  if (at(0) === 'users' && segments.length === 3 && at(2) === 'repos' && method === 'GET') {
    const found = store.users.get(at(1));
    if (found === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const repos = store.repositoriesOf(found.login).filter((repo) => !repo.private);
    sendJson(res, 200, repos.map((repo) => repoJson(ctx, repo)));
    return true;
  }

  if (at(0) === 'user' && at(1) === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = store.repositoriesOf(user.login);
      const { page, next } = paginate(repos, url);
      const prev = url.searchParams.get('page') !== null && Number(url.searchParams.get('page')) > 1
        ? (() => {
            const copy = new URL(url.toString());
            copy.searchParams.set('page', String(Math.max(1, Number(copy.searchParams.get('page')) - 1)));
            return copy.toString();
          })()
        : null;
      sendJson(res, 200, page.map((repo) => repoJson(ctx, repo)), paginationHeaders(next, prev));
      return true;
    }
    if (method === 'POST') {
      const body = parseBodyObject(await readJson(req));
      const name = str(body, 'name').trim();
      if (name === '') {
        sendError(res, 422, 'Repository creation failed.', [{ resource: 'Repository', code: 'missing_field', field: 'name', message: 'name is required' }]);
        return true;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(name)) {
        sendError(res, 422, 'Repository creation failed.', [{ resource: 'Repository', code: 'invalid', field: 'name', message: 'name is invalid' }]);
        return true;
      }
      if (store.findRepo(user.login, name) !== null) {
        sendError(res, 422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
        return true;
      }
      const repo = store.createRepo(user, name, {
        description: typeof body.description === 'string' ? body.description : null,
        private: bool(body, 'private', false),
        autoInit: bool(body, 'auto_init', false),
      });
      sendJson(res, 201, repoJson(ctx, repo), { location: absoluteUrl(req, `${API}/repos/${user.login}/${name}`) });
      return true;
    }
    return false;
  }

  if (at(0) === 'repos' && segments.length >= 3) {
    const repo = repoOf(ctx, at(1), at(2));
    if (repo === null) return true;
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(ctx, repo));
        return true;
      }
      if (method === 'PATCH') {
        const body = parseBodyObject(await readJson(req));
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          store.repos.delete(store.repoKey(repo.owner.login, repo.name));
          repo.name = body.name;
          store.repos.set(store.repoKey(repo.owner.login, repo.name), repo);
        }
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        if (typeof body.archived === 'boolean') repo.archived = body.archived;
        repo.updatedAt = nowIso();
        sendJson(res, 200, repoJson(ctx, repo));
        return true;
      }
      if (method === 'DELETE') {
        store.repos.delete(store.repoKey(repo.owner.login, repo.name));
        sendEmpty(res);
        return true;
      }
      return false;
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        sendJson(res, 200, store.branches(repo).map((branch) => ({
          name: branch.name,
          commit: { sha: branch.oid, url: absoluteUrl(req, `${API}/repos/${repo.owner.login}/${repo.name}/commits/${branch.oid}`) },
          protected: false,
        })));
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = refOf(repo, `refs/heads/${rest[1]}`);
        if (branch === null) {
          sendError(res, 404, 'Branch not found');
          return true;
        }
        sendJson(res, 200, { name: rest[1], commit: { sha: branch, url: absoluteUrl(req, `${API}/repos/${repo.owner.login}/${repo.name}/commits/${branch}`) }, protected: false });
        return true;
      }
    }

    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const sha = url.searchParams.get('sha') ?? repo.defaultBranch;
        const target = store.resolveRef(repo, sha);
        if (target === null) {
          sendError(res, 409, 'Git Repository is empty.');
          return true;
        }
        const all = store.commitsFrom(repo, target.commit);
        const { page, next } = paginate(all, url);
        sendJson(res, 200, page.map((oid) => commitJson(ctx, repo, oid)), paginationHeaders(next, null));
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const oid = rest[1] as string;
        const resolved = repo.objects.has(oid) ? peel(repo.objects, oid) : store.resolveRef(repo, oid)?.commit ?? null;
        if (resolved === null || ctx.store.commitOf(repo, resolved) === null) {
          sendError(res, 422, 'No commit found for SHA: ' + oid);
          return true;
        }
        sendJson(res, 200, commitJson(ctx, repo, resolved));
        return true;
      }
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'GET') {
        const ref = url.searchParams.get('ref');
        const target = store.resolveRef(repo, ref);
        if (target === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const commit = ctx.store.commitOf(repo, target.commit);
        if (commit === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (path === '') {
          sendJson(res, 200, contentsDirJson(ctx, repo, '', commit.tree));
          return true;
        }
        const entry = lookupPath(repo.objects, commit.tree, path);
        if (entry === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (entry.mode === '40000') sendJson(res, 200, contentsDirJson(ctx, repo, path, entry.oid));
        else sendJson(res, 200, contentsFileJson(ctx, repo, path, entry));
        return true;
      }
      if (method === 'PUT') {
        const body = parseBodyObject(await readJson(req));
        const message = str(body, 'message', '');
        const content = str(body, 'content', '');
        if (path === '') {
          sendError(res, 422, 'Invalid request.', [{ resource: 'Content', code: 'invalid', field: 'path' }]);
          return true;
        }
        if (message === '') {
          sendError(res, 422, 'Invalid request.', [{ resource: 'Content', code: 'missing_field', field: 'message' }]);
          return true;
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const existing = (() => {
          const target = store.resolveRef(repo, branch);
          if (target === null) return null;
          const commit = ctx.store.commitOf(repo, target.commit);
          if (commit === null) return null;
          return lookupPath(repo.objects, commit.tree, path);
        })();
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        if (existing !== null && sha === undefined) {
          sendError(res, 422, 'Invalid request.', [{ resource: 'Content', code: 'missing_field', field: 'sha', message: `"sha" wasn't supplied.` }]);
          return true;
        }
        if (existing !== null && sha !== undefined && sha !== existing.oid) {
          sendError(res, 409, 'sha does not match the current content');
          return true;
        }
        const written = store.writeContents(repo, { path, content: Buffer.from(content, 'base64'), message, branch, author: user });
        if (written === null) {
          sendError(res, 500, 'Could not write the file');
          return true;
        }
        const entry = { mode: '100644', oid: written.contentSha };
        sendJson(res, existing === null ? 201 : 200, {
          content: contentsFileJson(ctx, repo, path, entry),
          commit: commitJson(ctx, repo, written.commit),
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = parseBodyObject(await readJson(req));
        const message = str(body, 'message', '');
        const sha = str(body, 'sha', '');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const target = store.resolveRef(repo, branch);
        if (target === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const commit = ctx.store.commitOf(repo, target.commit);
        const entry = commit === null ? null : lookupPath(repo.objects, commit.tree, path);
        if (entry === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (sha !== '' && sha !== entry.oid) {
          sendError(res, 409, 'sha does not match the current content');
          return true;
        }
        const written = store.deleteContents(repo, { path, message: message === '' ? `Delete ${path}` : message, branch, author: user });
        if (written === null) {
          sendError(res, 422, 'Invalid request.');
          return true;
        }
        sendJson(res, 200, { content: null, commit: commitJson(ctx, repo, written.commit) });
        return true;
      }
    }

    if (rest[0] === 'git') {
      if (rest[1] === 'refs' && rest.length === 2) {
        if (method === 'GET') {
          const prefix = url.pathname.split('/git/refs')[1]?.replace(/^\//u, '') ?? '';
          const wanted = prefix === '' ? 'refs/' : `refs/${prefix}`;
          const list = [...repo.refs].filter(([name]) => name.startsWith(wanted)).map(([name, oid]) => refJson(ctx, repo, name, oid));
          sendJson(res, 200, prefix === '' ? list : list.length === 1 ? (list[0] as Record<string, unknown>) : list);
          return true;
        }
        if (method === 'POST') {
          const body = parseBodyObject(await readJson(req));
          const ref = str(body, 'ref', '');
          const sha = str(body, 'sha', '');
          if (!ref.startsWith('refs/') || sha === '' || !repo.objects.has(sha)) {
            sendError(res, 422, 'Reference update failed', [{ resource: 'GitRef', code: 'custom', message: 'ref and sha are required, and the sha must exist' }]);
            return true;
          }
          if (repo.refs.has(ref)) {
            sendError(res, 422, 'Reference already exists');
            return true;
          }
          repo.refs.set(ref, sha);
          sendJson(res, 201, refJson(ctx, repo, ref, sha));
          return true;
        }
      }
      if (rest[1] === 'refs' && rest.length > 2) {
        const ref = `refs/${rest.slice(2).map((segment) => decodeURIComponent(segment)).join('/')}`;
        if (method === 'GET') {
          const oid = repo.refs.get(ref);
          if (oid === undefined) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, refJson(ctx, repo, ref, oid));
          return true;
        }
        if (method === 'PATCH') {
          const body = parseBodyObject(await readJson(req));
          const sha = str(body, 'sha', '');
          if (sha === '' || !repo.objects.has(sha)) {
            sendError(res, 422, 'Reference update failed');
            return true;
          }
          repo.refs.set(ref, sha);
          sendJson(res, 200, refJson(ctx, repo, ref, sha));
          return true;
        }
        if (method === 'DELETE') {
          repo.refs.delete(ref);
          sendEmpty(res);
          return true;
        }
      }
      if (rest[1] === 'commits' && rest.length === 3 && method === 'GET') {
        const oid = rest[2] as string;
        if (ctx.store.commitOf(repo, oid) === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, commitJson(ctx, repo, oid));
        return true;
      }
      if (rest[1] === 'trees' && rest.length === 3 && method === 'GET') {
        const oid = rest[2] as string;
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'tree') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { sha: oid, url: absoluteUrl(req, `${API}/repos/${repo.owner.login}/${repo.name}/git/trees/${oid}`), tree: parseTree(object.data).map((entry) => ({ path: entry.name, mode: entry.mode, type: entry.mode === '40000' ? 'tree' : 'blob', sha: entry.oid, url: absoluteUrl(req, `${API}/repos/${repo.owner.login}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`) })), truncated: false });
        return true;
      }
      if (rest[1] === 'blobs' && rest.length === 3 && method === 'GET') {
        const oid = rest[2] as string;
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'blob') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { sha: oid, size: object.data.length, encoding: 'base64', content: object.data.toString('base64'), url: absoluteUrl(req, `${API}/repos/${repo.owner.login}/${repo.name}/git/blobs/${oid}`) });
        return true;
      }
    }

    if (rest[0] === 'issues' && rest.length >= 1) {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const direction = url.searchParams.get('direction') ?? 'desc';
          let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          const order = (issue: Issue): number => (sort === 'updated' ? Date.parse(issue.updatedAt) : issue.number);
          issues = [...issues].sort((left, right) => (direction === 'asc' ? order(left) - order(right) : order(right) - order(left)));
          const { page, next } = paginate(issues, url);
          sendJson(res, 200, page.map((issue) => issueJson(ctx, repo, issue)), paginationHeaders(next, null));
          return true;
        }
        if (method === 'POST') {
          const body = parseBodyObject(await readJson(req));
          const title = str(body, 'title', '').trim();
          if (title === '') {
            sendError(res, 422, 'Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title', message: 'title is required' }]);
            return true;
          }
          const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
          const created = store.createIssue(repo, { title, body: str(body, 'body', ''), labels, user });
          if ('error' in created) {
            sendError(res, 422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels', message: created.error }]);
            return true;
          }
          sendJson(res, 201, issueJson(ctx, repo, created));
          return true;
        }
      }
      const number = Number.parseInt(rest[1] ?? '', 10);
      if (Number.isFinite(number)) {
        const issue = store.findIssue(repo, number);
        if (issue === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (rest.length === 2) {
          if (method === 'GET') {
            const stamp = `${issue.updatedAt}|${issue.comments.length}|${issue.labels.length}|${issue.state}|${(req.headers.host ?? '').toString()}`;
            const cached = issueJsonCache.get(issue.id);
            if (cached !== undefined && cached.stamp === stamp) {
              sendJsonText(res, 200, cached.text);
              return true;
            }
            const text = `${JSON.stringify(issueJson(ctx, repo, issue))}\n`;
            if (issueJsonCache.size > 4_000) issueJsonCache.clear();
            issueJsonCache.set(issue.id, { stamp, text });
            sendJsonText(res, 200, text);
            return true;
          }
          if (method === 'PATCH') {
            const body = parseBodyObject(await readJson(req));
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            if (body.state === 'open' || body.state === 'closed') {
              issue.state = body.state;
              issue.closedAt = body.state === 'closed' ? nowIso() : null;
            }
            if (Array.isArray(body.labels)) {
              const asked = body.labels.filter((label): label is string => typeof label === 'string');
              const missing = asked.filter((name) => !repo.labels.some((label) => label.name === name));
              if (missing.length > 0) {
                sendError(res, 422, 'Validation Failed', missing.map((name) => ({ resource: 'Issue', code: 'invalid', field: 'labels', message: `Label does not exist: ${name}` })));
                return true;
              }
              issue.labels = repo.labels.filter((label) => asked.includes(label.name));
            }
            issue.updatedAt = nowIso();
            sendJson(res, 200, issueJson(ctx, repo, issue));
            return true;
          }
        }
        if (rest[2] === 'comments') {
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((comment) => commentJson(ctx, repo, issue, comment)));
            return true;
          }
          if (method === 'POST') {
            const body = parseBodyObject(await readJson(req));
            const text = str(body, 'body', '');
            if (text === '') {
              sendError(res, 422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body', message: 'body is required' }]);
              return true;
            }
            const comment = store.addComment(repo, issue, text, user);
            sendJson(res, 201, commentJson(ctx, repo, issue, comment));
            return true;
          }
        }
        if (rest[2] === 'labels') {
          if (method === 'GET') {
            sendJson(res, 200, issue.labels.map(labelJson));
            return true;
          }
          if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
            const body = await readJson(req);
            const asked = Array.isArray(body) ? body.filter((name): name is string => typeof name === 'string') : [];
            if (method === 'DELETE') {
              issue.labels = issue.labels.filter((label) => !asked.includes(label.name));
            } else {
              const missing = asked.filter((name) => !repo.labels.some((label) => label.name === name));
              if (missing.length > 0) {
                sendError(res, 422, 'Validation Failed', missing.map((name) => ({ resource: 'Label', code: 'missing', message: `Label does not exist: ${name}` })));
                return true;
              }
              issue.labels = repo.labels.filter((label) => asked.includes(label.name));
            }
            issue.updatedAt = nowIso();
            sendJson(res, 200, issue.labels.map(labelJson));
            return true;
          }
        }
      }
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'GET') {
          sendJson(res, 200, repo.labels.map(labelJson));
          return true;
        }
        if (method === 'POST') {
          const body = parseBodyObject(await readJson(req));
          const name = str(body, 'name', '').trim();
          if (name === '') {
            sendError(res, 422, 'Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
            return true;
          }
          const label = store.createLabel(repo, name, str(body, 'color', 'ededed').replace(/^#/u, ''), typeof body.description === 'string' ? body.description : null);
          if (label === null) {
            sendError(res, 422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
            return true;
          }
          sendJson(res, 201, labelJson(label));
          return true;
        }
      }
      const name = decodeURIComponent(rest.slice(1).join('/'));
      const label = repo.labels.find((candidate) => candidate.name === name);
      if (label === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, labelJson(label));
        return true;
      }
      if (method === 'PATCH') {
        const body = parseBodyObject(await readJson(req));
        if (typeof body.new_name === 'string') label.name = body.new_name;
        if (typeof body.color === 'string') label.color = body.color;
        if (typeof body.description === 'string') label.description = body.description;
        sendJson(res, 200, labelJson(label));
        return true;
      }
      if (method === 'DELETE') {
        repo.labels = repo.labels.filter((candidate) => candidate.name !== name);
        sendEmpty(res);
        return true;
      }
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const head = url.searchParams.get('head');
          const base = url.searchParams.get('base');
          let pulls = repo.pulls.filter((pull) => {
            if (state !== 'all' && pull.state !== state) return false;
            if (head !== null && head !== '' && !head.endsWith(pull.head)) return false;
            if (base !== null && base !== '' && pull.base !== base) return false;
            return true;
          });
          const direction = url.searchParams.get('direction') ?? 'desc';
          pulls = [...pulls].sort((left, right) => (direction === 'asc' ? left.number - right.number : right.number - left.number));
          const { page, next } = paginate(pulls, url);
          sendJson(res, 200, page.map((pull) => pullJson(ctx, repo, pull)), paginationHeaders(next, null));
          return true;
        }
        if (method === 'POST') {
          const body = parseBodyObject(await readJson(req));
          const title = str(body, 'title', '').trim();
          const head = str(body, 'head', '').trim();
          const base = str(body, 'base', '').trim();
          if (title === '' || head === '' || base === '') {
            sendError(res, 422, 'Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', message: 'title, head and base are required' }]);
            return true;
          }
          const created = store.createPull(repo, { title, body: str(body, 'body', ''), head: head.includes(':') ? (head.split(':').pop() as string) : head, base, user });
          if ('error' in created) {
            sendError(res, created.status, created.error);
            return true;
          }
          sendJson(res, 201, pullJson(ctx, repo, created));
          return true;
        }
      }
      const number = Number.parseInt(rest[1] ?? '', 10);
      if (Number.isFinite(number)) {
        const pull = store.findPull(repo, number);
        if (pull === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (rest.length === 2) {
          if (method === 'GET') {
            sendJson(res, 200, pullJson(ctx, repo, pull));
            return true;
          }
          if (method === 'PATCH') {
            const body = parseBodyObject(await readJson(req));
            if (typeof body.title === 'string') pull.title = body.title;
            if (typeof body.body === 'string') pull.body = body.body;
            if (body.state === 'open' || body.state === 'closed') {
              pull.state = body.state;
              pull.closedAt = body.state === 'closed' ? nowIso() : null;
            }
            pull.updatedAt = nowIso();
            sendJson(res, 200, pullJson(ctx, repo, pull));
            return true;
          }
        }
        if (rest[2] === 'files' && method === 'GET') {
          const files = store.pullFiles(repo, pull);
          const { page, next } = paginate(files, url);
          sendJson(res, 200, page, paginationHeaders(next, null));
          return true;
        }
        if (rest[2] === 'commits' && method === 'GET') {
          sendJson(res, 200, store.pullCommits(repo, pull).map((oid) => commitJson(ctx, repo, oid)));
          return true;
        }
        if (rest[2] === 'merge') {
          if (method === 'GET') {
            sendJson(res, 200, { sha: pull.mergeCommitSha, merged: pull.merged, message: pull.merged ? `Pull request #${pull.number} merged` : 'Pull request is not merged' });
            return true;
          }
          if (method === 'PUT' || method === 'POST') {
            const body = parseBodyObject(await readJson(req));
            const methodName = str(body, 'merge_method', str(body, 'mergeMethod', 'merge')).toLowerCase();
            const chosen = methodName === 'squash' || methodName === 'rebase' ? methodName : 'merge';
            const merged = store.mergePull(repo, pull, chosen, user);
            if ('error' in merged) {
              sendError(res, merged.status, merged.error);
              return true;
            }
            sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull request #${pull.number} merged` });
            return true;
          }
        }
        if (rest[2] === 'requested_reviewers' && method === 'GET') {
          sendJson(res, 200, { users: [], teams: [] });
          return true;
        }
      }
    }

    if (rest[0] === 'collaborators' && method === 'PUT') {
      sendEmpty(res);
      return true;
    }

    if (rest[0] === 'readme' && method === 'GET') {
      const target = store.resolveRef(repo, url.searchParams.get('ref'));
      const commit = target === null ? null : ctx.store.commitOf(repo, target.commit);
      const entry = commit === null ? null : lookupPath(repo.objects, commit.tree, 'README.md');
      if (entry === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, contentsFileJson(ctx, repo, 'README.md', entry));
      return true;
    }

    if (rest[0] === 'tarball' || rest[0] === 'zipball') {
      sendError(res, 404, 'Not Found');
      return true;
    }
  }

  if (at(0) === 'repositories' && segments.length === 2 && method === 'GET') {
    const id = Number.parseInt(at(1), 10);
    const repo = Number.isFinite(id) ? store.findRepoById(id) : null;
    if (repo === null || repo.owner.login !== user.login) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, repoJson(ctx, repo));
    return true;
  }

  if (at(0) === 'search' && at(1) === 'repositories' && method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const repos = store.repositoriesOf(user.login).filter((repo) => query === '' || repo.name.toLowerCase().includes(query) || (repo.description ?? '').toLowerCase().includes(query));
    sendJson(res, 200, { total_count: repos.length, incomplete_results: false, items: repos.map((repo) => repoJson(ctx, repo)) });
    return true;
  }

  if (at(0) === 'search' && at(1) === 'issues' && method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const items: Array<Record<string, unknown>> = [];
    for (const repo of store.repositoriesOf(user.login)) {
      for (const issue of repo.issues) {
        if (query === '' || issue.title.toLowerCase().includes(query) || issue.body.toLowerCase().includes(query)) items.push(issueJson(ctx, repo, issue));
      }
    }
    sendJson(res, 200, { total_count: items.length, incomplete_results: false, items });
    return true;
  }

  if (at(0) === 'graphql') return false;
  return false;
}

/** The node a REST global id names, for GraphQL's `node(id:)` and the MCP tools. */
export function nodeOf(store: Store, id: string): { kind: string; repo?: Repo; issue?: Issue; pull?: PullRequest } | null {
  const parsed = parseNodeId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = store.findRepoById(parsed.id);
    return repo === null ? null : { kind: 'Repository', repo };
  }
  for (const repo of store.repos.values()) {
    if (parsed.type === 'Issue') {
      const issue = repo.issues.find((candidate) => candidate.id === parsed.id);
      if (issue !== undefined) return { kind: 'Issue', repo, issue };
    }
    if (parsed.type === 'PullRequest') {
      const pull = repo.pulls.find((candidate) => candidate.id === parsed.id);
      if (pull !== undefined) return { kind: 'PullRequest', repo, pull };
    }
  }
  return null;
}

export { BadRequest, num, flattenTree, parseCommit, parseTag };
