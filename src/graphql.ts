// GraphQL v4: a small parser and executor for the documents gh and github-mcp-server send —
// queries (viewer, repository fields, issues, pull requests, node, introspection) and the
// create/close/merge/comment mutations, plus operation batching and field-level errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Issue, type PullRequest, type Repo, type Store, type User, nodeId, nowIso, parseNodeId, refOf } from './store.ts';
import { readBody, sendError, sendJson } from './http.ts';

// ------------------------------------------------------------------ the document model

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; value: Value[] }
  | { kind: 'object'; value: Map<string, Value> }
  | { kind: 'variable'; name: string };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selections: SelectionNode[];
}

type SelectionNode = { kind: 'field'; field: FieldNode } | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, string>;
  selections: SelectionNode[];
}

class SyntaxError extends Error {}

/** Tokenize and parse one document. */
function parseDocument(text: string): OperationNode {
  let index = 0;
  const skip = (): void => {
    for (;;) {
      const char = text[index];
      if (char === undefined) return;
      if (/\s|,/u.test(char)) {
        index += 1;
        continue;
      }
      if (char === '#') {
        while (index < text.length && text[index] !== '\n') index += 1;
        continue;
      }
      return;
    }
  };
  const peekName = (): string | null => {
    skip();
    const match = /^[_A-Za-z][_0-9A-Za-z]*/u.exec(text.slice(index));
    return match === null ? null : match[0];
  };
  const readName = (): string => {
    const name = peekName();
    if (name === null) throw new SyntaxError(`a name was expected at ${index}`);
    index += name.length;
    return name;
  };
  const expect = (char: string): void => {
    skip();
    if (text[index] !== char) throw new SyntaxError(`"${char}" was expected at ${index}`);
    index += 1;
  };

  const parseValue = (): Value => {
    skip();
    const char = text[index];
    if (char === '$') {
      index += 1;
      return { kind: 'variable', name: readName() };
    }
    if (char === '"') {
      index += 1;
      let out = '';
      while (index < text.length) {
        const next = text[index] as string;
        index += 1;
        if (next === '"') break;
        if (next === '\\') {
          const escaped = text[index] as string;
          index += 1;
          out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          continue;
        }
        out += next;
      }
      return { kind: 'string', value: out };
    }
    if (char === '[') {
      index += 1;
      const values: Value[] = [];
      for (;;) {
        skip();
        if (text[index] === ']') {
          index += 1;
          break;
        }
        values.push(parseValue());
      }
      return { kind: 'list', value: values };
    }
    if (char === '{') {
      index += 1;
      const object = new Map<string, Value>();
      for (;;) {
        skip();
        if (text[index] === '}') {
          index += 1;
          break;
        }
        const key = readName();
        expect(':');
        object.set(key, parseValue());
      }
      return { kind: 'object', value: object };
    }
    const numberMatch = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/u.exec(text.slice(index));
    if (numberMatch !== null) {
      index += numberMatch[0].length;
      return { kind: 'number', value: Number(numberMatch[0]) };
    }
    const name = readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  };

  const parseSelectionSet = (): SelectionNode[] => {
    expect('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      skip();
      if (text[index] === '}') {
        index += 1;
        break;
      }
      if (text.slice(index, index + 3) === '...') {
        index += 3;
        skip();
        if (peekName() === 'on') {
          readName();
          const typeCondition = readName();
          selections.push({ kind: 'inline', typeCondition, selections: parseSelectionSet() });
        } else {
          // A named fragment or `... { }`: take the selection set and keep the fields.
          if (peekName() !== null && text[index] !== '{') readName();
          selections.push({ kind: 'inline', typeCondition: null, selections: parseSelectionSet() });
        }
        continue;
      }
      let alias: string | null = null;
      let name = readName();
      skip();
      if (text[index] === ':') {
        index += 1;
        alias = name;
        name = readName();
      }
      const args = new Map<string, Value>();
      skip();
      if (text[index] === '(') {
        index += 1;
        for (;;) {
          skip();
          if (text[index] === ')') {
            index += 1;
            break;
          }
          const argName = readName();
          expect(':');
          args.set(argName, parseValue());
        }
      }
      skip();
      const children = text[index] === '{' ? parseSelectionSet() : [];
      selections.push({ kind: 'field', field: { alias, name, args, selections: children } });
    }
    return selections;
  };

  skip();
  let kind: 'query' | 'mutation' = 'query';
  let name: string | null = null;
  const variables = new Map<string, string>();
  const keyword = peekName();
  if (keyword === 'query' || keyword === 'mutation') {
    readName();
    kind = keyword;
    skip();
    const operationName = peekName();
    if (operationName !== null && text[index] !== '(') name = readName();
    skip();
    if (text[index] === '(') {
      index += 1;
      for (;;) {
        skip();
        if (text[index] === ')') {
          index += 1;
          break;
        }
        expect('$');
        const variableName = readName();
        expect(':');
        skip();
        // The type is `Name`, `[Name]`, `Name!` or `[Name!]!`.
        const typeMatch = /^\[?[_A-Za-z][_0-9A-Za-z]*\]?!?/u.exec(text.slice(index));
        if (typeMatch === null) throw new SyntaxError(`a variable type was expected at ${index}`);
        variables.set(variableName, typeMatch[0]);
        index += typeMatch[0].length;
        skip();
        if (text[index] === '=') {
          index += 1;
          parseValue();
        }
      }
    }
  }
  const selections = parseSelectionSet();
  return { kind, name, variables, selections };
}

