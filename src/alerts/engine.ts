/**
 * TradingView-style price alerts: conditions on a symbol's price (crossing, crossing
 * up / down, greater / less than), fired only once or at most once per minute, with
 * optional expiry. Prices come from every live feed the app already runs (chart ticks,
 * watchlist and Hyperliquid quotes, via the paper engine's `onAnyPrice`) and, for
 * symbols nothing else is pricing, from a light poll. Firing shows an in-app popup,
 * plays a chime and, when allowed, a desktop notification; every fire is logged.
 */
import { fetchLbankQuote } from '../providers/lbank';
import { fmtPrice, onAnyPrice, sameSymbol } from '../trading/paper-store';

export type AlertCondition = 'crossing' | 'crossing_up' | 'crossing_down' | 'greater' | 'less';
export type AlertTrigger = 'once' | 'per_minute';

export type PriceAlert = {
  id: string;
  symbol: string;
  condition: AlertCondition;
  price: number;
  trigger: AlertTrigger;
  /** Epoch ms, or null for open-ended. */
  expiresAt: number | null;
  message: string;
  sound: boolean;
  desktop: boolean;
  active: boolean;
  createdAt: number;
  lastFiredAt?: number;
  /** Why an inactive alert stopped: fired (once), expired, or paused by hand. */
  stopped?: 'triggered' | 'expired' | 'paused';
};

export type AlertLogEntry = { id: string; alertId: string; symbol: string; message: string; price: number; time: number };

type Store = { alerts: PriceAlert[]; log: AlertLogEntry[] };

const LS_KEY = 'chart-desk-alerts-v1';
const LOG_CAP = 200;
const POLL_MS = 4_000;
/** A symbol priced by another feed within this window is not polled. */
const FRESH_MS = 8_000;

export const CONDITION_LABEL: Record<AlertCondition, string> = {
  crossing: 'Crossing',
  crossing_up: 'Crossing Up',
  crossing_down: 'Crossing Down',
  greater: 'Greater Than',
  less: 'Less Than',
};

export const TRIGGER_LABEL: Record<AlertTrigger, string> = {
  once: 'Only once',
  per_minute: 'Once per minute',
};

function load(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Store>;
      return { alerts: Array.isArray(s.alerts) ? s.alerts : [], log: Array.isArray(s.log) ? s.log : [] };
    }
  } catch {
    /* ignore */
  }
  return { alerts: [], log: [] };
}

let store = load();
const listeners = new Set<() => void>();
/** Last price seen per alert (crossing needs the previous side). */
const prevById = new Map<string, number>();
/** When each symbol last got a price from any feed. */
const seenAt = new Map<string, number>();
const lastPx = new Map<string, number>();

function save(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* quota */
  }
  for (const fn of listeners) fn();
}

const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function onAlertsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAlerts(): readonly PriceAlert[] {
  return store.alerts;
}

export function getAlertLog(): readonly AlertLogEntry[] {
  return store.log;
}

export function alertsFor(symbol: string): PriceAlert[] {
  return store.alerts.filter((a) => sameSymbol(a.symbol, symbol));
}

export function lastSeenPrice(symbol: string): number | undefined {
  const direct = lastPx.get(symbol);
  if (direct != null) return direct;
  for (const [k, v] of lastPx) if (sameSymbol(k, symbol)) return v;
  return undefined;
}

/** `lbank:BTCUSDT.P` → `BTCUSDT.P`. */
export function displaySymbol(symbol: string): string {
  return symbol.split(':').slice(1).join(':') || symbol;
}

export function defaultMessage(a: Pick<PriceAlert, 'symbol' | 'condition' | 'price'>): string {
  return `${displaySymbol(a.symbol)} ${CONDITION_LABEL[a.condition]} ${fmtPrice(a.price)}`;
}

export function upsertAlert(input: Omit<PriceAlert, 'id' | 'createdAt' | 'active'> & { id?: string }): PriceAlert {
  const existing = input.id ? store.alerts.find((a) => a.id === input.id) : undefined;
  if (existing) {
    Object.assign(existing, input, { active: true, stopped: undefined, lastFiredAt: undefined });
    prevById.delete(existing.id);
    save();
    return existing;
  }
  const alert: PriceAlert = { ...input, id: uid(), createdAt: Date.now(), active: true };
  store.alerts.push(alert);
  save();
  if (alert.desktop) void askDesktopPermission();
  return alert;
}

