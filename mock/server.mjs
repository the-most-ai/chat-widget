// Демо-стенд для собранного файла: сайт на :5180 со строгим CSP и шлюз-мок на :5181 (другой origin, CORS).
// Запуск: npm run build && npm run demo, затем http://localhost:5180/
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayMiddleware, HELP } from './gateway.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE_PORT = Number(process.env.SITE_PORT ?? 5180);
const GW_PORT = Number(process.env.GW_PORT ?? 5181);

// Строгий CSP: нет 'unsafe-inline' ни для скриптов, ни для стилей и нет 'unsafe-eval'.
// Если виджет работает здесь, он работает и на сайте с более мягкой политикой.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-elem 'self'",
  "style-src 'self'",
  // data: — превью своих картинок в истории, blob: — картинки ассистента.
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' http://localhost:${GW_PORT}`,
  "frame-ancestors 'self'",
].join('; ');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const ROUTES = { '/': 'demo/index.html', '/same-origin': 'demo/same-origin.html', '/avai-chat.js': 'dist/avai-chat.js', '/avai-chat.js.map': 'dist/avai-chat.js.map' };

const gw = gatewayMiddleware({ prefix: '/v1', allowOrigin: (o) => o === `http://localhost:${SITE_PORT}` });

async function serveFile(res, rel) {
  const path = normalize(join(ROOT, rel));
  if (!path.startsWith(normalize(ROOT))) return notFound(res);
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    notFound(res, rel.startsWith('dist/') ? 'Нет dist/: сначала npm run build' : 'Not found');
  }
}

function notFound(res, text = 'Not found') {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  // Тот же мок и на origin сайта: для проверки адреса API по умолчанию (origin файла + /v1).
  if (pathname.startsWith('/v1/')) return gw(req, res, () => notFound(res));
  if (ROUTES[pathname]) return serveFile(res, ROUTES[pathname]);
  if (pathname.startsWith('/demo/')) return serveFile(res, pathname.slice(1));
  notFound(res);
}).listen(SITE_PORT, () => console.log(`сайт:  http://localhost:${SITE_PORT}/  (и /same-origin)`));

createServer((req, res) => gw(req, res, () => notFound(res))).listen(GW_PORT, () => {
  console.log(`шлюз: http://localhost:${GW_PORT}/v1`);
  console.log(HELP);
});
