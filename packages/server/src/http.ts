// Game Server 的 node:http 适配层：把 HTTP 请求翻成 RouterRequest，把 RouterResult
// 落成响应。业务逻辑一行都不在这儿——全在 router.ts，浏览器沙盒用的是同一份。
//
// SSE 只推一个版本号，客户端收到后回来拉自己那一份裁剪过的状态：这样可见性规则只在
// visibility.ts 一处执行，不会散在推送里。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, type RouterRequest } from './router.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveFile(res: ServerResponse, name: string): void {
  const path = join(PUBLIC_DIR, normalize(name).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error('请求体过大');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export function startServer(secret: string, port: number): ReturnType<typeof createServer> {
  const route = createRouter(secret);

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      json(res, 500, { ok: false, reason: e instanceof Error ? e.message : String(e) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rreq: RouterRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: () => readJson(req),
    };
    const out = await route(rreq);

    if (out.kind === 'json') return json(res, out.code, out.body);
    if (out.kind === 'file') return serveFile(res, out.name);

    const room = out.room;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ v: room.version })}\n\n`);
    const off = room.subscribe(() => res.write(`data: ${JSON.stringify({ v: room.version })}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { off(); clearInterval(ping); });
  }

  server.listen(port);
  return server;
}
