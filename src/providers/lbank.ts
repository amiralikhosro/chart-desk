/**
 * LBank provider — kept in sync with LBank as closely as its public API allows.
 *
 * Spot (`BTCUSDT`):
 *   history  REST /v2/kline.do, paged FORWARD from the range start (2000 bars a call)
 *   live     WebSocket kbar stream (real OHLCV of the forming candle, ~1/s),
 *            REST ticker polling only while the socket is stalled
 * Perpetuals (`BTCUSDT.P`, all ~840 LBank USDT-M perps):
 *   history  LBank has no public perp klines, so the same coin's LBank spot klines,
 *            else Hyperliquid perp candles (gold: OKX XAU-USDT-SWAP, then HL xyz:GOLD)
 *   live     one shared poll of LBank's perp marketData every second (last price for
 *            every perp in one call); bar volume = growth of the 24h volume between polls
 *
 * LBank's candles are aligned to UTC+8: daily bars open 16:00 UTC, weeks Sunday 16:00 UTC,
 * months on the 1st 00:00 UTC+8. Live bars use the same buckets so they never split.
 */
import type {
  BarRange,
  DataProvider,
  OHLCV,
  ProviderInfo,
  SymbolDescriptor,
  SymbolInfo,
} from '@luxalgo/vela';
import { loadHistory, saveHistory } from '../lib/history-cache';

type Unsubscribe = () => void;

const SPOT = '/lbank-api';
const PERP = '/lbank-perp';
const OKX = 'https://www.okx.com';
const HL_INFO = 'https://api.hyperliquid.xyz/info';
const PAGE = 2000;
const MAX_PAGES = 12;
const MAX_BARS = 12_000;
const H8 = 8 * 3_600_000;

type TfMeta = {
  /** REST kline type, or null when built from a finer one. */
  rest: string | null;
  /** Finer REST type + factor used to build this timeframe. */
  build?: { rest: string; ms: number };
  ws: string;
  okx: string;
  hl: string;
  ms: number;
  cal?: 'week' | 'month';
};

const TF: Record<string, TfMeta> = {
  '1': { rest: 'minute1', ws: '1min', okx: '1m', hl: '1m', ms: 60_000 },
  '5': { rest: 'minute5', ws: '5min', okx: '5m', hl: '5m', ms: 300_000 },
  '15': { rest: 'minute15', ws: '15min', okx: '15m', hl: '15m', ms: 900_000 },
  '30': { rest: 'minute30', ws: '30min', okx: '30m', hl: '30m', ms: 1_800_000 },
  '60': { rest: 'hour1', ws: '1hr', okx: '1H', hl: '1h', ms: 3_600_000 },
  // LBank REST has no 2h klines (the socket does): build them from 1h.
  '120': { rest: null, build: { rest: 'hour1', ms: 3_600_000 }, ws: '2hr', okx: '2H', hl: '2h', ms: 7_200_000 },
  '240': { rest: 'hour4', ws: '4hr', okx: '4H', hl: '4h', ms: 14_400_000 },
  '1D': { rest: 'day1', ws: 'day', okx: '1Dutc', hl: '1d', ms: 86_400_000 },
  '1W': { rest: 'week1', ws: 'week', okx: '1Wutc', hl: '1w', ms: 604_800_000, cal: 'week' },
  '1M': { rest: 'month1', ws: 'month', okx: '1Mutc', hl: '1M', ms: 2_592_000_000, cal: 'month' },
};
const TF_ALIAS: Record<string, string> = { D: '1D', W: '1W', M: '1M', '1d': '1D', '1w': '1W' };

function tfKey(timeframe: string): string {
  if (TF[timeframe]) return timeframe;
  return TF_ALIAS[timeframe] ?? TF_ALIAS[timeframe.toUpperCase()] ?? (TF[timeframe.toUpperCase()] ? timeframe.toUpperCase() : '60');
}
const tfMeta = (timeframe: string): TfMeta => TF[tfKey(timeframe)]!;

