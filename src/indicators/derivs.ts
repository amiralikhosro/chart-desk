/**
 * Crypto-derivatives studies (the ones TradingView sells): funding rate, open interest
 * and perp premium, each a native indicator in its own pane.
 *
 * Data (history comes from Hyperliquid for every base that trades there, whatever the
 * chart's venue; the pane tag names the source when it isn't the chart's own venue):
 *   Funding + premium  POST api.hyperliquid.xyz/info {type:'fundingHistory', coin, startTime}
 *                      → [{coin, fundingRate, premium, time}] hourly, ≤500 per call, paged forward.
 *                      Current hour: metaAndAssetCtxs ctx.funding (predicted) / ctx.premium.
 *   Open interest      GET api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=BTC_USDT
 *                      → [{time (s), open_interest_usd, …}] (5m…1d, ≤2000 rows). OKX's rubik
 *                      stats send no CORS header, so they can't be read from the page; Gate can.
 *                      No Gate contract → Hyperliquid ctx.openInterest × markPx sampled every
 *                      poll from the moment the indicator starts.
 *
 * Hyperliquid rate-limits: requests go through one queue, history is cached per coin across
 * indicators and instances, tails refresh at most once a minute, and a 429 backs off.
 */
import type { DrawingTable, NativeIndicator, NativeIndicatorContext, SeriesPoint, SeriesSpec } from '@luxalgo/vela';
import { registerNativeIndicator } from '@luxalgo/vela/plugin';

export const FUNDING_TYPE = 'desk.funding';
export const OI_TYPE = 'desk.oi';
export const PREMIUM_TYPE = 'desk.premium';

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const GATE_STATS = 'https://api.gateio.ws/api/v4/futures/usdt/contract_stats';
const HOUR = 3_600_000;
const HOURS_PER_YEAR = 24 * 365;
const DAY = 86_400_000;
const POLL_MS = 60_000;
/** Min gap between history-tail refreshes (a bit under the poll so each poll gets one). */
const TAIL_MS = 50_000;
const CTX_TTL = 30_000;
/** Funding history is paged 500 hours per call; don't walk further back than this. */
const MAX_FUNDING_LOOKBACK = 180 * DAY;

const GREEN = '#089981';
const RED = '#f23645';
const BLUE = '#2962ff';
const ORANGE = '#ff9800';
const GREY = '#787b86';
const TAG_BG = 'rgba(19, 23, 34, 0.85)';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// ── Hyperliquid request queue with 429 back-off ─────────────────────────

class RateLimited extends Error {}

let hlChain: Promise<unknown> = Promise.resolve();
let hlBackoff = 0;
let hlUntil = 0;

function hlPost<T>(body: Record<string, unknown>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = hlUntil - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await fetch(HL_INFO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      hlBackoff = Math.min(120_000, hlBackoff ? hlBackoff * 2 : 5_000);
      hlUntil = Date.now() + hlBackoff;
      throw new RateLimited('Hyperliquid 429');
    }
    if (!res.ok) throw new Error(`Hyperliquid ${res.status}`);
    hlBackoff = 0;
    return (await res.json()) as T;
  };
  const p = hlChain.then(run, run);
  // Space calls out a little so paging never bursts.
  hlChain = p.then(
    () => sleep(120),
    () => sleep(120),
  );
  return p;
}

// ── Hyperliquid asset contexts (current funding / premium / OI) ─────────

export type HlCtx = {
  coin: string;
  funding: number;
  premium: number;
  openInterest: number;
  markPx: number;
  oraclePx: number;
};

type CtxEntry = { at: number; data: Map<string, HlCtx>; pending: Promise<Map<string, HlCtx>> | null };
const ctxCache = new Map<string, CtxEntry>();

