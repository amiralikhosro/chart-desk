#!/usr/bin/env node
/**
 * Production server: static `dist/` + live desk-latest.json + LBank proxies.
 * Usage: node server.mjs
 * Env:
 *   PORT (default 4173), HOST (default 0.0.0.0)
 *   DESK_DATA_DIR — writable dir for desk-latest.json (default ./data)
 *   DESK_TOKEN — optional bearer/token required for PUT /desk-latest.json
 */
import { createServer } from 'node:http';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import httpProxy from 'http-proxy';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(__dirname, 'dist');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 4173);
const DESK_DIR = process.env.DESK_DATA_DIR || join(__dirname, 'data');
const DESK_FILE = join(DESK_DIR, 'desk-latest.json');
const DESK_TOKEN = process.env.DESK_TOKEN || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

try {
  mkdirSync(DESK_DIR, { recursive: true });
} catch {
  /* ignore */
}

const proxy = httpProxy.createProxyServer({ changeOrigin: true, secure: true });
proxy.on('error', (err, _req, res) => {
  console.error('[proxy]', err.message);
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway');
  }
});

function stripPrefix(url, prefix) {
  const next = url.slice(prefix.length) || '/';
  return next.startsWith('/') ? next : `/${next}`;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}

function sendFile(res, filePath, extraHeaders = {}) {
  try {
    const data = readFileSync(filePath);
    const isHtml = extname(filePath) === '.html';
    send(res, 200, data, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      ...extraHeaders,
    });
  } catch {
    send(res, 404, 'Not found');
  }
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!DESK_TOKEN) return true;
  const auth = req.headers.authorization || '';
  const token = req.headers['x-desk-token'] || '';
  return auth === `Bearer ${DESK_TOKEN}` || token === DESK_TOKEN;
}

function serveDeskLatest(res) {
  const live = existsSync(DESK_FILE) ? DESK_FILE : join(DIST, 'desk-latest.json');
  if (!existsSync(live)) {
    send(res, 404, JSON.stringify({ error: 'no desk-latest.json' }), {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    return;
  }
  sendFile(res, live, { 'Cache-Control': 'no-store' });
}

async function putDeskLatest(req, res) {
  if (!authorized(req)) {
    send(res, 401, JSON.stringify({ error: 'unauthorized' }), {
      'Content-Type': 'application/json',
    });
    return;
  }
  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || !Array.isArray(parsed.markets)) {
      send(res, 400, JSON.stringify({ error: 'expected { at, markets[] }' }), {
        'Content-Type': 'application/json',
      });
      return;
    }
    if (!parsed.at) parsed.at = new Date().toISOString();
    mkdirSync(DESK_DIR, { recursive: true });
    writeFileSync(DESK_FILE, `${JSON.stringify(parsed, null, 2)}\n`);
    send(res, 200, JSON.stringify({ ok: true, at: parsed.at, markets: parsed.markets.length }), {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    send(res, 400, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      'Content-Type': 'application/json',
    });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0] || '/');
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST, safe === '/' ? 'index.html' : safe);

  if (!filePath.startsWith(DIST)) {
    send(res, 403, 'Forbidden');
    return;
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(DIST, 'index.html');
  }

  sendFile(res, filePath);
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('Missing dist/ — run `npm run build` first.');
  process.exit(1);
}

const server = createServer((req, res) => {
  const full = req.url || '/';
  const url = full.split('?')[0];
  const method = (req.method || 'GET').toUpperCase();

  if (full.startsWith('/lbank-api')) {
    req.url = stripPrefix(full, '/lbank-api');
    proxy.web(req, res, { target: 'https://api.lbank.info' });
    return;
  }
  if (full.startsWith('/lbank-perp')) {
    req.url = stripPrefix(full, '/lbank-perp');
    proxy.web(req, res, { target: 'https://lbkperp.lbank.com' });
    return;
  }

  if (url === '/desk-latest.json' || url === '/api/desk-latest') {
    if (method === 'GET' || method === 'HEAD') {
      serveDeskLatest(res);
      return;
    }
    if (method === 'PUT' || method === 'POST') {
      void putDeskLatest(req, res);
      return;
    }
  }

  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }

  serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const full = req.url || '/';
  if (!full.startsWith('/lbank-ws')) {
    socket.destroy();
    return;
  }
  req.url = stripPrefix(full, '/lbank-ws');
  proxy.ws(req, socket, head, { target: 'wss://www.lbkex.net' });
});

server.listen(PORT, HOST, () => {
  console.log(`Chart Desk → http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/`);
  console.log(`Desk data  → ${DESK_FILE}`);
  console.log('LBank proxy → /lbank-api /lbank-perp /lbank-ws');
});