/** Bucket open time in LBank's UTC+8 calendar. */
export function bucketStart(t: number, meta: TfMeta): number {
  const s = t + H8;
  if (meta.cal === 'month') {
    const d = new Date(s);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - H8;
  }
  if (meta.cal === 'week') {
    const day = Math.floor(s / 86_400_000);
    const dow = (day + 4) % 7; // LBank weeks open Sunday 00:00 UTC+8 (1970-01-01 was a Thursday)
    return (day - dow) * 86_400_000 - H8;
  }
  return Math.floor(s / meta.ms) * meta.ms - H8;
}

/** Featured tickers listed first in search. */
const FEATURED = ['BTC', 'ETH', 'SOL', 'XLM', 'XAUT', 'DOGE', 'XRP', 'BNB', 'ADA', 'AVAX', 'LINK', 'INJ', 'SUI', 'HYPE'];
const COMMODITY = new Set(['GOLD', 'SILVER', 'XAUT', 'XPD', 'XPT', 'XTI', 'XBR', 'USO', 'XCU', 'COPPER', 'NATGAS']);
const FOREX = new Set(['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF']);

/* ------------------------------------------------------------------ tickers */

function bare(ticker: string): string {
  return ticker.replace(/^lbank:/i, '').toUpperCase();
}

function isPerp(ticker: string): boolean {
  const t = bare(ticker);
  return t.endsWith('.P') || t === 'GOLD' || t === 'GOLDUSDT' || t === 'XAU' || t === 'XAUUSDT';
}

function isGoldPerp(ticker: string): boolean {
  const t = bare(ticker);
  return ['GOLDUSDT.P', 'GOLDUSDT', 'GOLD', 'XAU', 'XAUUSDT', 'XAU-USDT-SWAP'].includes(t);
}

/** `BTCUSDT.P` → `BTCUSDT` (LBank perp symbol). */
function perpSymbol(ticker: string): string {
  if (isGoldPerp(ticker)) return 'GOLDUSDT';
  return bare(ticker).replace(/\.P$/, '');
}

function baseOf(ticker: string): string {
  return perpSymbol(ticker).replace(/_?(USDT|USDC)$/i, '').replace(/_.*/, '');
}

/** Display ticker → LBank spot pair (`BTCUSDT` → `btc_usdt`). */
function toSpotPair(ticker: string): string | null {
  const t = bare(ticker);
  if (t.endsWith('.P')) return null;
  if (t.includes('_')) return t.toLowerCase();
  const m = t.match(/^([A-Z0-9]+?)(USDT|USDC|BTC|ETH)$/);
  if (!m) return null;
  return `${m[1]!.toLowerCase()}_${m[2]!.toLowerCase()}`;
}

function canonicalTicker(ticker: string): string {
  if (isGoldPerp(ticker)) return 'GOLDUSDT.P';
  const t = bare(ticker);
  if (t.endsWith('.P')) return t;
  const pair = toSpotPair(t);
  return pair ? pair.replace('_', '').toUpperCase() : t;
}

/* -------------------------------------------------------------------- bars */

function sliceRange(bars: OHLCV[], range: BarRange): OHLCV[] {
  const to = range.to ?? Number.POSITIVE_INFINITY;
  const from = range.from ?? Number.NEGATIVE_INFINITY;
  let out = bars.filter((b) => b.time >= from && b.time <= to);
  if (range.limit != null && out.length > range.limit) out = out.slice(-range.limit);
  return out;
}

function mergeBars(a: OHLCV[], b: OHLCV[]): OHLCV[] {
  if (!a.length) return b.slice();
  if (!b.length) return a.slice();
  const map = new Map<number, OHLCV>();
  for (const bar of a) map.set(bar.time, bar);
  for (const bar of b) map.set(bar.time, bar);
  return [...map.values()].sort((x, y) => x.time - y.time).slice(-MAX_BARS);
}

function upsertBar(bars: OHLCV[], bar: OHLCV): void {
  const last = bars[bars.length - 1];
  if (!last || bar.time > last.time) {
    bars.push(bar);
    if (bars.length > MAX_BARS) bars.splice(0, bars.length - MAX_BARS);
  } else if (bar.time === last.time) {
    bars[bars.length - 1] = bar;
  } else {
    const i = bars.findIndex((b) => b.time === bar.time);
    if (i >= 0) bars[i] = bar;
  }
}

