import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HttpRequest {
  method: string;
  path: string;
  originalUrl: string;
  query: Record<string, string | undefined>;
  params: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  rawReq: http.IncomingMessage;
}

export interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): HttpResponse;
  type(contentType: string): HttpResponse;
  send(body: string | Buffer): void;
  json(obj: unknown): void;
  redirect(url: string): void;
  sendFile(absolutePath: string): Promise<void>;
}

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type Handler<Ctx extends object = object> = (req: HttpRequest, ctx: Ctx, res: HttpResponse) => void | Promise<void>;
export type Middleware<Extra extends object> = (req: HttpRequest, res: HttpResponse, next: (extra: Extra) => void) => void | Promise<void>;

type RouteSegment = { kind: 'literal'; value: string } | { kind: 'param'; name: string };

type InternalHandler = (req: HttpRequest, res: HttpResponse, rawRes: http.ServerResponse) => void;
type InternalHandlerWithCtx<Ctx extends object = object> = (req: HttpRequest, ctx: Ctx, res: HttpResponse, rawRes: http.ServerResponse) => void;

interface CompiledRoute<Ctx extends object = object> {
  method: 'GET' | 'POST';
  segments: RouteSegment[];
  handler: Handler<Ctx>;
}

export interface App<Ctx extends object = object> {
  routes: CompiledRoute<Ctx>[];
  _wrapHandler: (inner: InternalHandlerWithCtx<Ctx>) => InternalHandler;
}

export function createApp(): App {
  return {
    routes: [],
    _wrapHandler: (inner) => (req, res, rawRes) => inner(req, {}, res, rawRes),
  };
}

export function withMiddleware<Ctx extends object, Extra extends object>(
  app: App<Ctx>,
  mw: Middleware<Extra>,
): App<Ctx & Extra> {
  const prevWrap = app._wrapHandler;
  return {
    routes: app.routes,
    _wrapHandler: (inner) => prevWrap((req, ctx, res, rawRes) => {
      try {
        const result = mw(req, res, (extra) => {
          inner(req, { ...ctx, ...extra }, res, rawRes);
        });
        if (result && typeof result.then === 'function') {
          result.catch((err: unknown) => {
            handleError(err, rawRes);
          });
        }
      } catch (err) {
        handleError(err, rawRes);
      }
    }),
  };
}

function compilePattern(pattern: string): RouteSegment[] {
  const parts = pattern.split('/').filter(p => p.length > 0);
  return parts.map((p): RouteSegment => {
    if (p.startsWith(':')) {
      return { kind: 'param', name: p.slice(1) };
    }
    return { kind: 'literal', value: p };
  });
}

export function addGetRoute<Ctx extends object>(app: App<Ctx>, pattern: string, handler: Handler<Ctx>): void {
  app.routes.push({
    method: 'GET',
    segments: compilePattern(pattern),
    handler,
  });
}

export function addPostRoute<Ctx extends object>(app: App<Ctx>, pattern: string, handler: Handler<Ctx>): void {
  app.routes.push({
    method: 'POST',
    segments: compilePattern(pattern),
    handler,
  });
}