// ------------------------------------------------------------------ schema description

const SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; values?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', 'viewerLogin'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', 'bio', 'company', 'createdAt', 'repositories', 'repository', 'issues'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'issue', 'issues', 'pullRequest',
      'pullRequests', 'createdAt', 'updatedAt', 'pushedAt', 'url', 'sshUrl', 'diskUsage', 'stargazerCount', 'forkCount',
      'primaryLanguage', 'labels', 'refs', 'object',
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'stateReason', 'createdAt', 'updatedAt', 'closedAt', 'author', 'editor', 'labels', 'comments', 'repository', 'url', 'isPinned', 'locked'],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'mergeStateStatus', 'mergeCommit', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'isDraft', 'createdAt', 'updatedAt', 'closedAt', 'author', 'files', 'commits', 'repository', 'url', 'changedFiles'],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix', 'target', 'repository'] },
  Commit: { kind: 'OBJECT', fields: ['oid', 'message', 'messageHeadline', 'committedDate', 'author', 'tree', 'parents'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'subject', 'timelineEdge', 'clientMutationId'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'author', 'url'] },
  __Type: { kind: 'OBJECT', fields: ['kind', 'name', 'description', 'fields', 'enumValues', 'interfaces', 'possibleTypes'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason', 'type', 'args'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueStateReason: { kind: 'ENUM', values: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'] },
};

const FIELD_LISTS: Record<string, string[]> = {
  Issue: SCHEMA.Issue?.fields ?? [],
  PullRequest: SCHEMA.PullRequest?.fields ?? [],
  Repository: SCHEMA.Repository?.fields ?? [],
  SearchType: SCHEMA.SearchType?.values ?? [],
};

// ------------------------------------------------------------------ execution

interface FieldError {
  message: string;
  path: Array<string | number>;
  locations: Array<{ line: number; column: number }>;
  type: string;
}

class ExecutionContext {
  readonly store: Store;
  readonly viewer: User;
  readonly variables: Record<string, unknown>;
  readonly errors: FieldError[] = [];

  constructor(store: Store, viewer: User, variables: Record<string, unknown>) {
    this.store = store;
    this.viewer = viewer;
    this.variables = variables;
  }

  value(value: Value | undefined): unknown {
    if (value === undefined) return undefined;
    switch (value.kind) {
      case 'string':
      case 'number':
      case 'boolean':
        return value.value;
      case 'null':
        return null;
      case 'enum':
        return value.value;
      case 'list':
        return value.value.map((entry) => this.value(entry));
      case 'object': {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of value.value) out[key] = this.value(entry);
        return out;
      }
      case 'variable':
        return this.variables[value.name];
      default:
        return undefined;
    }
  }

  argsOf(field: FieldNode): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const [key, value] of field.args) args[key] = this.value(value);
    return args;
  }

  fail(message: string, path: Array<string | number>): void {
    this.errors.push({ message, path, locations: [{ line: 1, column: 1 }], type: 'field' });
  }
}