/** `metaAndAssetCtxs` for one dex ('' = main), cached for 30 s and shared. */
export function hlContexts(dex = '', maxAge = CTX_TTL): Promise<Map<string, HlCtx>> {
  let e = ctxCache.get(dex);
  if (!e) {
    e = { at: 0, data: new Map(), pending: null };
    ctxCache.set(dex, e);
  }
  const entry = e;
  if (Date.now() - entry.at < maxAge && entry.data.size) return Promise.resolve(entry.data);
  if (entry.pending) return entry.pending;
  const body: Record<string, unknown> = { type: 'metaAndAssetCtxs' };
  if (dex) body.dex = dex;
  entry.pending = hlPost<[{ universe: Array<{ name: string; isDelisted?: boolean }> }, Array<Record<string, string>>]>(body)
    .then(([meta, ctxs]) => {
      const map = new Map<string, HlCtx>();
      (meta?.universe ?? []).forEach((u, i) => {
        const c = ctxs?.[i];
        if (!u?.name || u.isDelisted || !c) return;
        map.set(u.name, {
          coin: u.name,
          funding: num(c.funding),
          premium: num(c.premium),
          openInterest: num(c.openInterest),
          markPx: num(c.markPx),
          oraclePx: num(c.oraclePx),
        });
      });
      entry.data = map;
      entry.at = Date.now();
      return map;
    })
    .catch((err) => {
      // Keep serving the last good snapshot.
      if (entry.data.size) return entry.data;
      throw err;
    })
    .finally(() => {
      entry.pending = null;
    });
  return entry.pending;
}

/** The context of one HL coin (`BTC`, `xyz:GOLD`), from the shared cache. */
async function hlCtx(coin: string): Promise<HlCtx | null> {
  const dex = coin.includes(':') ? coin.split(':')[0]! : '';
  try {
    return (await hlContexts(dex)).get(coin) ?? null;
  } catch {
    return null;
  }
}

// ── Symbol → Hyperliquid coin ───────────────────────────────────────────

const ALIAS: Record<string, string> = { XAU: 'GOLD', XAUT: 'GOLD', PAXG: 'GOLD', XAG: 'SILVER', WTI: 'CL', XBT: 'BTC' };

function splitSymbol(symbol: string): { provider: string; ticker: string } {
  const i = symbol.indexOf(':');
  return i < 0 ? { provider: '', ticker: symbol } : { provider: symbol.slice(0, i).toLowerCase(), ticker: symbol.slice(i + 1) };
}

/** Base coin of any chart symbol: `lbank:BTCUSDT.P` → BTC, `coinbase:BTC-USD` → BTC. */
export function baseOf(symbol: string): string {
  const { provider, ticker } = splitSymbol(symbol);
  if (provider === 'hyperliquid') {
    const t = ticker.includes(':') ? ticker.split(':').pop()! : ticker;
    return t.replace(/^k(?=[A-Z])/, '');
  }
  let t = ticker.toUpperCase().replace(/\.P$/, '').replace(/[-_/]?PERP$/, '');
  t = t.replace(/[-_/]?(USDT|USDC|USD|BUSD|FDUSD)$/, '');
  t = t.split(/[-_/]/)[0] ?? t;
  return ALIAS[t] ?? t;
}

/** The HL coin for a chart symbol, or null when the base doesn't trade there. */
async function resolveCoin(symbol: string): Promise<string | null> {
  const { provider, ticker } = splitSymbol(symbol);
  const [main, xyz] = await Promise.all([hlContexts('').catch(() => new Map()), hlContexts('xyz').catch(() => new Map())]);
  if (provider === 'hyperliquid') return main.has(ticker) || xyz.has(ticker) ? ticker : null;
  const base = baseOf(symbol);
  const cands = [base, `k${base.replace(/^1000/, '')}`, `xyz:${base}`];
  return cands.find((c) => main.has(c) || xyz.has(c)) ?? null;
}

// ── Funding history store (per coin, shared) ────────────────────────────

/** One settled funding hour: `hour` is the START of the hour the rate paid for. */
type FundRec = { hour: number; rate: number; premium: number };

class FundingStore {
  recs: FundRec[] = [];
  /** Earliest startTime fully fetched from (Infinity = nothing yet). */
  covered = Infinity;
  tailAt = 0;
  private busy: Promise<void> = Promise.resolve();

  readonly coin: string;

  constructor(coin: string) {
    this.coin = coin;
  }

  ensure(from: number): Promise<void> {
    const run = (): Promise<void> => this.fetch(from);
    this.busy = this.busy.then(run, run);
    return this.busy;
  }

