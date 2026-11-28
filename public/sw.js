/* Chart Desk service worker: offline app shell only. Market data is never cached. */
const CACHE = 'chart-desk-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];
/** Same-origin routes that carry live data or proxies: always straight to the network. */
const NEVER_CACHE = ['/feeds/', '/api/', '/lbank-api', '/lbank-perp', '/lbank-ws', '/desk-latest.json'];
/** Hashed build files kept at most (oldest dropped first) so old builds do not pile up. */
const MAX_ASSETS = 80;
/** Dev/preview servers send `Vary: Origin`; module scripts carry an Origin the precache fetch did not. */
const MATCH = { ignoreVary: true };

const isDataRoute = (path) => NEVER_CACHE.some((p) => path === p || path.startsWith(p));

/** `/assets/…` paths named in an HTML or JS file (Vite writes lazy chunks as "assets/x.js"). */
function assetRefs(text) {
  const out = new Set();
  for (const m of text.matchAll(/["'`(/]?(?:\.?\/)?assets\/([\w.-]+\.(?:js|css|wasm|woff2|png|svg))/g)) out.add(`/assets/${m[1]}`);
  return out;
}

/**
 * Cache the whole shell: every /assets/* file the HTML references, then the chunks
 * those scripts import lazily (followed through the JS), so the app boots offline
 * even though the first visit fetched them before the worker took control.
 */
async function cacheShellAssets(cache, html) {
  const seen = new Set();
  let queue = [...assetRefs(html)];
  while (queue.length && seen.size < 200) {
    const next = [];
    await Promise.all(
      queue.map(async (u) => {
        if (seen.has(u)) return;
        seen.add(u);
        try {
          let res = await cache.match(u, MATCH);
          if (!res) {
            const net = await fetch(u, { credentials: 'same-origin' });
            if (!net.ok) return;
            await cache.put(u, net.clone());
            res = net;
          }
          if (u.endsWith('.js') || u.endsWith('.css')) {
            for (const ref of assetRefs(await res.text())) if (!seen.has(ref)) next.push(ref);
          }
        } catch {
          /* offline: picked up on a later visit */
        }
      }),
    );
    queue = next;
  }
}

async function trimAssets(cache) {
  const keys = (await cache.keys()).filter((r) => new URL(r.url).pathname.startsWith('/assets/'));
  for (const req of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(req);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        SHELL.map((u) =>
          cache.add(new Request(u, { cache: 'reload' })).catch(() => {
            /* a missing icon must not block install */
          }),
        ),
      );
      const index = await cache.match('/', MATCH);
      if (index) await cacheShellAssets(cache, await index.clone().text());
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('chart-desk-shell-') && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Cross-origin (exchanges, icons CDN, websockets…) and data routes: not ours.
  if (url.origin !== self.location.origin || isDataRoute(url.pathname)) return;

  // Navigations: network first (fresh deploys win), cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
            await cache.put('/', res.clone());
            event.waitUntil(
              res
                .clone()
                .text()
                .then((html) => cacheShellAssets(cache, html))
                .then(() => trimAssets(cache)),
            );
          }
          return res;
        } catch {
          return (await cache.match('/', MATCH)) || Response.error();
        }
      })(),
    );
    return;
  }

  // Hashed build output never changes: cache first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req, MATCH);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) event.waitUntil(cache.put(req, res.clone()));
        return res;
      })(),
    );
    return;
  }

  // Other shell files (manifest, icons, favicon): network first, cache as fallback.
  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          if (res.ok) event.waitUntil(cache.put(req, res.clone()));
          return res;
        } catch {
          return (await cache.match(req, MATCH)) || Response.error();
        }
      })(),
    );
  }
});
