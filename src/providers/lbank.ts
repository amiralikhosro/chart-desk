/**
 * LBank provider
 * - Spot pairs: real LBank klines + ticker via /lbank-api proxy
 * - GOLDUSDT.P: OKX/HL history + LBank perp lastPrice via /lbank-perp
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
const PAGES_PER_CALL = 6;
const TIP_FRESH_MS = 12_000;

/** Vela TF → LBank type + OKX bar + ms */
const TF: Record<string, { lbank: string; okx: string; ms: number }> = {
  '1': { lbank: 'minute1', okx: '1m', ms: 60_000 },
  '5': { lbank: 'minute5', okx: '5m', ms: 300_000 },
  '15': { lbank: 'minute15', okx: '15m', ms: 900_000 },
  '30': { lbank: 'minute30', okx: '30m', ms: 1_800_000 },
  '60': { lbank: 'hour1', okx: '1H', ms: 3_600_000 },
  // LBank has no native 2h kline — serve 1h bars (tip still advances on 2h open)
  '120': { lbank: 'hour1', okx: '2H', ms: 7_200_000 },
  '240': { lbank: 'hour4', okx: '4H', ms: 14_400_000 },
  '1D': { lbank: 'day1', okx: '1D', ms: 86_400_000 },
  D: { lbank: 'day1', okx: '1D', ms: 86_400_000 },
  '1W': { lbank: 'week1', okx: '1W', ms: 604_800_000 },
  W: { lbank: 'week1', okx: '1W', ms: 604_800_000 },
  '1M': { lbank: 'month1', okx: '1M', ms: 2_592_000_000 },
  M: { lbank: 'month1', okx: '1M', ms: 2_592_000_000 },
};

const HL_INTERVAL: Record<string, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '60': '1h',
  '120': '2h',
  '240': '4h',
  '1D': '1d',
  D: '1d',
  '1W': '1w',
  W: '1w',
  '1M': '1M',
  M: '1M',
};

/** Featured spot tickers always listed first in search. */
const FEATURED_SPOT = [
  'XAUTUSDT',
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XLMUSDT',
  'DOGEUSDT',
  'BNBUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
];

function tfMeta(timeframe: string) {
  return TF[timeframe] ?? TF[timeframe.toUpperCase()] ?? TF['60']!;
}

function cacheKey(ticker: string, timeframe: string): string {
  return `lbank:${ticker}:${timeframe}`;
}

/** Display ticker → LBank spot pair (`BTCUSDT` → `btc_usdt`). */
function toSpotPair(ticker: string): string | null {
  const t = ticker.replace(/^lbank:/i, '').toUpperCase();
  if (t.endsWith('.P') || t === 'GOLD' || t === 'GOLDUSDT') return null;
  // Already pair form
  if (t.includes('_')) return t.toLowerCase();
  const m = t.match(/^([A-Z0-9]+)(USDT|USDC|BTC|ETH)$/);
  if (!m) return null;
  return `${m[1]!.toLowerCase()}_${m[2]!.toLowerCase()}`;
}

function toDisplayTicker(pair: string): string {
  return pair.replace('_', '').toUpperCase();
}

function isGoldPerp(ticker: string): boolean {
  const t = ticker.replace(/^lbank:/i, '').toUpperCase();
  return (
    t === 'GOLDUSDT.P' ||
    t === 'GOLDUSDT' ||
    t === 'GOLD' ||
    t === 'XAU' ||
    t === 'XAUUSDT' ||
    t === 'XAU-USDT-SWAP'
  );
}

function canonicalTicker(ticker: string): string {
  if (isGoldPerp(ticker)) return 'GOLDUSDT.P';
  const pair = toSpotPair(ticker);
  return pair ? toDisplayTicker(pair) : ticker.replace(/^lbank:/i, '').toUpperCase();
}

function sliceRange(bars: OHLCV[], range: BarRange): OHLCV[] {
  const to = range.to ?? Number.POSITIVE_INFINITY;
  const from = range.from ?? Number.NEGATIVE_INFINITY;
  let out = bars.filter((b) => b.time >= from && b.time <= to);
  if (range.limit != null && out.length > range.limit) out = out.slice(-range.limit);
  return out;
}

function mergeBars(a: OHLCV[], b: OHLCV[]): OHLCV[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const map = new Map<number, OHLCV>();
  for (const bar of a) map.set(bar.time, bar);
  for (const bar of b) map.set(bar.time, bar);
  return [...map.values()].sort((x, y) => x.time - y.time).slice(-12_000);
}