function matchRoute<Ctx extends object>(route: CompiledRoute<Ctx>, method: string, pathname: string): Record<string, string> | null {
  if (route.method !== method) return null;
  const parts = pathname.split('/').filter(p => p.length > 0);
  if (parts.length !== route.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = route.segments[i];
    if (seg.kind === 'literal') {
      if (seg.value !== parts[i]) return null;
    } else {
      params[seg.name] = decodeURIComponent(parts[i]);
    }
  }
  return params;
}

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.vtt': 'text/vtt',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const pieces = header.split(';');
  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function makeResponse(req: HttpRequest, rawRes: http.ServerResponse): HttpResponse {
  const res: HttpResponse = {
    status(code: number) {
      rawRes.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      rawRes.setHeader(name, value);
      return res;
    },
    type(contentType: string) {
      rawRes.setHeader('Content-Type', contentType);
      return res;
    },
    send(body: string | Buffer) {
      if (typeof body === 'string') {
        if (!rawRes.getHeader('Content-Type')) {
          rawRes.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
        const buf = Buffer.from(body, 'utf8');
        rawRes.setHeader('Content-Length', String(buf.byteLength));
        rawRes.end(buf);
      } else {
        if (!rawRes.getHeader('Content-Type')) {
          rawRes.setHeader('Content-Type', 'application/octet-stream');
        }
        rawRes.setHeader('Content-Length', String(body.byteLength));
        rawRes.end(body);
      }
    },
    json(obj: unknown) {
      const body = JSON.stringify(obj);
      rawRes.setHeader('Content-Type', 'application/json; charset=utf-8');
      const buf = Buffer.from(body, 'utf8');
      rawRes.setHeader('Content-Length', String(buf.byteLength));
      rawRes.end(buf);
    },
    redirect(url: string) {
      rawRes.statusCode = 302;
      rawRes.setHeader('Location', url);
      rawRes.end();
    },
    async sendFile(absolutePath: string): Promise<void> {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(absolutePath);
      } catch (e: unknown) {
        const code = (e as { code?: string }).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          if (!rawRes.headersSent) {
            rawRes.statusCode = 404;
            rawRes.setHeader('Content-Type', 'text/plain; charset=utf-8');
            rawRes.end('Not found');
          }
          return;
        }
        if (!rawRes.headersSent) {
          rawRes.statusCode = 500;
          rawRes.setHeader('Content-Type', 'text/plain; charset=utf-8');
          rawRes.end('Internal server error');
        }
        return;
      }

      if (!stat.isFile()) {
        rawRes.statusCode = 404;
        rawRes.setHeader('Content-Type', 'text/plain; charset=utf-8');
        rawRes.end('Not found');
        return;
      }

      if (!rawRes.getHeader('Content-Type')) {
        rawRes.setHeader('Content-Type', mimeFromPath(absolutePath));
      }
      rawRes.setHeader('Accept-Ranges', 'bytes');
      rawRes.setHeader('Last-Modified', stat.mtime.toUTCString());

      const ifModSinceHeader = req.headers['if-modified-since'];
      if (typeof ifModSinceHeader === 'string') {
        const since = Date.parse(ifModSinceHeader);
        const mtime = Math.floor(stat.mtimeMs / 1000) * 1000;
        if (!Number.isNaN(since) && since >= mtime) {
          rawRes.statusCode = 304;
          rawRes.removeHeader('Content-Type');
          rawRes.removeHeader('Content-Length');
          rawRes.end();
          return;
        }
      }

      const size = stat.size;
      let start = 0;
      let end = size - 1;
      let isPartial = false;

      const rangeHeader = req.headers['range'];
      if (typeof rangeHeader === 'string') {
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!m) {
          rawRes.statusCode = 416;
          rawRes.setHeader('Content-Range', `bytes */${size}`);
          rawRes.end();
          return;
        }
        const startStr = m[1];
        const endStr = m[2];
        if (startStr === '' && endStr === '') {
          rawRes.statusCode = 416;
          rawRes.setHeader('Content-Range', `bytes */${size}`);
          rawRes.end();
          return;
        } else if (startStr === '') {
          const n = parseInt(endStr, 10);
          if (n <= 0) {
            rawRes.statusCode = 416;
            rawRes.setHeader('Content-Range', `bytes */${size}`);
            rawRes.end();
            return;
          }
          start = Math.max(0, size - n);
          end = size - 1;
        } else if (endStr === '') {
          start = parseInt(startStr, 10);
          end = size - 1;
        } else {
          start = parseInt(startStr, 10);
          end = parseInt(endStr, 10);
        }
        if (start > end || start < 0 || end >= size) {
          rawRes.statusCode = 416;
          rawRes.setHeader('Content-Range', `bytes */${size}`);
          rawRes.end();
          return;
        }
        isPartial = true;
      }

      const length = end - start + 1;
      rawRes.setHeader('Content-Length', String(length));
      if (isPartial) {
        rawRes.statusCode = 206;
        rawRes.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      } else {
        rawRes.statusCode = 200;
      }

      if (req.method === 'HEAD') {
        rawRes.end();
        return;
      }

      await new Promise<void>((resolve) => {
        const stream = fs.createReadStream(absolutePath, { start, end });
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        stream.on('error', (err) => {
          if (!rawRes.headersSent) {
            rawRes.statusCode = 500;
            rawRes.end();
          } else {
            rawRes.destroy(err);
          }
          finish();
        });
        rawRes.on('close', finish);
        stream.pipe(rawRes);
      });
    },
  };
  return res;
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export async function getBodyJson(req: HttpRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.rawReq.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        req.rawReq.destroy();
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.rawReq.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.rawReq.on('error', () => {
      reject(new HttpError(400, 'Request error'));
    });
  });
}

export function getCookies(req: HttpRequest): Record<string, string> {
  return parseCookieHeader(req.headers['cookie']);
}

function buildRequest(rawReq: http.IncomingMessage): HttpRequest {
  const url = new URL(rawReq.url ?? '/', 'http://localhost');
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (!(k in query)) {
      query[k] = v;
    }
  }
  return {
    method: rawReq.method ?? 'GET',
    path: url.pathname,
    originalUrl: (rawReq.url ?? '/'),
    query,
    params: {},
    headers: rawReq.headers,
    rawReq,
  };
}

function handleError(err: unknown, rawRes: http.ServerResponse): void {
  if (rawRes.headersSent) {
    rawRes.destroy();
    return;
  }
  if (err instanceof HttpError) {
    rawRes.statusCode = err.statusCode;
    rawRes.setHeader('Content-Type', 'application/json; charset=utf-8');
    rawRes.end(JSON.stringify({ message: err.message }));
    return;
  }
  console.error(err);
  rawRes.statusCode = 500;
  rawRes.setHeader('Content-Type', 'text/plain; charset=utf-8');
  rawRes.end('Internal server error');
}

export function listen<Ctx extends object>(app: App<Ctx>, port: number, cb: (err?: Error) => void): http.Server {
  const handler = app._wrapHandler((req, ctx, res, rawRes) => {
    for (const route of app.routes) {
      const params = matchRoute(route, req.method, req.path);
      if (params) {
        req.params = params;
        try {
          const result = route.handler(req, ctx, res);
          if (result && typeof result.then === 'function') {
            result.catch((err: unknown) => {
              handleError(err, rawRes);
            });
          }
        } catch (err) {
          handleError(err, rawRes);
        }
        return;
      }
    }
    if (!rawRes.headersSent) {
      rawRes.statusCode = 404;
      rawRes.setHeader('Content-Type', 'text/plain; charset=utf-8');
      rawRes.end('Not found');
    }
  });

  const server = http.createServer((rawReq, rawRes) => {
    const req = buildRequest(rawReq);
    const res = makeResponse(req, rawRes);
    handler(req, res, rawRes);
  });

  server.on('error', (err: Error) => {
    cb(err);
  });
  server.listen(port, () => {
    cb();
  });
  return server;
}