/** Fold a trade price (and optional traded volume) into the forming bar. */
function applyTick(bars: OHLCV[], price: number, volume: number | undefined, meta: TfMeta, now = Date.now()): OHLCV {
  const openTime = bucketStart(now, meta);
  const last = bars[bars.length - 1];
  if (!last || last.time < openTime) {
    const bar: OHLCV = { time: openTime, open: last?.close ?? price, high: price, low: price, close: price, volume: volume ?? 0 };
    bar.high = Math.max(bar.high, bar.open);
    bar.low = Math.min(bar.low, bar.open);
    bars.push(bar);
    if (bars.length > MAX_BARS) bars.splice(0, bars.length - MAX_BARS);
    return bar;
  }
  last.high = Math.max(last.high, price);
  last.low = Math.min(last.low, price);
  last.close = price;
  if (volume != null && volume > 0) last.volume = (last.volume ?? 0) + volume;
  return last;
}

/** Roll finer bars into `meta` buckets (2h from 1h). */
function aggregate(bars: OHLCV[], meta: TfMeta): OHLCV[] {
  const out: OHLCV[] = [];
  for (const b of bars) {
    const t = bucketStart(b.time, meta);
    const last = out[out.length - 1];
    if (!last || last.time !== t) {
      out.push({ ...b, time: t });
    } else {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume = (last.volume ?? 0) + (b.volume ?? 0);
    }
  }
  return out;
}

/* --------------------------------------------------------------- REST: spot */

function parseLbankRow(row: unknown): OHLCV | null {
  if (!Array.isArray(row) || row.length < 5) return null;
  const raw = Number(row[0]);
  const time = raw < 1e12 ? raw * 1000 : raw;
  const [open, high, low, close, volume] = [1, 2, 3, 4, 5].map((i) => Number(row[i]));
  if (![time, open, high, low, close].every(Number.isFinite)) return null;
  return { time, open: open!, high: high!, low: low!, close: close!, volume: Number.isFinite(volume) ? volume! : 0 };
}

async function fetchSpotKlinePage(pair: string, type: string, timeSec: number, size = PAGE): Promise<OHLCV[]> {
  const qs = new URLSearchParams({ symbol: pair, size: String(size), type, time: String(timeSec) });
  const res = await fetch(`${SPOT}/v2/kline.do?${qs}`);
  if (!res.ok) throw new Error(`LBank kline ${res.status}`);
  const json = (await res.json()) as { result?: string | boolean; data?: unknown[]; msg?: string };
  if (json.result === 'false' || json.result === false) throw new Error(json.msg || 'LBank kline failed');
  const bars: OHLCV[] = [];
  for (const row of json.data ?? []) {
    const b = parseLbankRow(row);
    if (b) bars.push(b);
  }
  return bars.sort((a, b) => a.time - b.time);
}

/** Spot klines over [from, to], paged forward (LBank's `time` is the START of a page). */
async function fetchSpotRange(pair: string, timeframe: string, from: number, to: number): Promise<OHLCV[]> {
  const meta = tfMeta(timeframe);
  const type = meta.rest ?? meta.build!.rest;
  let cursor = Math.floor(from / 1000);
  let all: OHLCV[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const bars = await fetchSpotKlinePage(pair, type, cursor);
    if (!bars.length) break;
    all = mergeBars(all, bars);
    const last = bars[bars.length - 1]!.time;
    if (bars.length < PAGE || last >= to) break;
    cursor = Math.floor(last / 1000) + 1;
  }
  return meta.rest ? all : aggregate(all, meta);
}

type SpotQuote = { price: number; changePct: number; high?: number; low?: number; vol?: number };