export function removeAlert(id: string): void {
  store.alerts = store.alerts.filter((a) => a.id !== id);
  prevById.delete(id);
  save();
}

export function setAlertActive(id: string, active: boolean): void {
  const a = store.alerts.find((x) => x.id === id);
  if (!a) return;
  a.active = active;
  a.stopped = active ? undefined : 'paused';
  if (active && a.expiresAt != null && a.expiresAt < Date.now()) a.expiresAt = null;
  prevById.delete(id);
  save();
}

/** Move an alert's level (dragging its line, or the dialog). */
export function setAlertPrice(id: string, price: number): void {
  const a = store.alerts.find((x) => x.id === id);
  if (!a || !(price > 0)) return;
  const wasDefault = a.message === defaultMessage(a);
  a.price = price;
  if (wasDefault) a.message = defaultMessage(a);
  prevById.delete(id);
  save();
}

export function clearAlertLog(): void {
  store.log = [];
  save();
}

export function removeAllAlerts(filter?: (a: PriceAlert) => boolean): void {
  store.alerts = filter ? store.alerts.filter((a) => !filter(a)) : [];
  save();
}

function hit(a: PriceAlert, prev: number | undefined, price: number): boolean {
  switch (a.condition) {
    case 'greater':
      return price > a.price;
    case 'less':
      return price < a.price;
    case 'crossing_up':
      return prev != null && prev < a.price && price >= a.price;
    case 'crossing_down':
      return prev != null && prev > a.price && price <= a.price;
    case 'crossing':
      return prev != null && ((prev < a.price && price >= a.price) || (prev > a.price && price <= a.price));
  }
}

function evaluate(symbol: string, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  seenAt.set(symbol, Date.now());
  lastPx.set(symbol, price);
  const now = Date.now();
  let changed = false;
  for (const a of store.alerts) {
    if (!a.active || !sameSymbol(a.symbol, symbol)) continue;
    if (a.expiresAt != null && a.expiresAt < now) {
      a.active = false;
      a.stopped = 'expired';
      changed = true;
      continue;
    }
    const prev = prevById.get(a.id);
    prevById.set(a.id, price);
    if (!hit(a, prev, price)) continue;
    if (a.trigger === 'per_minute' && a.lastFiredAt != null && now - a.lastFiredAt < 60_000) continue;
    a.lastFiredAt = now;
    if (a.trigger === 'once') {
      a.active = false;
      a.stopped = 'triggered';
    }
    store.log.unshift({ id: uid(), alertId: a.id, symbol: a.symbol, message: a.message, price, time: now });
    if (store.log.length > LOG_CAP) store.log.length = LOG_CAP;
    changed = true;
    fire(a, price);
  }
  if (changed) save();
}

// ── Notifications ─────────────────────────────────────────────────────────

let audio: AudioContext | null = null;

function chime(): void {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [i, f] of [880, 1320, 880].entries()) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.18);
      o.stop(t + i * 0.18 + 0.17);
    }
  } catch {
    /* audio blocked until a user gesture */
  }
}

export async function askDesktopPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Chart opener for the popup's "Open chart" (set by the UI layer). */
let openChart: ((symbol: string) => void) | null = null;
export function setAlertChartOpener(fn: (symbol: string) => void): void {
  openChart = fn;
}

function popup(a: PriceAlert, price: number): void {
  let host = document.querySelector<HTMLElement>('.desk-alert-pop');
  if (!host) {
    host = document.createElement('div');
    host.className = 'desk-alert-pop';
    document.body.appendChild(host);
  }
  const card = document.createElement('div');
  card.className = 'desk-alert-pop__card';
  card.setAttribute('role', 'alert');
  card.innerHTML = `
    <div class="desk-alert-pop__head"><span class="desk-alert-pop__bell">🔔</span><b>Alert on ${esc(displaySymbol(a.symbol))}</b>
      <button type="button" data-x aria-label="Dismiss">✕</button></div>
    <div class="desk-alert-pop__msg">${esc(a.message)}</div>
    <div class="desk-alert-pop__meta">${new Date().toLocaleTimeString([], { hourCycle: 'h23' })} · price ${esc(fmtPrice(price))}</div>
    <div class="desk-alert-pop__actions"><button type="button" data-open>Open chart</button><button type="button" data-ok>OK</button></div>`;
  card.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-open]')) openChart?.(a.symbol);
    if (t.closest('[data-x], [data-ok], [data-open]')) card.remove();
  });
  host.prepend(card);
  // Popups stay until dismissed, like TradingView's; cap how many pile up.
  while (host.children.length > 4) host.lastElementChild?.remove();
}

