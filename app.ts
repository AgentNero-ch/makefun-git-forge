// The entry's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and the MCP endpoint, all routed
// here over one in-process store. main.ts owns the lifecycle; this file owns the routes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/githttp.ts';
import { handleRest } from './src/rest.ts';
import { BadRequest, readBody, sendError, sendJson } from './src/http.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { Store, type User } from './src/store.ts';

/** The REST root, without a trailing slash. */
const API_ROOT = '/api/v3';

/** The bearer token every API call must carry; the empty string turns the check off. */
const TOKEN = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

const store = new Store();
const viewer: User = store.users.get('adaiversen') as User;

/** The git path shape: `/{owner}/{repo}.git` plus an optional suffix. */
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/u;

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Whether the request carries the trial's token. */
function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = (req.headers.authorization ?? '').toString();
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match !== null && (match[1] as string).trim() === TOKEN;
}

/** Answer one git smart-HTTP request. */
async function routeGit(req: IncomingMessage, res: ServerResponse, url: URL, match: RegExpExecArray): Promise<void> {
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const suffix = match[3] ?? '';
  const repo = store.findRepo(owner, name);
  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (suffix === '/info/refs') {
    const service = url.searchParams.get('service') ?? 'git-upload-pack';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 403, 'Smart HTTP is not enabled');
      return;
    }
    handleInfoRefs(store, repo, service, req, res);
    return;
  }
  if (suffix === '/git-upload-pack' && req.method === 'POST') {
    const body = await readBody(req);
    handleUploadPack(store, repo, body, res);
    return;
  }
  if (suffix === '/git-receive-pack' && req.method === 'POST') {
    if (!authorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const body = await readBody(req);
    handleReceivePack(store, repo, body, res);
    return;
  }
  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', `http://${(req.headers.host ?? 'localhost').toString()}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const gitMatch = GIT_PATH.exec(path);
      if (gitMatch !== null) {
        await routeGit(req, res, url, gitMatch);
        return;
      }

      if (path === '/mcp' || path.startsWith('/mcp/')) {
        const body = await readBody(req);
        await handleMcp(store, viewer, req, res, body, authorized(req), url);
        return;
      }

      if (path === '/api/graphql' && method === 'POST') {
        if (!authorized(req)) {
          sendError(res, 401, 'Requires authentication');
          return;
        }
        const body = await readBody(req);
        await handleGraphql(store, viewer, req, res, body);
        return;
      }

      if (path.startsWith(`${API_ROOT}/`) || path === API_ROOT) {
        if (!authorized(req)) {
          sendError(res, 401, 'Requires authentication');
          return;
        }
        const segments = path
          .slice(API_ROOT.length)
          .split('/')
          .filter((part) => part !== '')
          .map((part) => decodeURIComponent(part));
        const handled = await handleRest({ store, user: viewer, req, res, url, segments });
        if (!handled) sendError(res, 404, 'Not Found');
        return;
      }

      sendError(res, 404, 'Not Found');
    })().catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof BadRequest) {
        sendError(res, 400, err.message);
        return;
      }
      sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
    });
  });
  // A bench client keeps one warm socket: never let a Nagle/delayed-ack pause sit in the round trip.
  server.on('connection', (socket) => socket.setNoDelay(true));
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 65_000;
  return server;
}