function needsType(value: unknown): string {
  return Array.isArray(value) ? 'List' : typeof value === 'object' && value !== null ? 'Object' : 'Scalar';
}

/** Complete a selection set over a resolved value. */
function complete(ctx: ExecutionContext, selections: SelectionNode[], value: unknown, typeName: string, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry, index) => complete(ctx, selections, entry, typeName, [...path, index]));
  if (typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const nested = complete(ctx, selection.selections, value, typeName, path);
      if (typeof nested === 'object' && nested !== null) Object.assign(out, nested as Record<string, unknown>);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const resolved = resolveField(ctx, field, record, typeName, [...path, key]);
    if (resolved === undefined) {
      ctx.fail(`Field '${field.name}' doesn't exist on type '${typeName}'`, [...path, key]);
      out[key] = null;
      continue;
    }
    const [childValue, childType] = resolved;
    out[key] = field.selections.length > 0 ? complete(ctx, field.selections, childValue, childType, [...path, key]) : childValue;
  }
  return out;
}

/** Resolve one field on a record: `[value, typeName]`, or undefined when the field does not exist. */
function resolveField(ctx: ExecutionContext, field: FieldNode, record: Record<string, unknown>, typeName: string, path: Array<string | number>): [unknown, string] | undefined {
  const args = ctx.argsOf(field);
  const name = field.name;
  switch (typeName) {
    case 'Query':
      return resolveQuery(ctx, name, args);
    case 'Mutation':
      return resolveMutation(ctx, name, args);
    case '__Type':
      return resolveTypeMeta(ctx, name, record, args);
    case '__Field':
      if (name === 'name') return [record.name, 'String'];
      if (name === 'description') return [null, 'String'];
      if (name === 'isDeprecated') return [false, 'Boolean'];
      if (name === 'deprecationReason') return [null, 'String'];
      if (name === 'type') return [{ name: 'String' }, '__Type'];
      if (name === 'args') return [[], '__InputValue'];
      return undefined;
    case '__EnumValue':
      if (name === 'name') return [record.name, 'String'];
      if (name === 'description') return [null, 'String'];
      if (name === 'isDeprecated') return [false, 'Boolean'];
      if (name === 'deprecationReason') return [null, 'String'];
      return undefined;
    case 'Repository':
      return resolveRepository(ctx, name, record, args);
    case 'Issue':
      return resolveIssue(ctx, name, record);
    case 'PullRequest':
      return resolvePull(ctx, name, record, args);
    case 'IssueConnection':
      if (name === 'nodes') return [(record.nodes as unknown[]) ?? [], 'Issue'];
      if (name === 'edges') return [((record.nodes as unknown[]) ?? []).map((node, index) => ({ node, cursor: String(index) })), 'IssueEdge'];
      if (name === 'pageInfo') return [record.pageInfo, 'PageInfo'];
      if (name === 'totalCount') return [(record.nodes as unknown[]).length, 'Int'];
      return undefined;
    case 'IssueEdge':
      if (name === 'node') return [record.node, 'Issue'];
      if (name === 'cursor') return [record.cursor, 'String'];
      return undefined;
    case 'PullRequestConnection':
      if (name === 'nodes') return [(record.nodes as unknown[]) ?? [], 'PullRequest'];
      if (name === 'edges') return [((record.nodes as unknown[]) ?? []).map((node, index) => ({ node, cursor: String(index) })), 'IssueEdge'];
      if (name === 'pageInfo') return [record.pageInfo ?? { hasNextPage: false, endCursor: null }, 'PageInfo'];
      if (name === 'totalCount') return [(record.nodes as unknown[]).length, 'Int'];
      return undefined;
    case 'PullRequestChangedFileConnection':
      if (name === 'nodes') return [(record.nodes as unknown[]) ?? [], 'PullRequestChangedFile'];
      if (name === 'totalCount') return [(record.nodes as unknown[]).length, 'Int'];
      if (name === 'edges') return [((record.nodes as unknown[]) ?? []).map((node, index) => ({ node, cursor: String(index) })), 'IssueEdge'];
      return undefined;
    case 'PullRequestChangedFile':
      if (name === 'path' || name === 'filename') return [record.path, 'String'];
      if (name === 'additions' || name === 'deletions') return [record[name], 'Int'];
      if (name === 'changeType') return [record.status === 'added' ? 'ADDED' : record.status === 'removed' ? 'DELETED' : 'MODIFIED', 'String'];
      if (name === 'viewerViewedState') return ['UNVIEWED', 'String'];
      return undefined;
    case 'PageInfo':
      if (name === 'hasNextPage' || name === 'hasPreviousPage') return [record[name] ?? false, 'Boolean'];
      if (name === 'startCursor' || name === 'endCursor') return [record[name] ?? null, 'String'];
      return undefined;
    case 'User':
      if (name === 'id') return [record.id, 'ID'];
      if (name === 'login') return [record.login, 'String'];
      if (name === 'name') return [record.name, 'String'];
      if (name === 'email') return [record.email, 'String'];
      if (name === 'databaseId') return [record.id, 'Int'];
      if (name === 'url') return [`https://github.com/${record.login}`, 'String'];
      if (name === 'avatarUrl') return [null, 'String'];
      if (name === 'repositories') {
        const repos = ctx.store.repositoriesOf(String(record.login)).map((repo) => repoRecord(ctx, repo));
        return [{ nodes: repos, pageInfo: { hasNextPage: false, endCursor: null } }, 'RepositoryConnection'];
      }
      return undefined;
    case 'Ref':
      if (name === 'name') return [record.name, 'String'];
      if (name === 'prefix') return [record.prefix ?? 'refs/heads/', 'String'];
      if (name === 'target') return [record.target ?? null, 'Commit'];
      return undefined;
    case 'Label':
      if (name === 'id') return [record.id, 'ID'];
      if (name === 'name') return [record.name, 'String'];
      if (name === 'color') return [record.color, 'String'];
      if (name === 'description') return [record.description ?? null, 'String'];
      return undefined;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (name === 'issue') return [record.issue, 'Issue'];
      if (name === 'clientMutationId') return [null, 'String'];
      return undefined;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (name === 'pullRequest') return [record.pullRequest, 'PullRequest'];
      if (name === 'clientMutationId') return [null, 'String'];
      return undefined;
    case 'AddCommentPayload':
      if (name === 'commentEdge') return [record.commentEdge, 'IssueCommentEdge'];
      if (name === 'clientMutationId') return [null, 'String'];
      return undefined;
    case 'IssueCommentEdge':
      if (name === 'node') return [record.node, 'IssueComment'];
      if (name === 'cursor') return [null, 'String'];
      return undefined;
    case 'IssueComment':
      if (name === 'id') return [record.id, 'ID'];
      if (name === 'body') return [record.body, 'String'];
      return undefined;
    default:
      return undefined;
  }
}