  private async fetch(fromIn: number): Promise<void> {
    const now = Date.now();
    const from = Math.max(fromIn - HOUR, now - MAX_FUNDING_LOOKBACK);
    if (from < this.covered) {
      const stopAt = this.recs.length ? this.recs[0]!.hour + HOUR : Infinity;
      await this.page(from, stopAt);
      this.covered = from;
      this.tailAt = now;
      return;
    }
    if (now - this.tailAt < TAIL_MS) return;
    const last = this.recs[this.recs.length - 1];
    // Hour L settles (and is published) at L + 1h; nothing newer exists before L + 2h.
    if (last && now < last.hour + 2 * HOUR + 5_000) return;
    await this.page(last ? last.hour + HOUR + 1 : from, Infinity);
    this.tailAt = now;
  }

  /** Page forward from `start` until a short page or until reaching `stopAt`. */
  private async page(start: number, stopAt: number): Promise<void> {
    let t = start;
    for (let guard = 0; guard < 40; guard++) {
      const got = await hlPost<Array<{ fundingRate: string; premium: string; time: number }>>({
        type: 'fundingHistory',
        coin: this.coin,
        startTime: Math.floor(t),
      });
      if (!Array.isArray(got) || !got.length) break;
      this.merge(
        got.map((r) => ({
          // A record stamped T (just after the hour) settles the hour before it.
          hour: Math.floor(r.time / HOUR) * HOUR - HOUR,
          rate: num(r.fundingRate),
          premium: num(r.premium),
        })),
      );
      const lastTime = got[got.length - 1]!.time;
      if (got.length < 500 || lastTime >= stopAt) break;
      t = lastTime + 1;
      await sleep(250);
    }
  }

  private merge(add: FundRec[]): void {
    const byHour = new Map(this.recs.map((r) => [r.hour, r] as const));
    for (const r of add) if (Number.isFinite(r.rate)) byHour.set(r.hour, r);
    this.recs = [...byHour.values()].sort((a, b) => a.hour - b.hour);
  }
}

const fundingStores = new Map<string, FundingStore>();
const fundingStore = (coin: string): FundingStore => {
  let s = fundingStores.get(coin);
  if (!s) fundingStores.set(coin, (s = new FundingStore(coin)));
  return s;
};

// ── Open interest stores ────────────────────────────────────────────────

type OiRec = { time: number; usd: number };

/** Gate.io interval for a chart timeframe (Vela: '1','5','60','240','1D','1W',…). */
function gateInterval(tf: string): { interval: string; ms: number } {
  const m = /^(\d+)$/.exec(tf);
  const mins = m ? Number(m[1]) : /S$/i.test(tf) ? 0 : Infinity;
  if (mins < 15) return { interval: '5m', ms: 5 * 60_000 };
  if (mins < 30) return { interval: '15m', ms: 15 * 60_000 };
  if (mins < 60) return { interval: '30m', ms: 30 * 60_000 };
  if (mins < 240) return { interval: '1h', ms: HOUR };
  if (mins < 1440) return { interval: '4h', ms: 4 * HOUR };
  return { interval: '1d', ms: DAY };
}

/** Gate contract name for an HL coin: `xyz:GOLD` → XAU_USDT, `kPEPE` → PEPE_USDT. */
function gateContract(coin: string): string {
  let b = coin.includes(':') ? coin.split(':').pop()! : coin;
  b = b.replace(/^k(?=[A-Z])/, '');
  const back: Record<string, string> = { GOLD: 'XAU', SILVER: 'XAG' };
  return `${back[b] ?? b}_USDT`;
}

class GateOiStore {
  recs: OiRec[] = [];
  missing = false;
  /** When a "missing" verdict from a failed request may be re-checked. */
  private retryAt = 0;
  private fetchedAt = 0;
  private dailyDone = false;
  private busy: Promise<void> = Promise.resolve();

  readonly contract: string;
  readonly interval: string;

  constructor(contract: string, interval: string) {
    this.contract = contract;
    this.interval = interval;
  }

  ensure(from: number): Promise<void> {
    const run = (): Promise<void> => this.fetch(from);
    this.busy = this.busy.then(run, run);
    return this.busy;
  }