async function fetchSpotTicker(pair: string): Promise<SpotQuote | null> {
  try {
    const res = await fetch(`${SPOT}/v2/ticker/24hr.do?symbol=${encodeURIComponent(pair)}`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Array<{ ticker?: { latest?: string; change?: string; high?: string; low?: string; vol?: string } }>;
    };
    const t = json.data?.[0]?.ticker;
    const price = Number(t?.latest);
    if (!Number.isFinite(price) || price <= 0) return null;
    const changePct = Number(t?.change);
    return { price, changePct: Number.isFinite(changePct) ? changePct : 0, high: Number(t?.high), low: Number(t?.low), vol: Number(t?.vol) };
  } catch {
    return null;
  }
}

/* --------------------------------------------------- REST: perp history */

async function fetchOkxGold(timeframe: string, from: number): Promise<OHLCV[]> {
  const meta = tfMeta(timeframe);
  let after: number | undefined;
  let all: OHLCV[] = [];
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ instId: 'XAU-USDT-SWAP', bar: meta.okx, limit: '100' });
    if (after != null) qs.set('after', String(after));
    const res = await fetch(`${OKX}/api/v5/market/history-candles?${qs}`);
    if (!res.ok) throw new Error(`OKX history ${res.status}`);
    const json = (await res.json()) as { code?: string; data?: string[][] };
    if (json.code && json.code !== '0') throw new Error(`OKX ${json.code}`);
    const rows = json.data ?? [];
    if (!rows.length) break;
    const bars = rows
      .map((r) => ({ time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) || 0 }))
      .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close));
    all = mergeBars(bars, all);
    after = Number(rows[rows.length - 1]![0]);
    if (rows.length < 100 || after <= from) break;
  }
  // OKX buckets daily+ at 00:00 UTC; re-bucket onto LBank's UTC+8 calendar for D/W/M.
  return meta.ms >= 86_400_000 ? aggregate(all, meta) : all;
}

async function fetchHlCandles(coin: string, timeframe: string, from: number): Promise<OHLCV[]> {
  const meta = tfMeta(timeframe);
  const res = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: meta.hl, startTime: from } }),
  });
  if (!res.ok) throw new Error(`HL ${coin} ${res.status}`);
  const rows = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
  if (!Array.isArray(rows)) return [];
  const bars = rows
    .map((r) => ({ time: r.t, open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v) || 0 }))
    .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close))
    .sort((a, b) => a.time - b.time);
  return meta.ms >= 86_400_000 ? aggregate(bars, meta) : bars;
}

/** Where a perp's history comes from (shown in its description). */
async function perpHistorySource(ticker: string): Promise<'gold' | 'spot' | 'hl'> {
  if (isGoldPerp(ticker)) return 'gold';
  const spot = await spotPairs();
  return spot.has(`${baseOf(ticker).toLowerCase()}_usdt`) ? 'spot' : 'hl';
}

async function fetchPerpRange(ticker: string, timeframe: string, from: number, to: number): Promise<OHLCV[]> {
  const src = await perpHistorySource(ticker);
  const base = baseOf(ticker);
  if (src === 'gold') {
    try {
      const bars = await fetchOkxGold(timeframe, from);
      if (bars.length) return bars;
    } catch (err) {
      console.warn('[lbank] OKX gold history failed, using Hyperliquid xyz:GOLD', err);
    }
    return fetchHlCandles('xyz:GOLD', timeframe, from);
  }
  if (src === 'spot') return fetchSpotRange(`${base.toLowerCase()}_usdt`, timeframe, from, to);
  for (const coin of [base, `xyz:${base}`]) {
    try {
      const bars = await fetchHlCandles(coin, timeframe, from);
      if (bars.length) return bars;
    } catch {
      /* try next */
    }
  }
  console.warn(`[lbank] no history source for ${ticker}; live bars only`);
  return [];
}

/* --------------------------------------------------- perp live (shared poll) */

type PerpRow = { price: number; open24: number; high24: number; low24: number; vol24: number; at: number };
const perpRows = new Map<string, PerpRow>();
const perpListeners = new Set<() => void>();
let perpTimer: ReturnType<typeof setInterval> | null = null;
let perpInflight: Promise<void> | null = null;
let perpUniverse: Array<{ symbol: string; base: string }> | null = null;

