/**
 * Server-side app state, shared by `server.mjs` (production) and the Vite dev server.
 *
 *   GET  /api/state            every key: { keys: { [key]: { v, t } } }
 *   GET  /api/state/<key>      one key: { v, t }  (404 when absent)
 *   PUT  /api/state/<key>      body { v: string|null, t: number } — last write wins by `t`;
 *   POST /api/state/<key>      same (navigator.sendBeacon on page unload)
 *   GET  /api/events           Server-Sent Events: `state` { key, t } on every change
 *   PUT  /api/blob/<id>        raw image bytes (≤ 5 MB) → { url }
 *   GET  /api/blob/<id>        the image
 *
 * Values are the browser's localStorage strings for the app's `chart-desk*` keys, so the
 * browser stays the fast path and the server is the durable copy every device shares.
 * Files live in `<dataDir>/state/` (one JSON per key) and `<dataDir>/blobs/`.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, existsSync, unlinkSync, watch } from 'node:fs';
import { join } from 'node:path';

const KEY_RE = /^chart-desk[a-z0-9._-]{0,80}$/i;
const BLOB_RE = /^[a-z0-9_-]{1,80}$/i;
const MAX_STATE = 8 * 1024 * 1024;
const MAX_BLOB = 5 * 1024 * 1024;
const HISTORY_KEEP = 20;

function readBody(req, limit) {
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

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

export function createStateStore(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const listeners = new Set();
  const file = (key) => join(stateDir, `${key}.json`);

  const get = (key) => {
    try {
      return JSON.parse(readFileSync(file(key), 'utf8'));
    } catch {
      return null;
    }
  };

  const all = () => {
    const keys = {};
    for (const f of readdirSync(stateDir)) {
      if (!f.endsWith('.json')) continue;
      const key = f.slice(0, -5);
      if (!KEY_RE.test(key)) continue;
      const doc = get(key);
      if (doc) keys[key] = doc;
    }
    return keys;
  };

  /** Write if `t` is not older than what's stored. Returns the stored doc and whether it changed. */
  const put = (key, v, t) => {
    const cur = get(key);
    if (cur && cur.t > t) return { doc: cur, changed: false };
    const doc = { v, t };
    // Keep the last versions of every key (restore by copying one back over <key>.json).
    if (cur) {
      try {
        const hist = join(stateDir, '.history', key);
        mkdirSync(hist, { recursive: true });
        writeFileSync(join(hist, `${cur.t}.json`), JSON.stringify(cur));
        const old = readdirSync(hist).filter((f) => f.endsWith('.json')).sort((x, y) => Number.parseInt(y) - Number.parseInt(x));
        for (const f of old.slice(HISTORY_KEEP)) unlinkSync(join(hist, f));
      } catch {
        /* history is best effort */
      }
    }
    if (v == null) {
      try {
        unlinkSync(file(key));
      } catch {
        /* already gone */
      }
    } else {
      const tmp = `${file(key)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc));
      renameSync(tmp, file(key));
    }
    for (const fn of listeners) fn(key, t);
    return { doc, changed: true };
  };

  return { get, all, put, onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)), dir: stateDir };
}

/**
 * Optional login for the whole app: set DESK_AUTH="user:password" to require HTTP Basic
 * auth (the browser asks once and remembers it). Off when unset.
 */
export function checkAuth(req, res) {
  const want = process.env.DESK_AUTH;
  if (!want) return true;
  const got = (req.headers.authorization || '').replace(/^Basic\s+/i, '');
  let ok = false;
  try {
    ok = Buffer.from(got, 'base64').toString('utf8') === want;
  } catch {
    ok = false;
  }
  if (ok) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Chart Desk", charset="UTF-8"', 'Content-Type': 'text/plain' });
  res.end('Login required');
  return false;
}

export function createStateHandler({ dataDir, store: given, status, notifyTest }) {
  const store = given ?? createStateStore(join(dataDir, 'state'));
  const blobDir = join(dataDir, 'blobs');
  mkdirSync(blobDir, { recursive: true });

  // SSE fan-out. Writes from this process notify directly; writes from another process
  // sharing the folder (dev server + container) arrive through the file watcher.
  const clients = new Set();
  const lastSent = new Map();
  const broadcast = (key, t) => {
    if (lastSent.get(key) === t) return;
    lastSent.set(key, t);
    const msg = `event: state\ndata: ${JSON.stringify({ key, t })}\n\n`;
    for (const res of clients) res.write(msg);
  };
  store.onChange(broadcast);
  try {
    watch(store.dir, (_ev, name) => {
      if (!name || !name.endsWith('.json')) return;
      const key = name.slice(0, -5);
      if (!KEY_RE.test(key)) return;
      const doc = store.get(key);
      broadcast(key, doc?.t ?? Date.now());
    });
  } catch {
    /* fs.watch unsupported: same-process writes still broadcast */
  }
  setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25_000).unref?.();

  /** Returns true when it handled the request. */
  return function handle(req, res) {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/api/')) return false;
    const method = (req.method || 'GET').toUpperCase();

    if (url === '/api/status') {
      json(res, 200, { ok: true, ...(status ? status() : {}) });
      return true;
    }

    if (url === '/api/notify-test' && method === 'POST') {
      Promise.resolve(notifyTest?.())
        .then(() => json(res, 200, { ok: true }))
        .catch((err) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return true;
    }

    if (url === '/api/state' && method === 'GET') {
      json(res, 200, { keys: store.all(), now: Date.now() });
      return true;
    }

    const sm = url.match(/^\/api\/state\/([^/]+)$/);
    if (sm) {
      const key = decodeURIComponent(sm[1]);
      if (!KEY_RE.test(key)) {
        json(res, 400, { error: 'bad key' });
        return true;
      }
      if (method === 'GET') {
        const doc = store.get(key);
        if (doc) json(res, 200, doc);
        else json(res, 404, { error: 'not found' });
        return true;
      }
      if (method === 'PUT' || method === 'POST') {
        readBody(req, MAX_STATE)
          .then((buf) => {
            const body = JSON.parse(buf.toString('utf8'));
            const t = Number(body.t);
            if (!Number.isFinite(t) || (body.v != null && typeof body.v !== 'string')) throw new Error('expected { v: string|null, t }');
            const { doc, changed } = store.put(key, body.v ?? null, t);
            json(res, changed ? 200 : 409, doc);
          })
          .catch((err) => json(res, 400, { error: err instanceof Error ? err.message : String(err) }));
        return true;
      }
    }

    const bm = url.match(/^\/api\/blob\/([^/]+)$/);
    if (bm) {
      const id = bm[1];
      if (!BLOB_RE.test(id)) {
        json(res, 400, { error: 'bad id' });
        return true;
      }
      const path = join(blobDir, id);
      if (method === 'GET') {
        if (!existsSync(path)) {
          json(res, 404, { error: 'not found' });
          return true;
        }
        let type = 'application/octet-stream';
        try {
          type = readFileSync(`${path}.type`, 'utf8') || type;
        } catch {
          /* default */
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable' });
        res.end(readFileSync(path));
        return true;
      }
      if (method === 'PUT' || method === 'POST') {
        const type = String(req.headers['content-type'] || '');
        if (!/^image\/(png|jpeg|webp)$/.test(type)) {
          json(res, 415, { error: 'images only (png, jpeg, webp)' });
          return true;
        }
        readBody(req, MAX_BLOB)
          .then((buf) => {
            writeFileSync(path, buf);
            writeFileSync(`${path}.type`, type);
            json(res, 200, { url: `/api/blob/${id}` });
          })
          .catch((err) => json(res, 413, { error: err instanceof Error ? err.message : String(err) }));
        return true;
      }
      if (method === 'DELETE') {
        for (const p of [path, `${path}.type`]) {
          try {
            unlinkSync(p);
          } catch {
            /* gone */
          }
        }
        json(res, 200, { ok: true });
        return true;
      }
    }

    json(res, 404, { error: 'unknown api route' });
    return true;
  };
}