  private async get(interval: string, limit: number): Promise<OiRec[] | null> {
    const qs = new URLSearchParams({ contract: this.contract, interval, limit: String(limit) });
    const res = await fetch(`${GATE_STATS}?${qs}`);
    if (res.status === 400 || res.status === 404) {
      const j = (await res.json().catch(() => null)) as { label?: string } | null;
      if (j?.label === 'CONTRACT_NOT_FOUND') return null;
    }
    if (!res.ok) throw new Error(`Gate ${res.status}`);
    const rows = (await res.json()) as Array<{ time: number; open_interest_usd?: number }>;
    return rows
      .map((r) => ({ time: r.time * 1000, usd: num(r.open_interest_usd) }))
      .filter((r) => r.usd > 0)
      .sort((a, b) => a.time - b.time);
  }

  private async fetch(from: number): Promise<void> {
    const now = Date.now();
    if (this.missing && now < this.retryAt) return;
    if (!this.recs.length) {
      let got: OiRec[] | null;
      try {
        got = await this.get(this.interval, 2000);
      } catch (err) {
        // Gate answers an unknown contract with a 400 that carries no CORS header, so the
        // browser reports a network error. Treat it as "not listed" and look again later.
        this.missing = true;
        this.retryAt = now + 10 * 60_000;
        throw err;
      }
      if (got == null) {
        this.missing = true;
        this.retryAt = Infinity;
        return;
      }
      this.missing = false;
      this.recs = got;
      this.fetchedAt = now;
    } else if (now - this.fetchedAt >= TAIL_MS) {
      const got = (await this.get(this.interval, 10)) ?? [];
      const byTime = new Map(this.recs.map((r) => [r.time, r] as const));
      for (const r of got) byTime.set(r.time, r);
      this.recs = [...byTime.values()].sort((a, b) => a.time - b.time);
      this.fetchedAt = now;
    }
    // History in front of the fine series: splice daily stats in (they reach ~3 years).
    const first = this.recs[0]?.time ?? Infinity;
    if (!this.dailyDone && this.interval !== '1d' && from < first) {
      this.dailyDone = true;
      const daily = (await this.get('1d', 2000).catch(() => null)) ?? [];
      this.recs = [...daily.filter((r) => r.time < first), ...this.recs];
    }
  }
}

const gateStores = new Map<string, GateOiStore>();
const gateStore = (contract: string, interval: string): GateOiStore => {
  const k = `${contract}|${interval}`;
  let s = gateStores.get(k);
  if (!s) gateStores.set(k, (s = new GateOiStore(contract, interval)));
  return s;
};

/** Live OI samples from HL contexts (fallback when Gate doesn't list the coin). */
const hlOiSamples = new Map<string, OiRec[]>();
function sampleHlOi(c: HlCtx): void {
  if (!(c.openInterest > 0 && c.markPx > 0)) return;
  const list = hlOiSamples.get(c.coin) ?? [];
  list.push({ time: Date.now(), usd: c.openInterest * c.markPx });
  if (list.length > 5000) list.splice(0, list.length - 5000);
  hlOiSamples.set(c.coin, list);
}

// ── Alignment onto chart bars ───────────────────────────────────────────

/**
 * One value per chart bar: records inside a bar's window `[t, next t)` are combined
 * (`mean` for rates, `last` for levels); bars without one carry the previous value;
 * bars before the first record are null.
 */
function align<T extends { t: number; v: number }>(
  bars: readonly { time: number }[],
  recs: readonly T[],
  mode: 'mean' | 'last',
): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  let j = 0;
  let carry: number | null = null;
  // Records before the first bar seed the carry.
  while (j < recs.length && recs[j]!.t < (bars[0]?.time ?? 0)) carry = recs[j++]!.v;
  for (let i = 0; i < bars.length; i++) {
    const end = bars[i + 1]?.time ?? Infinity;
    let sum = 0;
    let n = 0;
    let last: number | null = null;
    while (j < recs.length && recs[j]!.t < end) {
      sum += recs[j]!.v;
      last = recs[j]!.v;
      n++;
      j++;
    }
    if (n) carry = mode === 'mean' ? sum / n : last;
    out[i] = carry;
  }
  return out;
}

const pts = (bars: readonly { time: number }[], vals: Array<number | null>, color?: (v: number) => string): SeriesPoint[] =>
  bars.map((b, i) => {
    const v = vals[i] ?? null;
    return v == null ? { time: b.time, value: null } : color ? { time: b.time, value: v, color: color(v) } : { time: b.time, value: v };
  });

