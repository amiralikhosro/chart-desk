/**
 * Durable, cross-device app state. Everything the app keeps (`chart-desk*` localStorage
 * keys: layouts, alerts, paper account, watchlists, journal, workspace…) is mirrored to
 * the server (`/api/state`, see state.mjs), newest write wins per key.
 *
 * Boot order matters: modules read localStorage when they load, so `bootstrapState()`
 * runs first (src/boot.ts) and pulls any newer server copy into localStorage before the
 * app is imported. After that every write is pushed (debounced, and flushed with
 * sendBeacon when the page closes), and changes made elsewhere — another device, or the
 * server's alert worker — arrive over /api/events and are re-announced as `storage`
 * events, which the stores listen to.
 */

const PREFIX = 'chart-desk';
const META_KEY = 'chart-desk-sync-meta';
/** Device-local keys that should not follow you around. */
const LOCAL_ONLY = new Set([META_KEY, 'chart-desk-paper-ui-v1', 'chart-desk-viewport-v1', 'chart-desk-journal-ui']);
const PUSH_DELAY = 800;

type Doc = { v: string | null; t: number };

const tracked = (key: string): boolean => key.startsWith(PREFIX) && !LOCAL_ONLY.has(key);

const rawSet = Storage.prototype.setItem;
const rawRemove = Storage.prototype.removeItem;

let meta: Record<string, number> = {};
let online = false;
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const statusListeners = new Set<(s: SyncStatus) => void>();

export type SyncStatus = { online: boolean; lastPush?: number; lastError?: string; serverAlerts?: boolean };
let status: SyncStatus = { online: false };

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const fn of statusListeners) fn(status);
}

export function onSyncStatus(fn: (s: SyncStatus) => void): () => void {
  statusListeners.add(fn);
  fn(status);
  return () => statusListeners.delete(fn);
}

export function syncStatus(): SyncStatus {
  return status;
}

function loadMeta(): void {
  try {
    meta = JSON.parse(localStorage.getItem(META_KEY) ?? '{}') as Record<string, number>;
  } catch {
    meta = {};
  }
}

function saveMeta(): void {
  rawSet.call(localStorage, META_KEY, JSON.stringify(meta));
}

async function push(key: string): Promise<void> {
  pending.delete(key);
  const v = localStorage.getItem(key);
  const t = meta[key] ?? Date.now();
  try {
    const res = await fetch(`/api/state/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v, t }),
    });
    if (res.status === 409) {
      // The server has something newer (another device): take it.
      const doc = (await res.json()) as Doc;
      applyRemote(key, doc);
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    setStatus({ online: true, lastPush: Date.now(), lastError: undefined });
  } catch (err) {
    setStatus({ online: false, lastError: err instanceof Error ? err.message : String(err) });
    // Retry later; the local copy is safe meanwhile.
    schedule(key, 10_000);
  }
}

function schedule(key: string, delay = PUSH_DELAY): void {
  const prev = pending.get(key);
  if (prev) clearTimeout(prev);
  pending.set(key, setTimeout(() => void push(key), delay));
}

function flushBeacon(): void {
  for (const [key, timer] of pending) {
    clearTimeout(timer);
    const body = JSON.stringify({ v: localStorage.getItem(key), t: meta[key] ?? Date.now() });
    navigator.sendBeacon?.(`/api/state/${encodeURIComponent(key)}`, new Blob([body], { type: 'application/json' }));
  }
  pending.clear();
}

/** Write a server value locally (without echoing it back) and tell the app. */
function applyRemote(key: string, doc: Doc): void {
  if ((meta[key] ?? 0) >= doc.t) return;
  const old = localStorage.getItem(key);
  if (doc.v == null) rawRemove.call(localStorage, key);
  else rawSet.call(localStorage, key, doc.v);
  meta[key] = doc.t;
  saveMeta();
  if (old !== doc.v) {
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue: old, newValue: doc.v, storageArea: localStorage }));
  }
}

function hook(): void {
  Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
    rawSet.call(this, key, value);
    if (this === localStorage && tracked(key)) {
      meta[key] = Date.now();
      saveMeta();
      schedule(key);
    }
  };
  Storage.prototype.removeItem = function (this: Storage, key: string) {
    rawRemove.call(this, key);
    if (this === localStorage && tracked(key)) {
      meta[key] = Date.now();
      saveMeta();
      schedule(key);
    }
  };
  window.addEventListener('pagehide', flushBeacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeacon();
  });
}

function listen(): void {
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    const { key, t } = JSON.parse((e as MessageEvent<string>).data) as { key: string; t: number };
    if (!tracked(key) || (meta[key] ?? 0) >= t || pending.has(key)) return;
    void fetch(`/api/state/${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? (r.json() as Promise<Doc>) : { v: null, t }))
      .then((doc) => applyRemote(key, doc));
  });
  es.onopen = () => setStatus({ online: true });
  es.onerror = () => setStatus({ online: false });
}

async function refreshServerStatus(): Promise<void> {
  try {
    const s = (await (await fetch('/api/status')).json()) as { serverAlerts?: boolean };
    setStatus({ serverAlerts: !!s.serverAlerts });
  } catch {
    setStatus({ serverAlerts: false });
  }
}

/** Pull newer server state into localStorage, push newer local state. Never blocks long. */
export async function bootstrapState(): Promise<void> {
  loadMeta();
  let server: Record<string, Doc> | null = null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2_500);
    const res = await fetch('/api/state', { signal: ctl.signal });
    clearTimeout(timer);
    if (res.ok) server = ((await res.json()) as { keys: Record<string, Doc> }).keys;
  } catch {
    server = null;
  }
  online = server != null;
  setStatus({ online });

  if (server) {
    for (const [key, doc] of Object.entries(server)) {
      if (!tracked(key)) continue;
      const localT = meta[key] ?? 0;
      const hasLocal = localStorage.getItem(key) != null;
      // A browser syncing for the first time keeps the data it already has (it is pushed
      // below): a fresh device must never overwrite a real desk with its defaults.
      if (meta[key] == null && hasLocal) continue;
      if (doc.t > localT || !hasLocal) {
        if (doc.v == null) rawRemove.call(localStorage, key);
        else rawSet.call(localStorage, key, doc.v);
        meta[key] = doc.t;
      }
    }
    // Local keys the server lacks or holds older: push them (first run migrates everything).
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !tracked(key)) continue;
      const doc = server[key];
      if (!doc || (meta[key] ?? 0) > doc.t || meta[key] == null) {
        meta[key] ??= Date.now();
        schedule(key, 1_500);
      }
    }
    saveMeta();
  }
  hook();
  listen();
  void refreshServerStatus();
  setInterval(() => void refreshServerStatus(), 30_000);
}

/** Upload an image (journal screenshots). Returns its URL. */
export async function putBlob(id: string, data: Blob): Promise<string> {
  const res = await fetch(`/api/blob/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': data.type || 'image/png' }, body: data });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return ((await res.json()) as { url: string }).url;
}