function applyTick(
  bars: OHLCV[],
  price: number,
  volume: number | undefined,
  barMs: number,
  now = Date.now(),
): OHLCV {
  const openTime = Math.floor(now / barMs) * barMs;
  const last = bars[bars.length - 1];
  if (!last || last.time < openTime) {
    const bar: OHLCV = {
      time: openTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: volume ?? 0,
    };
    bars.push(bar);
    if (bars.length > 12_000) bars.splice(0, bars.length - 12_000);
    return bar;
  }
  last.high = Math.max(last.high, price);
  last.low = Math.min(last.low, price);
  last.close = price;
  if (volume != null) last.volume = (last.volume ?? 0) + volume;
  return last;
}

/** LBank kline row: [timeSec, open, high, low, close, volume] */
function parseLbankRow(row: unknown): OHLCV | null {
  if (!Array.isArray(row) || row.length < 5) return null;
  const time = Number(row[0]) * (Number(row[0]) < 1e12 ? 1000 : 1);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  if (![time, open, high, low, close].every(Number.isFinite)) return null;
  return { time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

async function fetchSpotKlinePage(
  pair: string,
  type: string,
  timeSec: number,
  size = 100,
): Promise<OHLCV[]> {
  const qs = new URLSearchParams({
    symbol: pair,
    size: String(size),
    type,
    time: String(timeSec),
  });
  const res = await fetch(`${SPOT}/v2/kline.do?${qs}`);
  if (!res.ok) throw new Error(`LBank kline ${res.status}`);
  const json = (await res.json()) as { result?: string; data?: unknown[]; msg?: string };
  if (json.result === 'false') throw new Error(json.msg || 'LBank kline failed');
  const bars: OHLCV[] = [];
  for (const row of json.data ?? []) {
    const b = parseLbankRow(row);
    if (b) bars.push(b);
  }
  return bars.sort((a, b) => a.time - b.time);
}

async function fetchSpotHistory(pair: string, timeframe: string, limit: number): Promise<OHLCV[]> {
  const { lbank, ms } = tfMeta(timeframe);
  const want = Math.min(Math.max(limit, 100), 5_000);
  let cursorSec = Math.floor((Date.now() - want * ms) / 1000);
  let all: OHLCV[] = [];
  for (let page = 0; page < PAGES_PER_CALL; page++) {
    let bars: OHLCV[];
    try {
      bars = await fetchSpotKlinePage(pair, lbank, cursorSec, 100);
    } catch {
      // hour2 may be unsupported — fall back to hour1 aggregation not worth it; break
      if (lbank === 'hour2') {
        bars = await fetchSpotKlinePage(pair, 'hour1', cursorSec, 100);
      } else {
        break;
      }
    }
    if (!bars.length) break;
    all = mergeBars(all, bars);
    cursorSec = Math.floor(bars[0]!.time / 1000) - Math.floor(ms / 1000);
    if (all.length >= want || bars.length < 50) break;
  }
  return all.slice(-want);
}

async function fetchSpotTicker(
  pair: string,
): Promise<{ price: number; changePct: number } | null> {
  try {
    const res = await fetch(`${SPOT}/v2/ticker/24hr.do?symbol=${encodeURIComponent(pair)}`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Array<{ ticker?: { latest?: string; change?: string } }>;
    };
    const t = json.data?.[0]?.ticker;
    const price = Number(t?.latest);
    const changePct = Number(t?.change);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      price,
      changePct: Number.isFinite(changePct) ? changePct : 0,
    };
  } catch {
    return null;
  }
}

function parseOkxRow(row: string[]): OHLCV | null {
  const time = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  if (![time, open, high, low, close].every(Number.isFinite)) return null;
  return { time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

async function fetchOkxPage(bar: string, after?: number): Promise<{ bars: OHLCV[]; oldest?: number }> {
  const qs = new URLSearchParams({ instId: 'XAU-USDT-SWAP', bar, limit: '100' });
  if (after != null) qs.set('after', String(after));
  const res = await fetch(`${OKX}/api/v5/market/history-candles?${qs}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`OKX history ${res.status}`);
  const json = (await res.json()) as { code?: string; data?: string[][] };
  if (json.code && json.code !== '0') throw new Error(`OKX ${json.code}`);
  const rows = json.data ?? [];
  const bars: OHLCV[] = [];
  for (const row of rows) {
    const b = parseOkxRow(row);
    if (b) bars.push(b);
  }
  bars.sort((a, b) => a.time - b.time);
  const oldest = rows.length ? Number(rows[rows.length - 1]![0]) : undefined;
  return { bars, oldest };
}

async function fetchOkxHistory(timeframe: string, limit: number): Promise<OHLCV[]> {
  const { okx } = tfMeta(timeframe);
  const want = Math.min(Math.max(limit, 100), 5_000);
  let after: number | undefined;
  let all: OHLCV[] = [];
  for (let page = 0; page < 50 && all.length < want; page++) {
    const { bars, oldest } = await fetchOkxPage(okx, after);
    if (!bars.length || oldest == null) break;
    all = mergeBars(bars, all);
    after = oldest;
    if (bars.length < 100) break;
  }
  return all.slice(-want);
}

async function fetchHlGoldHistory(timeframe: string, limit: number): Promise<OHLCV[]> {
  const { ms } = tfMeta(timeframe);
  const interval = HL_INTERVAL[timeframe] ?? HL_INTERVAL[timeframe.toUpperCase()] ?? '1h';
  const want = Math.min(Math.max(limit, 100), 5_000);
  const startTime = Date.now() - want * ms;
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: { coin: 'xyz:GOLD', interval, startTime },
    }),
  });
  if (!res.ok) throw new Error(`HL gold history ${res.status}`);
  const rows = (await res.json()) as Array<{
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
  }>;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => ({
      time: r.t,
      open: Number(r.o),
      high: Number(r.h),
      low: Number(r.l),
      close: Number(r.c),
      volume: Number(r.v) || 0,
    }))
    .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close))
    .sort((a, b) => a.time - b.time)
    .slice(-want);
}

async function fetchGoldHistory(timeframe: string, limit: number): Promise<OHLCV[]> {
  try {
    const bars = await fetchOkxHistory(timeframe, limit);
    if (bars.length) return bars;
  } catch (err) {
    console.warn('[lbank] OKX history failed, trying HL xyz:GOLD', err);
  }
  return fetchHlGoldHistory(timeframe, limit);
}

async function fetchLbankGoldLast(): Promise<{ price: number; open24?: number } | null> {
  try {
    const res = await fetch(`${PERP}/cfd/openApi/v1/pub/marketData?productGroup=SwapU`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Array<{ symbol?: string; lastPrice?: string; openPrice?: string }>;
    };
    const row = (json.data ?? []).find((r) => r.symbol === 'GOLDUSDT');
    if (!row) return null;
    const price = Number(row.lastPrice);
    const open24 = Number(row.openPrice);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { price, open24: Number.isFinite(open24) ? open24 : undefined };
  } catch {
    return null;
  }
}

const mem = new Map<string, { bars: OHLCV[]; at: number }>();
const inflight = new Map<string, Promise<OHLCV[]>>();
let pairsCache: SymbolDescriptor[] | null = null;

async function loadSpotDescriptors(): Promise<SymbolDescriptor[]> {
  if (pairsCache) return pairsCache;
  try {
    const res = await fetch(`${SPOT}/v2/currencyPairs.do`);
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as { data?: string[] };
    const pairs = (json.data ?? []).filter((p) => typeof p === 'string');
    const usdt = pairs.filter((p) => {
      if (!p.endsWith('_usdt')) return false;
      // Skip leveraged tokens
      if (/\d[ls]_usdt$/i.test(p)) return false;
      return true;
    });
    const featured = new Set(FEATURED_SPOT);
    const descs: SymbolDescriptor[] = [];
    // Featured first
    for (const tick of FEATURED_SPOT) {
      const pair = toSpotPair(tick);
      if (pair && usdt.includes(pair)) {
        descs.push({
          ticker: tick,
          description: `${tick.replace(/USDT$/, '')} / USDT · LBank spot`,
          type: 'crypto',
        });
      }
    }
    for (const pair of usdt.sort()) {
      const tick = toDisplayTicker(pair);
      if (featured.has(tick)) continue;
      descs.push({
        ticker: tick,
        description: `${tick.replace(/USDT$/, '')} / USDT · LBank spot`,
        type: 'crypto',
      });
    }
    pairsCache = descs;
    return descs;
  } catch (err) {
    console.warn('[lbank] currencyPairs failed', err);
    return FEATURED_SPOT.map((tick) => ({
      ticker: tick,
      description: `${tick} · LBank spot`,
      type: 'crypto',
    }));
  }
}

export class LBankProvider implements DataProvider {
  info(): ProviderInfo {
    return {
      name: 'lbank',
      displayName: 'LBank',
      supportedTimeframes: ['1', '5', '15', '30', '60', '120', '240', '1D', '1W', '1M'],
      capabilities: { enumerate: true, stream: true, symbolInfo: true },
    };
  }

  async listSymbols(): Promise<SymbolDescriptor[]> {
    const spot = await loadSpotDescriptors();
    return [
      {
        ticker: 'GOLDUSDT.P',
        description: 'Gold USDT-M perp · LBank (OKX/HL history)',
        type: 'crypto',
      },
      ...spot,
    ];
  }

  async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
    const canon = canonicalTicker(ticker);
    if (isGoldPerp(ticker) || toSpotPair(canon)) {
      return {
        ticker: canon,
        timezone: 'Etc/UTC',
        session: '24x7',
        timeframes: {
          finest: '1',
          default: '60',
          list: ['1', '5', '15', '30', '60', '120', '240', '1D', '1W', '1M'],
        },
        volume: true,
      };
    }
    return undefined;
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
    const canon = canonicalTicker(ticker);
    const key = cacheKey(canon, timeframe);
    const { ms } = tfMeta(timeframe);
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      let price: number | undefined;
      if (isGoldPerp(canon)) {
        price = (await fetchLbankGoldLast())?.price;
      } else {
        const pair = toSpotPair(canon);
        if (!pair) return;
        price = (await fetchSpotTicker(pair))?.price;
      }
      if (price == null || stopped) return;
      let hit = mem.get(key);
      if (!hit) {
        hit = { bars: [], at: Date.now() };
        mem.set(key, hit);
      }
      if (!hit.bars.length) {
        try {
          const seeded = await this.getBars(canon, timeframe, { limit: 200 });
          hit.bars = [...seeded];
        } catch {
          /* empty */
        }
      }
      const bar = applyTick(hit.bars, price, undefined, ms);
      hit.at = Date.now();
      onBar({ ...bar });
    };

    void tick();
    const timer = setInterval(() => void tick(), 1_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    const canon = canonicalTicker(ticker);
    if (!isGoldPerp(canon) && !toSpotPair(canon)) return [];
    const key = cacheKey(canon, timeframe);
    const { ms } = tfMeta(timeframe);

    const pending = inflight.get(key);
    if (pending) return sliceRange(await pending, range);

    const memHit = mem.get(key);
    if (memHit?.bars.length) {
      const tip = memHit.bars[memHit.bars.length - 1]!.time;
      const to = range.to ?? Date.now();
      if (tip >= to - Math.max(ms * 3, TIP_FRESH_MS)) {
        if (Date.now() - tip > Math.min(ms, TIP_FRESH_MS)) {
          void this.refresh(key, canon, timeframe, range);
        }
        return sliceRange(memHit.bars, range);
      }
    }

    if (!memHit) {
      const disk = await loadHistory(key);
      if (disk?.length) {
        mem.set(key, { bars: disk, at: Date.now() });
        const tip = disk[disk.length - 1]!.time;
        const to = range.to ?? Date.now();
        if (tip >= to - Math.max(ms * 3, TIP_FRESH_MS)) {
          void this.refresh(key, canon, timeframe, range);
          return sliceRange(disk, range);
        }
      }
    }

    return this.refresh(key, canon, timeframe, range);
  }

  private async refresh(
    key: string,
    canon: string,
    timeframe: string,
    range: BarRange,
  ): Promise<OHLCV[]> {
    const existing = inflight.get(key);
    if (existing) return sliceRange(await existing, range);

    const task = (async () => {
      const limit = Math.min(Math.max(range.limit ?? 800, 400), 5_000);
      let fresh: OHLCV[];
      if (isGoldPerp(canon)) {
        fresh = await fetchGoldHistory(timeframe, limit);
        const quote = await fetchLbankGoldLast();
        const { ms } = tfMeta(timeframe);
        const prior = mem.get(key)?.bars ?? [];
        let merged = mergeBars(prior, fresh);
        if (quote) applyTick(merged, quote.price, undefined, ms);
        mem.set(key, { bars: merged, at: Date.now() });
        void saveHistory(key, merged);
        return merged;
      }
      const pair = toSpotPair(canon)!;
      fresh = await fetchSpotHistory(pair, timeframe, limit);
      const quote = await fetchSpotTicker(pair);
      const { ms } = tfMeta(timeframe);
      const prior = mem.get(key)?.bars ?? [];
      let merged = mergeBars(prior, fresh);
      if (quote) applyTick(merged, quote.price, undefined, ms);
      mem.set(key, { bars: merged, at: Date.now() });
      void saveHistory(key, merged);
      return merged;
    })();

    inflight.set(key, task);
    try {
      return sliceRange(await task, range);
    } finally {
      inflight.delete(key);
    }
  }
}

/** Watchlist quotes for any LBank symbol on the list. */
export async function fetchLbankQuote(
  symbol: string,
): Promise<{ price: number; changePct: number } | null> {
  if (isGoldPerp(symbol)) {
    const q = await fetchLbankGoldLast();
    if (!q) return null;
    const changePct =
      q.open24 && q.open24 > 0 ? ((q.price - q.open24) / q.open24) * 100 : 0;
    return { price: q.price, changePct };
  }
  const pair = toSpotPair(canonicalTicker(symbol));
  if (!pair) return null;
  return fetchSpotTicker(pair);
}

/** @deprecated use fetchLbankQuote */
export async function fetchLbankGoldQuote(): Promise<{
  price: number;
  changePct: number;
} | null> {
  return fetchLbankQuote('GOLDUSDT.P');
}