function fmtPct(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/** Small top-right pane tag: source + the current reading, formatted properly. */
function tag(id: string, parts: Array<{ text: string; color?: string; bold?: boolean }>): DrawingTable {
  return {
    id,
    paneId: '',
    position: 'top_right',
    columns: parts.length,
    rows: 1,
    bgColor: TAG_BG,
    frameWidth: 0,
    borderWidth: 0,
    cells: [
      parts.map((p) => ({
        text: p.text,
        textColor: p.color ?? GREY,
        hAlign: 'right',
        vAlign: 'top',
        textSize: 'small',
        fontFamily: 'default',
        bold: !!p.bold,
        italic: false,
        bgColor: TAG_BG,
      })),
    ],
    merges: [],
  };
}

// ── Indicators ──────────────────────────────────────────────────────────

abstract class DerivIndicator implements NativeIndicator {
  protected ctx: NativeIndicatorContext | null = null;
  protected coin: string | null = null;
  /** Data venue suffix for titles: '' when it is the chart's own venue. */
  protected venueTag = '';
  protected current: HlCtx | null = null;
  private resolved = false;
  private fetchedFrom = Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private raf = 0;
  private token = 0;
  private loading = false;
  private backfill: ReturnType<typeof setTimeout> | null = null;

  start(ctx: NativeIndicatorContext): void {
    this.ctx = ctx;
    this.venueTag = splitSymbol(ctx.symbol).provider === 'hyperliquid' ? '' : ' · HL';
    void this.load(true);
    this.startTimer();
  }

  onBars(): void {
    const first = this.ctx?.bars()[0]?.time;
    if (first != null && first < this.fetchedFrom && this.resolved && this.coin) {
      // History streams in chunk by chunk: fetch once it settles, not once per chunk.
      if (this.backfill) clearTimeout(this.backfill);
      this.backfill = setTimeout(() => {
        this.backfill = null;
        void this.load(true);
      }, 1_000);
    }
    this.schedule();
  }

  onViewport(): void {
    /* values don't depend on the view */
  }

  setInputs(): void {
    this.schedule();
  }

  suspend(): void {
    this.stopTimer();
  }

  resume(): void {
    this.startTimer();
    void this.load(false);
  }

  stop(): void {
    this.stopTimer();
    if (this.backfill) clearTimeout(this.backfill);
    this.backfill = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.token++;
    this.ctx = null;
  }

  protected abstract fetchData(from: number): Promise<void>;
  protected abstract paint(): void;

  private startTimer(): void {
    this.stopTimer();
    if (!this.ctx?.live) return;
    this.timer = setInterval(() => void this.load(false), POLL_MS);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async load(full: boolean): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || (this.loading && !full)) return;
    const bars = ctx.bars();
    const my = ++this.token;
    this.loading = true;
    if (full) ctx.setStatus('loading');
    try {
      if (!this.resolved) {
        this.coin = await resolveCoin(ctx.symbol);
        this.resolved = true;
      }
      if (my !== this.token || !this.ctx) return;
      if (!this.coin) {
        this.emitUnavailable();
        ctx.setStatus('idle');
        return;
      }
      const from = bars[0]?.time ?? Date.now() - 30 * DAY;
      const [c] = await Promise.all([hlCtx(this.coin), this.fetchData(from)]);
      if (my !== this.token || !this.ctx) return;
      this.current = c;
      if (full && bars.length) this.fetchedFrom = bars[0]!.time;
      ctx.setStatus(ctx.live ? 'live' : 'idle');
      this.paint();
    } catch (err) {
      console.warn('[derivs]', ctx.symbol, err);
      if (my === this.token && this.ctx) {
        ctx.setStatus('idle');
        this.paint();
      }
    } finally {
      if (my === this.token) this.loading = false;
    }
  }

  private emitUnavailable(): void {
    this.ctx?.emit({
      series: [],
      tables: [tag(`${this.ctx.id}-tag`, [{ text: `No Hyperliquid market for ${baseOf(this.ctx.symbol)}` }])],
    });
  }

  protected schedule(): void {
    if (this.raf || !this.ctx) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }
}

