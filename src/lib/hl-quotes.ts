/**
 * Live Hyperliquid mids via WebSocket (allMids) — keeps watchlist/chart quotes
 * in sync without 15s REST lag.
 */
export type LiveQuote = { price: number; changePct: number; at: number };

type Listener = (quotes: Map<string, LiveQuote>) => void;

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const INFO = 'https://api.hyperliquid.xyz/info';

/** Map HL mid key → chart desk symbol */
export type QuoteSymbol = {
  symbol: string;
  /** Key in allMids payload (`BTC` or `xyz:GOLD`) */
  midKey: string;
  dex?: string;
};

const quotes = new Map<string, LiveQuote>();
const prevDay = new Map<string, number>();
const listeners = new Set<Listener>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let prevTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
let symbols: QuoteSymbol[] = [];

function emit(): void {
  for (const fn of listeners) fn(new Map(quotes));
}

function applyMid(midKey: string, price: number): void {
  const item = symbols.find((s) => s.midKey === midKey);
  if (!item || !Number.isFinite(price) || price <= 0) return;
  const prev = prevDay.get(item.symbol);
  const changePct = prev && prev > 0 ? ((price - prev) / prev) * 100 : 0;
  quotes.set(item.symbol, { price, changePct, at: Date.now() });
}

async function refreshPrevDay(): Promise<void> {
  const dexes = [...new Set(symbols.map((s) => s.dex ?? ''))];
  for (const dex of dexes) {
    try {
      const body: Record<string, string> = { type: 'metaAndAssetCtxs' };
      if (dex) body.dex = dex;
      const res = await fetch(INFO, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as [
        { universe: Array<{ name: string }> },
        Array<{ markPx?: string; midPx?: string; prevDayPx?: string }>,
      ];
      const universe = data[0]?.universe ?? [];
      const ctxs = data[1] ?? [];
      for (const item of symbols) {
        if ((item.dex ?? '') !== dex) continue;
        const short = item.dex ? item.midKey.replace(`${item.dex}:`, '') : item.midKey;
        const idx = universe.findIndex((u) => u.name === item.midKey || u.name === short);
        if (idx < 0) continue;
        const prev = Number(ctxs[idx]?.prevDayPx);
        if (Number.isFinite(prev) && prev > 0) prevDay.set(item.symbol, prev);
        const mark = Number(ctxs[idx]?.markPx ?? ctxs[idx]?.midPx);
        if (Number.isFinite(mark)) applyMid(item.midKey, mark);
      }
    } catch {
      /* ignore */
    }
  }
  emit();
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    ws?.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
    // HIP-3 builder dex (GOLD)
    if (symbols.some((s) => s.dex)) {
      for (const dex of new Set(symbols.map((s) => s.dex).filter(Boolean))) {
        ws?.send(
          JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids', dex } }),
        );
      }
    }
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        channel?: string;
        data?: { mids?: Record<string, string> } | Record<string, string>;
      };
      if (msg.channel !== 'allMids') return;
      const mids =
        msg.data && typeof msg.data === 'object' && 'mids' in msg.data
          ? (msg.data.mids as Record<string, string>)
          : (msg.data as Record<string, string> | undefined);
      if (!mids) return;
      let changed = false;
      for (const item of symbols) {
        const raw = mids[item.midKey];
        if (raw == null) continue;
        const price = Number(raw);
        if (!Number.isFinite(price)) continue;
        const prev = quotes.get(item.symbol)?.price;
        applyMid(item.midKey, price);
        if (prev !== price) changed = true;
      }
      if (changed) emit();
    } catch {
      /* ignore bad frames */
    }
  };

  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2_000);
}

export function startHlQuotes(list: QuoteSymbol[]): void {
  symbols = list;
  if (!started) {
    started = true;
    void refreshPrevDay();
    prevTimer = setInterval(() => void refreshPrevDay(), 60_000);
  }
  connect();
}

export function stopHlQuotes(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (prevTimer) clearInterval(prevTimer);
  prevTimer = null;
  ws?.close();
  ws = null;
  started = false;
}

export function onHlQuotes(fn: Listener): () => void {
  listeners.add(fn);
  if (quotes.size) fn(new Map(quotes));
  return () => listeners.delete(fn);
}

export function getHlQuote(symbol: string): LiveQuote | undefined {
  return quotes.get(symbol);
}
