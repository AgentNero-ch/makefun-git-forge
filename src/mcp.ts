// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP, the 2025-11-25 style handshake (initialize,
// notifications/initialized) with no session, and six github-mcp-server tools plus a few extras.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Repo, type Store, type User, nodeId } from './store.ts';
import { sendError } from './http.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const DEFAULT_REVISION = '2025-11-25';

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required: string[];
    additionalProperties?: boolean;
  };
}

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user and return the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The branch with the changes.' },
        base: { type: 'string', description: 'The branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
        merge_method: { type: 'string', description: 'merge, squash or rebase.', enum: ['merge', 'squash', 'rebase'] },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories of the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'search_issues',
    description: 'Search the issues of a repository by title.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        query: { type: 'string', description: 'Text the title must contain.' },
      },
      required: ['owner', 'repo', 'query'],
    },
  },
];

interface ToolOutcome {
  text: string;
  isError: boolean;
  structured?: unknown;
}

function argumentString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function argumentNumber(args: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value);
  }
  return null;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner.login}/${repo.name}`,
    owner: { login: repo.owner.login, id: repo.owner.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    clone_url: `/${repo.owner.login}/${repo.name}.git`,
  };
}

/** Run one tool call against the store. */
function callTool(store: Store, viewer: User, name: string, args: Record<string, unknown>): ToolOutcome | { rpcError: number; message: string } {
  const owner = argumentString(args, 'owner') ?? viewer.login;
  const repoName = argumentString(args, 'repo') ?? argumentString(args, 'repository') ?? argumentString(args, 'full_name')?.split('/').pop() ?? '';
  const repoOfArgs = (): Repo | null => {
    const repo = store.findRepo(owner, repoName);
    if (repo === null || repo.owner.login !== viewer.login) return null;
    return repo;
  };
  switch (name) {
    case 'create_repo': {
      const created = argumentString(args, 'name');
      if (created === null || created.trim() === '') return { rpcError: JSON_RPC_INVALID_PARAMS, message: 'create_repo needs a name' };
      if (store.findRepo(viewer.login, created) !== null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: `a repository named ${created} already exists` };
      const repo = store.createRepo(viewer, created, {
        description: argumentString(args, 'description') ?? null,
        private: args.private === true,
      });
      return { text: JSON.stringify(repoJson(repo)), isError: false, structured: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = repoOfArgs();
      if (repo === null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: `no repository ${owner}/${repoName}` };
      return { text: JSON.stringify(repoJson(repo)), isError: false, structured: repoJson(repo) };
    }
    case 'list_repos': {
      const repos = store.repositoriesOf(viewer.login).map(repoJson);
      return { text: JSON.stringify({ total_count: repos.length, repositories: repos }), isError: false, structured: { repositories: repos } };
    }
    case 'create_issue': {
      const repo = repoOfArgs();
      if (repo === null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: `no repository ${owner}/${repoName}` };
      const title = argumentString(args, 'title');
      if (title === null || title === '') return { rpcError: JSON_RPC_INVALID_PARAMS, message: 'create_issue needs a title' };
      const created = store.createIssue(repo, { title, body: argumentString(args, 'body') ?? '', labels: [], user: viewer });
      if ('error' in created) return { rpcError: JSON_RPC_INVALID_PARAMS, message: created.error };
      const payload = { id: created.id, node_id: nodeId('Issue', created.id), number: created.number, title: created.title, body: created.body, state: created.state, html_url: `https://github.com/${repo.owner.login}/${repo.name}/issues/${created.number}` };
      return { text: JSON.stringify(payload), isError: false, structured: payload };
    }
    case 'get_issue': {
      const repo = repoOfArgs();
      if (repo === null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: `no repository ${owner}/${repoName}` };
      const number = argumentNumber(args, ['issue_number', 'number']);
      const issue = number === null ? null : store.findIssue(repo, number);
      if (issue === null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: 'no such issue' };
      const payload = { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((label) => label.name) };
      return { text: JSON.stringify(payload), isError: false, structured: payload };
    }
    case 'list_issues': {
      const repo = repoOfArgs();
      if (repo === null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: `no repository ${owner}/${repoName}` };
      const state = argumentString(args, 'state') ?? 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((left, right) => right.number - left.number)
        .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, state: issue.state, body: issue.body, labels: issue.labels.map((label) => label.name) }));
      return { text: JSON.stringify({ total_count: issues.length, issues }), isError: false, structured: { issues } };
    }
    case 'search_issues': {
      const repo = repoOfArgs();
      if (repo === null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: `no repository ${owner}/${repoName}` };
      const query = (argumentString(args, 'query') ?? '').toLowerCase();
      const issues = repo.issues.filter((issue) => issue.title.toLowerCase().includes(query)).map((issue) => ({ number: issue.number, title: issue.title, state: issue.state }));
      return { text: JSON.stringify({ total_count: issues.length, issues }), isError: false, structured: { issues } };
    }
    case 'create_pull_request': {
      const repo = repoOfArgs();
      if (repo === null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: `no repository ${owner}/${repoName}` };
      const title = argumentString(args, 'title');
      const head = argumentString(args, 'head');
      const base = argumentString(args, 'base');
      if (title === null || head === null || base === null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: 'create_pull_request needs title, head and base' };
      const created = store.createPull(repo, { title, body: argumentString(args, 'body') ?? '', head, base, user: viewer });
      if ('error' in created) return { rpcError: JSON_RPC_INVALID_PARAMS, message: created.error };
      const payload = { id: created.id, number: created.number, title: created.title, state: created.state, head: created.head, base: created.base, html_url: `https://github.com/${repo.owner.login}/${repo.name}/pull/${created.number}` };
      return { text: JSON.stringify(payload), isError: false, structured: payload };
    }
    case 'merge_pull_request': {
      const repo = repoOfArgs();
      if (repo === null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: `no repository ${owner}/${repoName}` };
      const number = argumentNumber(args, ['pull_number', 'pull_request_number', 'number', 'pr_number']);
      const pull = number === null ? null : store.findPull(repo, number);
      if (pull === null) return { rpcError: JSON_RPC_INVALID_PARAMS, message: 'no such pull request' };
      const methodName = (argumentString(args, 'merge_method') ?? 'merge').toLowerCase();
      const merged = store.mergePull(repo, pull, methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge', viewer);
      if ('error' in merged) return { rpcError: JSON_RPC_INVALID_PARAMS, message: merged.error };
      const payload = { number: pull.number, merged: pull.merged, state: pull.state, sha: merged.sha };
      return { text: JSON.stringify(payload), isError: false, structured: payload };
    }
    default:
      return { rpcError: JSON_RPC_INVALID_PARAMS, message: `Unknown tool: ${name}` };
  }
}

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** Answer one JSON-RPC message; null for a notification (no answer). */
function handleMessage(store: Store, viewer: User, message: RpcRequest): Record<string, unknown> | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const hasId = id !== undefined && id !== null;
  const params = typeof message.params === 'object' && message.params !== null ? (message.params as Record<string, unknown>) : {};
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result });
  const error = (code: number, text: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: text } });
  if (!hasId && method.startsWith('notifications/')) return null;
  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_REVISION;
      const revision = /^\d{4}-\d{2}-\d{2}$/u.test(requested) ? requested : DEFAULT_REVISION;
      return reply({
        protocolVersion: revision,
        capabilities: { tools: { listChanged: false }, logging: {}, prompts: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions: 'A small GitHub-compatible forge: repositories, issues and pull requests.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      const known = TOOLS.find((tool) => tool.name === name);
      if (known === undefined) return error(JSON_RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      const missing = known.inputSchema.required.filter((property) => {
        const value = args[property];
        return value === undefined || value === null || (typeof value === 'string' && value === '');
      });
      if (missing.length > 0) {
        return reply({
          content: [{ type: 'text', text: `Invalid arguments for ${name}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required` }],
          isError: true,
        });
      }
      const outcome = callTool(store, viewer, name, args);
      if ('rpcError' in outcome) return error(outcome.rpcError, outcome.message);
      const result: Record<string, unknown> = { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError };
      if (outcome.structured !== undefined) result.structuredContent = outcome.structured;
      return reply(result);
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    case 'logging/setLevel':
      return reply({});
    case 'server/discover':
    case 'completion/complete':
      return error(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    default:
      if (!hasId) return null;
      return error(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** POST /mcp. */
export async function handleMcp(store: Store, viewer: User, req: IncomingMessage, res: ServerResponse, body: Buffer, authorized: boolean, _url: URL): Promise<void> {
  if (!authorized) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const text = body.toString('utf8').trim();
  const send = (status: number, payload: unknown): void => {
    const out = `${JSON.stringify(payload)}\n`;
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
    res.end(out);
  };
  if (text === '') {
    send(400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_INVALID_REQUEST, message: 'An empty body is not a JSON-RPC message' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    send(400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error: the body is not JSON' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) {
      const answer = handleMessage(store, viewer, entry as RpcRequest);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    send(200, answers);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    send(400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_INVALID_REQUEST, message: 'A JSON-RPC message must be an object' } });
    return;
  }
  const answer = handleMessage(store, viewer, parsed as RpcRequest);
  if (answer === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  send(200, answer);
}

export { TOOLS };