/** Settled hourly history, the current (predicted) hour from the live context. */
function fundingValues(
  bars: readonly { time: number }[],
  recs: readonly FundRec[],
  pick: (r: FundRec) => number,
  live: number | null,
): Array<number | null> {
  const vals = align(
    bars,
    recs.map((r) => ({ t: r.hour, v: pick(r) * 100 })),
    'mean',
  );
  const lastHour = recs[recs.length - 1]?.hour;
  if (lastHour != null && live != null && Number.isFinite(live)) {
    // Bars past the last settled hour are the hour now accruing.
    for (let i = bars.length - 1; i >= 0 && bars[i]!.time >= lastHour + HOUR; i--) vals[i] = live * 100;
  }
  return vals;
}

class FundingIndicator extends DerivIndicator {
  protected async fetchData(from: number): Promise<void> {
    await fundingStore(this.coin!).ensure(from);
  }

  protected paint(): void {
    const ctx = this.ctx;
    if (!ctx || !this.coin) return;
    const bars = ctx.bars();
    const recs = fundingStore(this.coin).recs;
    if (!bars.length || !recs.length) {
      ctx.emit({ series: [], tables: [tag(`${ctx.id}-tag`, [{ text: `Funding · ${this.coin} · loading` }])] });
      return;
    }
    const pred = this.current?.funding ?? null;
    // %/h per bar (settled hours, the accruing hour from the predicted rate).
    const perHour = fundingValues(bars, recs, (r) => r.rate, pred);
    // Vela formats pane values with the symbol's mintick (BTC: 1 decimal), which turns
    // 0.0012 %/h into "0.0". Plot the annualized rate (same shape, readable at any
    // precision); the exact %/h sits in the pane tag.
    const apr = perHour.map((v) => (v == null ? null : v * HOURS_PER_YEAR));
    const predApr = pred != null && Number.isFinite(pred) ? pred * 100 * HOURS_PER_YEAR : null;
    const predPts: SeriesPoint[] = bars.map((b, i) => ({ time: b.time, value: i === bars.length - 1 ? predApr : null }));
    const series: SeriesSpec[] = [
      {
        id: `${ctx.id}-fr`,
        title: `Funding APR %${this.venueTag}`,
        paneId: '',
        kind: 'histogram',
        points: pts(bars, apr, (x) => (x >= 0 ? GREEN : RED)),
        style: { color: GREEN, width: 1, lineStyle: 'solid', base: 0 },
      },
      {
        id: `${ctx.id}-pred`,
        title: 'Predicted APR %',
        paneId: '',
        kind: 'line',
        points: predPts,
        style: { color: ORANGE, width: 1, lineStyle: 'solid' },
        display: { pane: false, priceScale: false, legend: true, dataWindow: true },
      },
    ];
    const col = (x: number | null): string => (x == null ? GREY : x >= 0 ? GREEN : RED);
    ctx.emit({
      series,
      priceLines: [{ id: `${ctx.id}-zero`, paneId: '', price: 0, color: GREY, lineStyle: 'dotted', width: 1 }],
      tables: [
        tag(`${ctx.id}-tag`, [
          { text: `${this.coin} · Hyperliquid · hourly` },
          { text: `Pred ${fmtPct(pred == null ? null : pred * 100)}/h`, color: col(pred), bold: true },
          { text: `APR ${fmtPct(predApr, 2)}`, color: col(predApr) },
        ]),
      ],
    });
  }
}

class PremiumIndicator extends DerivIndicator {
  protected async fetchData(from: number): Promise<void> {
    await fundingStore(this.coin!).ensure(from);
  }