function repoRecord(ctx: ExecutionContext, repo: Repo): Record<string, unknown> {
  return { __repo: repo, __store: ctx.store };
}

function issueRecord(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __repo: repo, __issue: issue };
}

function pullRecord(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return { __repo: repo, __pull: pull };
}

function resolveQuery(ctx: ExecutionContext, name: string, args: Record<string, unknown>): [unknown, string] | undefined {
  if (name === 'viewer') return [ctx.viewer as unknown as Record<string, unknown>, 'User'];
  if (name === 'repository') {
    const repo = ctx.store.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
    if (repo === null || repo.owner.login !== ctx.viewer.login) return [null, 'Repository'];
    return [repoRecord(ctx, repo), 'Repository'];
  }
  if (name === 'node') {
    const id = String(args.id ?? '');
    const parsed = parseNodeId(id);
    if (parsed === null) return [null, 'Node'];
    if (parsed.type === 'Repository') {
      const repo = ctx.store.findRepoById(parsed.id);
      return [repo === null ? null : repoRecord(ctx, repo), 'Repository'];
    }
    for (const repo of ctx.store.repos.values()) {
      if (parsed.type === 'Issue') {
        const issue = repo.issues.find((candidate) => candidate.id === parsed.id);
        if (issue !== undefined) return [issueRecord(repo, issue), 'Issue'];
      }
      if (parsed.type === 'PullRequest') {
        const pull = repo.pulls.find((candidate) => candidate.id === parsed.id);
        if (pull !== undefined) return [pullRecord(repo, pull), 'PullRequest'];
      }
    }
    return [null, 'Node'];
  }
  if (name === '__type') {
    const wanted = String(args.name ?? '');
    const found = SCHEMA[wanted];
    if (found === undefined) return [null, '__Type'];
    return [{ __typeName: wanted, __kind: found.kind, __values: found.values ?? [], __fields: found.fields ?? [] }, '__Type'];
  }
  if (name === 'viewerLogin') return [ctx.viewer.login, 'String'];
  return undefined;
}