function fire(a: PriceAlert, price: number): void {
  popup(a, price);
  if (a.sound) chime();
  if (a.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(`Alert on ${displaySymbol(a.symbol)}`, { body: `${a.message}\nPrice ${fmtPrice(price)}`, tag: a.id });
      n.onclick = () => {
        window.focus();
        openChart?.(a.symbol);
      };
    } catch {
      /* ignore */
    }
  }
}

/** A Pine script's `alert()` / `alertcondition` fire: same popup, chime and log. */
export function logScriptAlert(symbol: string, source: string, message: string, price: number): void {
  const a: PriceAlert = {
    id: `script-${source}`,
    symbol,
    condition: 'crossing',
    price,
    trigger: 'per_minute',
    expiresAt: null,
    message: source ? `${source}: ${message}` : message,
    sound: true,
    desktop: typeof Notification !== 'undefined' && Notification.permission === 'granted',
    active: true,
    createdAt: Date.now(),
  };
  store.log.unshift({ id: uid(), alertId: a.id, symbol, message: a.message, price, time: Date.now() });
  if (store.log.length > LOG_CAP) store.log.length = LOG_CAP;
  save();
  fire(a, price);
}

// ── Polling for symbols no other feed prices ─────────────────────────────

async function hlMids(dex?: string): Promise<Record<string, string>> {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dex ? { type: 'allMids', dex } : { type: 'allMids' }),
  });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as Record<string, string>;
}

async function pollOnce(): Promise<void> {
  const now = Date.now();
  // Expire stale alerts even when their symbol is quiet.
  let expired = false;
  for (const a of store.alerts) {
    if (a.active && a.expiresAt != null && a.expiresAt < now) {
      a.active = false;
      a.stopped = 'expired';
      expired = true;
    }
  }
  if (expired) save();

  const symbols = [...new Set(store.alerts.filter((a) => a.active).map((a) => a.symbol))].filter((s) => {
    for (const [k, t] of seenAt) if (sameSymbol(k, s) && now - t < FRESH_MS) return false;
    return true;
  });
  if (!symbols.length) return;

  const hl = symbols.filter((s) => s.toLowerCase().startsWith('hyperliquid:'));
  if (hl.length) {
    try {
      const needXyz = hl.some((s) => /^hyperliquid:xyz:/i.test(s));
      const needMain = hl.some((s) => !/^hyperliquid:xyz:/i.test(s));
      const [main, xyz] = await Promise.all([needMain ? hlMids() : {}, needXyz ? hlMids('xyz') : {}]);
      const mids: Record<string, string> = { ...main, ...xyz };
      for (const s of hl) {
        const coin = s.slice('hyperliquid:'.length);
        const px = Number(mids[coin] ?? mids[coin.toUpperCase()]);
        if (px > 0) evaluate(s, px);
      }
    } catch {
      /* rate limited: next round */
    }
  }
  for (const s of symbols) {
    const lower = s.toLowerCase();
    try {
      if (lower.startsWith('lbank:')) {
        const q = await fetchLbankQuote(s);
        if (q?.price) evaluate(s, q.price);
      } else if (lower.startsWith('coinbase:')) {
        const id = s.slice(s.indexOf(':') + 1).toUpperCase();
        const res = await fetch(`https://api.exchange.coinbase.com/products/${encodeURIComponent(id)}/ticker`);
        if (res.ok) {
          const px = Number(((await res.json()) as { price?: string }).price);
          if (px > 0) evaluate(s, px);
        }
      }
    } catch {
      /* next round */
    }
  }
}

let started = false;

export function startAlertEngine(): void {
  if (started) return;
  started = true;
  onAnyPrice((symbol, price) => evaluate(symbol, price));
  const loop = async (): Promise<void> => {
    try {
      await pollOnce();
    } finally {
      setTimeout(() => void loop(), POLL_MS);
    }
  };
  void loop();
  // Pick up edits made in another tab.
  window.addEventListener('storage', (e) => {
    if (e.key !== LS_KEY) return;
    store = load();
    for (const fn of listeners) fn();
  });
}

/** Test hook: push a price through the engine. */
export const feedAlertPrice = evaluate;