  protected paint(): void {
    const ctx = this.ctx;
    if (!ctx || !this.coin) return;
    const bars = ctx.bars();
    const recs = fundingStore(this.coin).recs;
    if (!bars.length || !recs.length) {
      ctx.emit({ series: [], tables: [tag(`${ctx.id}-tag`, [{ text: `Premium · ${this.coin} · loading` }])] });
      return;
    }
    const live = this.current?.premium ?? null;
    const pct = fundingValues(bars, recs, (r) => r.premium, live);
    // Basis points: readable with the symbol's mintick precision (see the funding note).
    const bps = pct.map((v) => (v == null ? null : v * 100));
    const now = pct[pct.length - 1] ?? null;
    ctx.emit({
      series: [
        {
          id: `${ctx.id}-prem`,
          title: `Premium bps${this.venueTag}`,
          paneId: '',
          kind: 'line',
          points: pts(bars, bps),
          style: { color: BLUE, width: 2, lineStyle: 'solid' },
        },
      ],
      priceLines: [{ id: `${ctx.id}-zero`, paneId: '', price: 0, color: GREY, lineStyle: 'dashed', width: 1, title: '0' }],
      tables: [
        tag(`${ctx.id}-tag`, [
          { text: `${this.coin} perp vs oracle · Hyperliquid` },
          { text: `${fmtPct(now)} (${now == null ? '—' : `${now > 0 ? '+' : ''}${(now * 100).toFixed(1)} bps`})`, color: now == null ? GREY : now >= 0 ? GREEN : RED, bold: true },
        ]),
      ],
    });
  }
}

class OpenInterestIndicator extends DerivIndicator {
  private gate: GateOiStore | null = null;

  protected async fetchData(from: number): Promise<void> {
    const ctx = this.ctx!;
    if (!this.gate) this.gate = gateStore(gateContract(this.coin!), gateInterval(ctx.timeframe).interval);
    try {
      await this.gate.ensure(from);
    } catch (err) {
      if (!this.gate.missing) console.warn('[derivs] Gate OI', err);
    }
    if (this.gate.missing || !this.gate.recs.length) {
      // Fallback: sample HL's live OI from now on.
      const c = await hlCtx(this.coin!);
      if (c) sampleHlOi(c);
    }
  }

  protected paint(): void {
    const ctx = this.ctx;
    if (!ctx || !this.coin) return;
    const bars = ctx.bars();
    const fromGate = !!this.gate && !this.gate.missing && this.gate.recs.length > 0;
    const recs = fromGate ? this.gate!.recs : (hlOiSamples.get(this.coin) ?? []);
    const source = fromGate ? 'Gate.io' : 'HL live';
    if (!bars.length || !recs.length) {
      ctx.emit({ series: [], tables: [tag(`${ctx.id}-tag`, [{ text: `OI · ${source} · loading` }])] });
      return;
    }
    const vals = align(
      bars,
      // $M: readable with the symbol's mintick precision.
      recs.map((r) => ({ t: r.time, v: r.usd / 1e6 })),
      'last',
    );
    const last = vals[vals.length - 1];
    const now = last == null ? null : last * 1e6;
    const hlOi = this.current && this.current.openInterest > 0 ? this.current.openInterest * this.current.markPx : null;
    ctx.emit({
      series: [
        {
          id: `${ctx.id}-oi`,
          title: `OI $M · ${fromGate ? 'Gate' : 'HL'}`,
          paneId: '',
          kind: 'area',
          points: pts(bars, vals),
          style: { color: '#f7a600', width: 2, lineStyle: 'solid' },
        },
      ],
      tables: [
        tag(`${ctx.id}-tag`, [
          { text: fromGate ? `${gateContract(this.coin)} · Gate.io` : `${this.coin} · Hyperliquid, sampled since added` },
          { text: fmtUsd(now), color: '#f7a600', bold: true },
          ...(fromGate && hlOi != null ? [{ text: `HL ${fmtUsd(hlOi)}` }] : []),
        ]),
      ],
    });
  }
}

let registered = false;

export function registerDerivativesIndicators(): void {
  if (registered) return;
  registered = true;
  const common = { paneHint: 'new' as const, overlay: false, multiInstance: false, inputsSchema: () => [], defaultInputs: () => ({}) };
  registerNativeIndicator({
    ...common,
    type: FUNDING_TYPE,
    title: 'Funding rate',
    shortTitle: 'Funding',
    create: () => new FundingIndicator(),
  });
  registerNativeIndicator({
    ...common,
    type: OI_TYPE,
    title: 'Open interest',
    shortTitle: 'OI',
    create: () => new OpenInterestIndicator(),
  });
  registerNativeIndicator({
    ...common,
    type: PREMIUM_TYPE,
    title: 'Perp premium',
    shortTitle: 'Premium',
    create: () => new PremiumIndicator(),
  });
}
