// The HTTP plumbing every surface shares: JSON answers, request bodies, request ids and the
// GitHub-shaped error body.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** A monotonically increasing request id: cheaper than a uuid per reply and unique per process. */
let requestCounter = 0;

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    connection: 'keep-alive',
    'x-github-request-id': requestId(res),
    ...headers,
  });
  res.end(text);
}

/** Answer with JSON text that was serialized earlier. */
export function sendJsonText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    connection: 'keep-alive',
    'x-github-request-id': requestId(res),
  });
  res.end(text);
}

/** A non-empty request id per reply, stable for one response. */
export function requestId(res: ServerResponse): string {
  const existing = res.getHeader('x-github-request-id');
  if (typeof existing === 'string' && existing !== '') return existing;
  requestCounter += 1;
  const id = `CORE-${requestCounter.toString(16).toUpperCase()}`;
  res.setHeader('x-github-request-id', id);
  return id;
}

/** GitHub's error body: `{message, documentation_url, errors?}`. */
export function sendError(res: ServerResponse, status: number, message: string, errors?: unknown): void {
  const body: Record<string, unknown> = { message, documentation_url: 'https://docs.github.com/rest' };
  if (errors !== undefined) body.errors = errors;
  sendJson(res, status, body);
}

/** An empty answer (204). */
export function sendEmpty(res: ServerResponse): void {
  res.writeHead(204, { connection: 'keep-alive', 'x-github-request-id': requestId(res) });
  res.end();
}

export class BadRequest extends Error {}

/** Read a request body into a buffer. */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Read a JSON body; an empty body is `{}`, malformed JSON throws BadRequest. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BadRequest('A JSON object body is required');
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BadRequest) throw err;
    throw new BadRequest('Problems parsing JSON');
  }
}

/** A string field of a JSON body, or the fallback. */
export function str(body: Record<string, unknown>, key: string, fallback = ''): string {
  const value = body[key];
  return typeof value === 'string' ? value : fallback;
}

/** A boolean field of a JSON body, or the fallback. */
export function bool(body: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = body[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** A numeric field of a JSON body, or null. */
export function num(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return Number(value);
  return null;
}

/** The absolute URL of a route on this entry, from the request's own host. */
export function absoluteUrl(req: IncomingMessage, path: string): string {
  const host = (req.headers.host ?? 'localhost').toString();
  const proto = (req.headers['x-forwarded-proto'] ?? 'http').toString();
  return `${proto}://${host}${path}`;
}