async function pollPerps(): Promise<void> {
  if (perpInflight) return perpInflight;
  perpInflight = (async () => {
    try {
      const res = await fetch(`${PERP}/cfd/openApi/v1/pub/marketData?productGroup=SwapU`);
      if (!res.ok) return;
      const json = (await res.json()) as {
        data?: Array<{ symbol?: string; lastPrice?: string; openPrice?: string; highestPrice?: string; lowestPrice?: string; volume?: string }>;
      };
      const now = Date.now();
      for (const r of json.data ?? []) {
        const price = Number(r.lastPrice);
        if (!r.symbol || !Number.isFinite(price) || price <= 0) continue;
        perpRows.set(r.symbol, {
          price,
          open24: Number(r.openPrice),
          high24: Number(r.highestPrice),
          low24: Number(r.lowestPrice),
          vol24: Number(r.volume),
          at: now,
        });
      }
      for (const fn of perpListeners) fn();
    } catch {
      /* next poll */
    } finally {
      perpInflight = null;
    }
  })();
  return perpInflight;
}

function onPerpTick(fn: () => void): Unsubscribe {
  perpListeners.add(fn);
  if (!perpTimer) {
    void pollPerps();
    perpTimer = setInterval(() => void pollPerps(), 1_000);
  }
  return () => {
    perpListeners.delete(fn);
    if (!perpListeners.size && perpTimer) {
      clearInterval(perpTimer);
      perpTimer = null;
    }
  };
}

async function loadPerpUniverse(): Promise<Array<{ symbol: string; base: string }>> {
  if (perpUniverse) return perpUniverse;
  try {
    const res = await fetch(`${PERP}/cfd/openApi/v1/pub/instrument?productGroup=SwapU`);
    const json = (await res.json()) as { data?: Array<{ symbol?: string; baseCurrency?: string; needSuspend?: number }> };
    perpUniverse = (json.data ?? [])
      .filter((r) => r.symbol && r.symbol.endsWith('USDT') && !r.needSuspend)
      .map((r) => ({ symbol: r.symbol!, base: (r.baseCurrency || r.symbol!.replace(/USDT$/, '')).toUpperCase() }));
  } catch (err) {
    console.warn('[lbank] perp instruments failed', err);
    perpUniverse = [{ symbol: 'GOLDUSDT', base: 'GOLD' }];
  }
  return perpUniverse;
}

/* ------------------------------------------------------- spot live (socket) */

type KbarMsg = { t: string; o: number; h: number; l: number; c: number; v: number; slot: string };
type TickMsg = { latest: number; change: number; high: number; low: number; vol: number };
type SocketListener = (data: unknown) => void;