function resolveTypeMeta(ctx: ExecutionContext, name: string, record: Record<string, unknown>, args: Record<string, unknown>): [unknown, string] | undefined {
  if (name === 'name') return [record.__typeName, 'String'];
  if (name === 'kind') return [record.__kind, '__TypeKind'];
  if (name === 'description') return [null, 'String'];
  if (name === 'fields') {
    const fields = (record.__fields as string[]).map((field) => ({ name: field }));
    return [args.includeDeprecated === false ? fields : fields, '__Field'];
  }
  if (name === 'enumValues') return [(record.__values as string[]).map((value) => ({ name: value })), '__EnumValue'];
  if (name === 'interfaces' || name === 'possibleTypes') return [[], '__Type'];
  return undefined;
}

function resolveRepository(ctx: ExecutionContext, name: string, record: Record<string, unknown>, args: Record<string, unknown>): [unknown, string] | undefined {
  const repo = record.__repo as Repo;
  switch (name) {
    case 'id':
      return [nodeId('Repository', repo.id), 'ID'];
    case 'databaseId':
      return [repo.id, 'Int'];
    case 'name':
      return [repo.name, 'String'];
    case 'nameWithOwner':
      return [`${repo.owner.login}/${repo.name}`, 'String'];
    case 'owner':
      return [repo.owner as unknown as Record<string, unknown>, 'User'];
    case 'description':
      return [repo.description, 'String'];
    case 'isPrivate':
      return [repo.private, 'Boolean'];
    case 'isFork':
      return [repo.fork, 'Boolean'];
    case 'defaultBranchRef': {
      const head = ctx.store.headOid(repo);
      if (head === null) return [null, 'Ref'];
      return [{ name: repo.defaultBranch, prefix: 'refs/heads/', target: { oid: head } }, 'Ref'];
    }
    case 'viewerPermission':
      return ['ADMIN', 'RepositoryPermission'];
    case 'hasIssuesEnabled':
    case 'hasProjectsEnabled':
    case 'hasWikiEnabled':
      return [name === 'hasIssuesEnabled', 'Boolean'];
    case 'issue': {
      const issue = ctx.store.findIssue(repo, Number(args.number ?? 0));
      return [issue === null ? null : issueRecord(repo, issue), 'Issue'];
    }
    case 'issues': {
      const states = Array.isArray(args.states) ? (args.states as string[]) : [];
      let issues = repo.issues.filter((issue) => states.length === 0 || states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      const orderBy = args.orderBy as Record<string, unknown> | undefined;
      const direction = String(orderBy?.direction ?? 'DESC');
      const fieldName = String(orderBy?.field ?? 'CREATED_AT');
      const sortKey = (issue: Issue): number => (fieldName === 'UPDATED_AT' ? Date.parse(issue.updatedAt) : fieldName === 'COMMENTS' ? issue.comments.length : issue.number);
      issues = [...issues].sort((left, right) => (direction === 'ASC' ? sortKey(left) - sortKey(right) : sortKey(right) - sortKey(left)));
      const first = args.first === undefined || args.first === null ? issues.length : Number(args.first);
      let offset = 0;
      if (typeof args.after === 'string' && args.after !== '') {
        const decoded = Buffer.from(args.after, 'base64').toString('utf8');
        const match = /^cursor:(\d+)$/u.exec(decoded);
        if (match !== null) offset = Number(match[1]);
      }
      const page = issues.slice(offset, offset + first);
      const end = offset + page.length;
      return [
        {
          nodes: page.map((issue) => issueRecord(repo, issue)),
          pageInfo: { hasNextPage: end < issues.length, endCursor: end < issues.length ? Buffer.from(`cursor:${end}`).toString('base64') : Buffer.from(`cursor:${end}`).toString('base64') },
        },
        'IssueConnection',
      ];
    }
    case 'pullRequests': {
      const first = args.first === undefined || args.first === null ? repo.pulls.length : Number(args.first);
      const pulls = [...repo.pulls].sort((left, right) => right.number - left.number).slice(0, Math.max(0, first));
      return [{ nodes: pulls.map((pull) => pullRecord(repo, pull)), pageInfo: { hasNextPage: false, endCursor: null } }, 'PullRequestConnection'];
    }
    case 'pullRequest': {
      const pull = ctx.store.findPull(repo, Number(args.number ?? 0));
      return [pull === null ? null : pullRecord(repo, pull), 'PullRequest'];
    }
    case 'createdAt':
    case 'updatedAt':
    case 'pushedAt':
      return [repo[name === 'createdAt' ? 'createdAt' : name === 'updatedAt' ? 'updatedAt' : 'pushedAt'], 'DateTime'];
    case 'url':
      return [`https://github.com/${repo.owner.login}/${repo.name}`, 'String'];
    case 'diskUsage':
    case 'stargazerCount':
    case 'forkCount':
      return [0, 'Int'];
    case 'primaryLanguage':
      return [null, 'Language'];
    case 'labels':
      return [{ nodes: repo.labels.map((label) => ({ id: nodeId('Label', label.id), name: label.name, color: label.color, description: label.description })), totalCount: repo.labels.length }, 'LabelConnection'];
    case 'sshUrl':
      return [`git@github.com:${repo.owner.login}/${repo.name}.git`, 'GitSSHRemote'];
    default:
      return undefined;
  }
}

function resolveIssue(ctx: ExecutionContext, name: string, record: Record<string, unknown>): [unknown, string] | undefined {
  const issue = record.__issue as Issue;
  const repo = record.__repo as Repo;
  switch (name) {
    case 'id':
      return [nodeId('Issue', issue.id), 'ID'];
    case 'databaseId':
      return [issue.id, 'Int'];
    case 'number':
      return [issue.number, 'Int'];
    case 'title':
      return [issue.title, 'String'];
    case 'body':
      return [issue.body, 'String'];
    case 'state':
      return [issue.state === 'open' ? 'OPEN' : 'CLOSED', 'IssueState'];
    case 'stateReason':
      return [issue.state === 'closed' ? 'COMPLETED' : null, 'IssueStateReason'];
    case 'createdAt':
      return [issue.createdAt, 'DateTime'];
    case 'updatedAt':
      return [issue.updatedAt, 'DateTime'];
    case 'closedAt':
      return [issue.closedAt, 'DateTime'];
    case 'author':
      return [issue.user as unknown as Record<string, unknown>, 'User'];
    case 'editor':
      return [null, 'User'];
    case 'labels':
      return [{ nodes: issue.labels.map((label) => ({ id: nodeId('Label', label.id), name: label.name, color: label.color, description: label.description })), totalCount: issue.labels.length }, 'LabelConnection'];
    case 'comments':
      return [{ nodes: issue.comments.map((comment) => ({ id: nodeId('IssueComment', comment.id), body: comment.body })), totalCount: issue.comments.length, pageInfo: { hasNextPage: false, endCursor: null } }, 'IssueCommentConnection'];
    case 'repository':
      return [repoRecord(ctx, repo), 'Repository'];
    case 'url':
      return [`https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}`, 'String'];
    case 'isPinned':
    case 'locked':
      return [false, 'Boolean'];
    default:
      return undefined;
  }
}

function resolvePull(ctx: ExecutionContext, name: string, record: Record<string, unknown>, args: Record<string, unknown>): [unknown, string] | undefined {
  const pull = record.__pull as PullRequest;
  const repo = record.__repo as Repo;
  switch (name) {
    case 'id':
      return [nodeId('PullRequest', pull.id), 'ID'];
    case 'databaseId':
      return [pull.id, 'Int'];
    case 'number':
      return [pull.number, 'Int'];
    case 'title':
      return [pull.title, 'String'];
    case 'body':
      return [pull.body, 'String'];
    case 'state':
      return [pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED', 'PullRequestState'];
    case 'merged':
      return [pull.merged, 'Boolean'];
    case 'mergedAt':
      return [pull.mergedAt, 'DateTime'];
    case 'mergeable': {
      const merged = ctx.store.pullMergeable(repo, pull);
      if (merged === null) return ['UNKNOWN', 'MergeableState'];
      if (pull.state !== 'open' || pull.merged) return ['UNKNOWN', 'MergeableState'];
      return [merged.mergeable ? 'MERGEABLE' : 'CONFLICTING', 'MergeableState'];
    }
    case 'mergeStateStatus':
      return ['CLEAN', 'String'];
    case 'mergeCommit':
      return [pull.mergeCommitSha === null ? null : { oid: pull.mergeCommitSha }, 'Commit'];
    case 'headRefName':
      return [pull.head, 'String'];
    case 'baseRefName':
      return [pull.base, 'String'];
    case 'headRefOid':
      return [refOf(repo, `refs/heads/${pull.head}`), 'GitObjectID'];
    case 'baseRefOid':
      return [refOf(repo, `refs/heads/${pull.base}`), 'GitObjectID'];
    case 'isDraft':
      return [false, 'Boolean'];
    case 'createdAt':
      return [pull.createdAt, 'DateTime'];
    case 'updatedAt':
      return [pull.updatedAt, 'DateTime'];
    case 'closedAt':
      return [pull.closedAt, 'DateTime'];
    case 'author':
      return [pull.user as unknown as Record<string, unknown>, 'User'];
    case 'files': {
      const files = ctx.store.pullFiles(repo, pull);
      const first = args.first === undefined || args.first === null ? files.length : Number(args.first);
      return [{ nodes: files.slice(0, Math.max(0, first)) }, 'PullRequestChangedFileConnection'];
    }
    case 'commits':
      return [{ nodes: [], totalCount: ctx.store.pullCommits(repo, pull).length }, 'PullRequestCommitConnection'];
    case 'changedFiles':
      return [ctx.store.pullFiles(repo, pull).length, 'Int'];
    case 'repository':
      return [repoRecord(ctx, repo), 'Repository'];
    case 'url':
      return [`https://github.com/${repo.owner.login}/${repo.name}/pull/${pull.number}`, 'String'];
    default:
      return undefined;
  }
}

function resolveMutation(ctx: ExecutionContext, name: string, args: Record<string, unknown>): [unknown, string] | undefined {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const store = ctx.store;
  if (name === 'createIssue') {
    const parsed = parseNodeId(String(input.repositoryId ?? ''));
    const repo = parsed === null ? null : store.findRepoById(parsed.id);
    if (repo === null) {
      ctx.fail('Could not resolve to a Repository with the global id', ['createIssue']);
      return [null, 'CreateIssuePayload'];
    }
    const created = store.createIssue(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', labels: [], user: ctx.viewer });
    if ('error' in created) {
      ctx.fail(created.error, ['createIssue']);
      return [null, 'CreateIssuePayload'];
    }
    return [{ issue: issueRecord(repo, created) }, 'CreateIssuePayload'];
  }
  if (name === 'closeIssue') {
    const parsed = parseNodeId(String(input.issueId ?? ''));
    for (const repo of store.repos.values()) {
      const issue = parsed === null ? undefined : repo.issues.find((candidate) => candidate.id === parsed.id);
      if (issue === undefined) continue;
      issue.state = 'closed';
      issue.closedAt = nowIso();
      issue.updatedAt = issue.closedAt;
      return [{ issue: issueRecord(repo, issue) }, 'CloseIssuePayload'];
    }
    ctx.fail('Could not resolve to an Issue with the global id', ['closeIssue']);
    return [null, 'CloseIssuePayload'];
  }
  if (name === 'createPullRequest') {
    const parsed = parseNodeId(String(input.repositoryId ?? ''));
    const repo = parsed === null ? null : store.findRepoById(parsed.id);
    if (repo === null) {
      ctx.fail('Could not resolve to a Repository with the global id', ['createPullRequest']);
      return [null, 'CreatePullRequestPayload'];
    }
    const created = store.createPull(repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
      user: ctx.viewer,
    });
    if ('error' in created) {
      ctx.fail(created.error, ['createPullRequest']);
      return [null, 'CreatePullRequestPayload'];
    }
    return [{ pullRequest: pullRecord(repo, created) }, 'CreatePullRequestPayload'];
  }
  if (name === 'mergePullRequest') {
    const parsed = parseNodeId(String(input.pullRequestId ?? ''));
    for (const repo of store.repos.values()) {
      const pull = parsed === null ? undefined : repo.pulls.find((candidate) => candidate.id === parsed.id);
      if (pull === undefined) continue;
      const methodName = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      const merged = store.mergePull(repo, pull, methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge', ctx.viewer);
      if ('error' in merged) {
        ctx.fail(merged.error, ['mergePullRequest']);
        return [{ pullRequest: pullRecord(repo, pull) }, 'MergePullRequestPayload'];
      }
      return [{ pullRequest: pullRecord(repo, pull) }, 'MergePullRequestPayload'];
    }
    ctx.fail('Could not resolve to a PullRequest with the global id', ['mergePullRequest']);
    return [null, 'MergePullRequestPayload'];
  }
  if (name === 'addComment') {
    const parsed = parseNodeId(String(input.subjectId ?? ''));
    for (const repo of store.repos.values()) {
      const issue = parsed === null ? undefined : repo.issues.find((candidate) => candidate.id === parsed.id);
      if (issue === undefined) continue;
      const comment = store.addComment(repo, issue, String(input.body ?? ''), ctx.viewer);
      return [{ commentEdge: { node: { id: nodeId('IssueComment', comment.id), body: comment.body } } }, 'AddCommentPayload'];
    }
    ctx.fail('Could not resolve to a node with the global id', ['addComment']);
    return [null, 'AddCommentPayload'];
  }
  return undefined;
}

/** Execute one document against the store. */
function execute(store: Store, viewer: User, document: OperationNode, variables: Record<string, unknown>): { data: unknown; errors: FieldError[] } {
  const ctx = new ExecutionContext(store, viewer, variables);
  const rootType = document.kind === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  for (const selection of document.selections) {
    if (selection.kind === 'inline') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    const resolved = resolveField(ctx, field, {}, rootType, [key]);
    if (resolved === undefined) {
      ctx.fail(`Field '${field.name}' doesn't exist on type '${rootType}'`, [key]);
      data[key] = null;
      continue;
    }
    const [value, typeName] = resolved;
    data[key] = field.selections.length > 0 ? complete(ctx, field.selections, value, typeName, [key]) : value;
  }
  return { data, errors: ctx.errors };
}

/** POST /api/graphql: one document, or a JSON array of them (operation batching). */
export async function handleGraphql(store: Store, viewer: User, req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const text = body.toString('utf8').trim();
  if (text === '') {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const answers: Array<{ data: unknown; errors?: FieldError[] }> = [];
  for (const operation of operations) {
    if (typeof operation !== 'object' || operation === null) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    const record = operation as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = typeof record.variables === 'object' && record.variables !== null ? (record.variables as Record<string, unknown>) : {};
    if (query.trim() === '') {
      answers.push({ data: null, errors: [{ message: 'no query was supplied', path: [], locations: [], type: 'request' }] });
      continue;
    }
    try {
      const document = parseDocument(query);
      const result = execute(store, viewer, document, variables);
      answers.push(result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      answers.push({ data: null, errors: [{ message: `syntax error: ${message}`, path: [], locations: [], type: 'parse' }] });
    }
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, answers);
    return;
  }
  sendJson(res, 200, answers[0]);
}

export { readBody };