/** One shared LBank V2 socket; subscriptions are reference-counted and replayed on reconnect. */
class LbankSocket {
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, { msg: Record<string, string>; fns: Set<SocketListener> }>();
  private readonly urls: string[];
  private urlIdx = 0;
  private retry = 0;
  private gotMessage = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  lastMessageAt = 0;

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.urls = ['wss://www.lbkex.net/ws/V2/', `${proto}://${location.host}/lbank-ws/ws/V2/`];
  }

  subscribe(kind: 'kbar' | 'tick', pair: string, slot: string | undefined, fn: SocketListener): Unsubscribe {
    const key = kind === 'kbar' ? `kbar:${pair}:${slot}` : `tick:${pair}`;
    let sub = this.subs.get(key);
    if (!sub) {
      const msg: Record<string, string> = { action: 'subscribe', subscribe: kind, pair };
      if (kind === 'kbar' && slot) msg.kbar = slot;
      sub = { msg, fns: new Set() };
      this.subs.set(key, sub);
      this.send(msg);
    }
    sub.fns.add(fn);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.ensure();
    return () => {
      const s = this.subs.get(key);
      if (!s) return;
      s.fns.delete(fn);
      if (s.fns.size) return;
      this.subs.delete(key);
      this.send({ ...s.msg, action: 'unsubscribe' });
      if (!this.subs.size) this.idleTimer = setTimeout(() => this.close(), 30_000);
    };
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ensure(): void {
    if (this.ws || this.reconnectTimer) return;
    const url = this.urls[this.urlIdx % this.urls.length]!;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect(true);
      return;
    }
    this.ws = ws;
    this.gotMessage = false;
    ws.onopen = () => {
      for (const s of this.subs.values()) ws.send(JSON.stringify(s.msg));
    };
    ws.onmessage = (e) => {
      this.lastMessageAt = Date.now();
      this.gotMessage = true;
      this.retry = 0;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(e.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (m.action === 'ping') {
        ws.send(JSON.stringify({ action: 'pong', pong: m.ping }));
        return;
      }
      const pair = m.pair as string | undefined;
      if (!pair) return;
      if (m.type === 'kbar' && m.kbar) {
        const k = m.kbar as KbarMsg;
        this.subs.get(`kbar:${pair}:${k.slot}`)?.fns.forEach((fn) => fn(k));
      } else if (m.type === 'tick' && m.tick) {
        this.subs.get(`tick:${pair}`)?.fns.forEach((fn) => fn(m.tick));
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.subs.size) this.scheduleReconnect(!this.gotMessage);
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(switchUrl: boolean): void {
    if (this.reconnectTimer) return;
    if (switchUrl) this.urlIdx++;
    const delay = Math.min(1_000 * 2 ** this.retry++, 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subs.size) this.ensure();
    }, delay);
  }

  private close(): void {
    this.idleTimer = null;
    if (this.subs.size) return;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

let socket: LbankSocket | null = null;
const lbankSocket = (): LbankSocket => (socket ??= new LbankSocket());

const kbarTime = (t: string): number => Date.parse(`${t}+08:00`);

/* ------------------------------------------------------------- spot quotes */

const spotQuotes = new Map<string, SpotQuote & { at: number }>();
const spotQuoteSubs = new Map<string, Unsubscribe>();

function watchSpotQuote(pair: string): void {
  if (spotQuoteSubs.has(pair)) return;
  spotQuoteSubs.set(
    pair,
    lbankSocket().subscribe('tick', pair, undefined, (d) => {
      const t = d as TickMsg;
      if (!(t.latest > 0)) return;
      spotQuotes.set(pair, { price: t.latest, changePct: t.change, high: t.high, low: t.low, vol: t.vol, at: Date.now() });
    }),
  );
}

/* --------------------------------------------------------------- symbols */

let pairsPromise: Promise<Set<string>> | null = null;

function spotPairs(): Promise<Set<string>> {
  pairsPromise ??= (async () => {
    try {
      const res = await fetch(`${SPOT}/v2/currencyPairs.do`);
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { data?: string[] };
      return new Set((json.data ?? []).filter((p) => typeof p === 'string'));
    } catch (err) {
      console.warn('[lbank] currencyPairs failed', err);
      pairsPromise = null;
      return new Set(FEATURED.map((b) => `${b.toLowerCase()}_usdt`));
    }
  })();
  return pairsPromise;
}

function typeFor(base: string): string {
  if (COMMODITY.has(base)) return 'commodity';
  if (FOREX.has(base)) return 'forex';
  return 'crypto';
}

const featuredRank = (base: string): number => {
  const i = FEATURED.indexOf(base);
  return i < 0 ? FEATURED.length : i;
};

async function buildDescriptors(): Promise<SymbolDescriptor[]> {
  const [pairs, perps] = await Promise.all([spotPairs(), loadPerpUniverse()]);
  const spot = [...pairs]
    .filter((p) => p.endsWith('_usdt') && !/\d[ls]_usdt$/i.test(p))
    .map((p) => p.replace('_usdt', '').toUpperCase());
  const rows: Array<SymbolDescriptor & { _rank: number }> = [];
  for (const p of perps) {
    const ticker = p.symbol === 'GOLDUSDT' ? 'GOLDUSDT.P' : `${p.symbol}.P`;
    rows.push({
      ticker,
      description: `${p.base} / USDT Perpetual · LBank`,
      type: typeFor(p.base),
      _rank: featuredRank(p.base) * 2,
    });
  }
  for (const base of spot) {
    rows.push({
      ticker: `${base}USDT`,
      description: `${base} / USDT · LBank spot`,
      type: typeFor(base),
      _rank: featuredRank(base) * 2 + 1,
    });
  }
  rows.sort((a, b) => a._rank - b._rank || a.ticker.length - b.ticker.length || a.ticker.localeCompare(b.ticker));
  return rows.map(({ _rank, ...d }) => d);
}

/* ----------------------------------------------------------------- provider */

const mem = new Map<string, OHLCV[]>();
const inflight = new Map<string, Promise<OHLCV[]>>();
const cacheKey = (ticker: string, timeframe: string): string => `lbank2:${ticker}:${tfKey(timeframe)}`;

export class LBankProvider implements DataProvider {
  info(): ProviderInfo {
    return {
      name: 'lbank',
      displayName: 'LBank',
      supportedTimeframes: Object.keys(TF),
      capabilities: { enumerate: true, stream: true, symbolInfo: true },
    };
  }

  async listSymbols(): Promise<SymbolDescriptor[]> {
    return buildDescriptors();
  }

  resolveSymbolIcon(symbol: SymbolDescriptor): string | undefined {
    const base = baseOf(symbol.ticker);
    if (base === 'GOLD' || base === 'XAUT') return 'https://crypto-icons.ledger.com/PAXG.png';
    if (typeFor(base) !== 'crypto') return undefined;
    return `https://crypto-icons.ledger.com/${encodeURIComponent(base)}.png`;
  }

  async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
    const canon = canonicalTicker(ticker);
    if (!isPerp(canon) && !toSpotPair(canon)) return undefined;
    return {
      ticker: canon,
      timezone: 'Etc/UTC',
      session: '24x7',
      timeframes: { finest: '1', default: '60', list: Object.keys(TF) },
      volume: true,
    };
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
    const canon = canonicalTicker(ticker);
    const meta = tfMeta(timeframe);
    const key = cacheKey(canon, timeframe);
    const bars = (): OHLCV[] => {
      let b = mem.get(key);
      if (!b) mem.set(key, (b = []));
      return b;
    };

    if (isPerp(canon)) {
      const sym = perpSymbol(canon);
      let lastVol: number | undefined;
      return onPerpTick(() => {
        const row = perpRows.get(sym);
        if (!row) return;
        // Volume traded since the previous poll (24h counter growth; a reset reads as 0).
        const dv = lastVol != null && row.vol24 >= lastVol ? row.vol24 - lastVol : 0;
        lastVol = row.vol24;
        onBar({ ...applyTick(bars(), row.price, dv, meta) });
      });
    }

    const pair = toSpotPair(canon);
    if (!pair) return () => undefined;
    let lastKbarAt = 0;
    let stopped = false;
    const offKbar = lbankSocket().subscribe('kbar', pair, meta.ws, (d) => {
      const k = d as KbarMsg;
      const time = kbarTime(k.t);
      if (!Number.isFinite(time)) return;
      lastKbarAt = Date.now();
      const bar: OHLCV = { time, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
      upsertBar(bars(), bar);
      onBar({ ...bar });
    });
    // Between kbar pushes (they only come when a trade prints), fold the faster
    // tick stream into the forming candle so the price moves like TradingView's.
    const offTick = lbankSocket().subscribe('tick', pair, undefined, (d) => {
      const t = d as TickMsg;
      if (!(t.latest > 0)) return;
      const b = bars();
      const last = b[b.length - 1];
      if (last && last.close === t.latest && last.time === bucketStart(Date.now(), meta)) return;
      onBar({ ...applyTick(b, t.latest, undefined, meta) });
    });
    // First paint of the live price without waiting for the socket handshake.
    void fetchSpotTicker(pair).then((q) => {
      if (q && !stopped && !lastKbarAt) onBar({ ...applyTick(bars(), q.price, undefined, meta) });
    });
    // Fallback while the socket is down or silent: poll the REST ticker.
    const fallback = setInterval(async () => {
      if (stopped || Date.now() - lastKbarAt < 6_000) return;
      const q = await fetchSpotTicker(pair);
      if (!q || stopped || Date.now() - lastKbarAt < 6_000) return;
      onBar({ ...applyTick(bars(), q.price, undefined, meta) });
    }, 2_000);
    return () => {
      stopped = true;
      clearInterval(fallback);
      offKbar();
      offTick();
    };
  }

  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    const canon = canonicalTicker(ticker);
    if (!isPerp(canon) && !toSpotPair(canon)) return [];
    const meta = tfMeta(timeframe);
    const key = cacheKey(canon, timeframe);
    const to = Math.min(range.to ?? Date.now(), Date.now());
    const limit = Math.min(range.limit ?? 1_500, 5_000);
    const from = range.from ?? to - limit * meta.ms;

    let have = mem.get(key);
    if (!have?.length) {
      const disk = await loadHistory(key);
      if (disk?.length) mem.set(key, (have = disk));
    }

    const covered = (b: OHLCV[] | undefined): boolean =>
      !!b?.length && b[0]!.time <= from + meta.ms && b[b.length - 1]!.time >= bucketStart(to, meta) - meta.ms;
    if (covered(have)) return sliceRange(have!, { ...range, to });

    const pending = inflight.get(key);
    if (pending) return sliceRange(await pending, { ...range, to });

    const task = (async () => {
      const prior = mem.get(key) ?? [];
      // Only fetch what is missing: the head before the cache and/or the tail after it.
      const needHead = !prior.length || prior[0]!.time > from + meta.ms;
      const fetchFrom = needHead ? from : prior[prior.length - 1]!.time;
      const fresh = isPerp(canon)
        ? await fetchPerpRange(canon, timeframe, fetchFrom, to)
        : await fetchSpotRange(toSpotPair(canon)!, timeframe, fetchFrom, to);
      let merged = mergeBars(prior, fresh);
      if (needHead && prior.length && fresh.length && fresh[fresh.length - 1]!.time < prior[0]!.time - meta.ms) {
        // A gap between the new head and the cache: refetch the tail so nothing is missing.
        const tail = isPerp(canon)
          ? await fetchPerpRange(canon, timeframe, fresh[fresh.length - 1]!.time, to)
          : await fetchSpotRange(toSpotPair(canon)!, timeframe, fresh[fresh.length - 1]!.time, to);
        merged = mergeBars(merged, tail);
      }
      // Perp tip: put LBank's own last price on the forming bar.
      if (isPerp(canon)) {
        await pollPerps();
        const row = perpRows.get(perpSymbol(canon));
        if (row) applyTick(merged, row.price, undefined, meta);
      }
      mem.set(key, merged);
      void saveHistory(key, merged);
      return merged;
    })();

    inflight.set(key, task);
    try {
      return sliceRange(await task, { ...range, to });
    } finally {
      inflight.delete(key);
    }
  }
}

/* ------------------------------------------------------ watchlist quotes */

export type LbankQuote = { price: number; changePct: number; high?: number; low?: number };

/** Live quote for any LBank symbol (socket / shared perp poll; REST only on a cold start). */
export async function fetchLbankQuote(symbol: string): Promise<LbankQuote | null> {
  const canon = canonicalTicker(symbol);
  if (isPerp(canon)) {
    const sym = perpSymbol(canon);
    let row = perpRows.get(sym);
    if (!row || Date.now() - row.at > 1_500) {
      await pollPerps();
      row = perpRows.get(sym);
    }
    if (!row) return null;
    const changePct = row.open24 > 0 ? ((row.price - row.open24) / row.open24) * 100 : 0;
    return { price: row.price, changePct, high: row.high24, low: row.low24 };
  }
  const pair = toSpotPair(canon);
  if (!pair) return null;
  watchSpotQuote(pair);
  const q = spotQuotes.get(pair);
  if (q && Date.now() - q.at < 5_000) return q;
  return fetchSpotTicker(pair);
}

/** Which source the perp's history comes from — for watchlist / details hints. */
export async function lbankHistoryNote(symbol: string): Promise<string> {
  const canon = canonicalTicker(symbol);
  if (!isPerp(canon)) return 'LBank spot';
  const src = await perpHistorySource(canon);
  return src === 'spot' ? 'LBank perp · spot history' : src === 'gold' ? 'LBank perp · OKX/HL history' : 'LBank perp · HL history';
}
