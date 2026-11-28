/**
 * TradingView-style "Order Book" (DOM) side panel. Follows the chart symbol and
 * polls the L2 book of the venue it trades on (or the closest public book when the
 * venue has none), with price grouping, cumulative depth bars and click-to-ticket
 * (paper only). Sources:
 *  - Hyperliquid  POST https://api.hyperliquid.xyz/info {type:'l2Book', coin, nSigFigs?}
 *  - LBank spot   /lbank-api/v2/depth.do?symbol=xlm_usdt&size=200
 *  - LBank perp   /lbank-perp/cfd/openApi/v1/pub/marketOrder?symbol=BTCUSDT&depth=200
 *  - Coinbase     https://api.exchange.coinbase.com/products/BTC-USD/book?level=2
 */
import './orderbook.css';
import type { Vela } from '@luxalgo/vela';
import { registerIcon, registerSidePanel } from '@luxalgo/vela/plugin';
import { openTicket } from '../trading/trading-panel';
import { getAccount, onPaperChange, sameSymbol } from '../trading/paper-store';

registerIcon(
  'desk-orderbook',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 3.5h6M2.5 6h9M2.5 8.5h11"/><path d="M2.5 11h8M2.5 13.5h4.5" opacity=".6"/></svg>',
);

type Level = { px: number; sz: number };
type Book = { bids: Level[]; asks: Level[]; at: number };

type Source =
  | { kind: 'hl'; coin: string; label: string }
  | { kind: 'lbank-perp'; sym: string; label: string }
  | { kind: 'lbank-spot'; pair: string; label: string }
  | { kind: 'coinbase'; product: string; label: string };

class RateLimited extends Error {}

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const LS_KEY = 'chart-desk-orderbook-v1';
const ROW_H = 19;
const FAST_MS = 1_000;
const HL_BACKOFF_MS = 4_000;
const COINBASE_MS = 3_000; // full level-2 book is ~300 KB gzipped
const FETCH_TIMEOUT = 6_000;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/* ------------------------------------------------------------ symbol → book */

/** `lbank:BTCUSDT.P` → `BTC`, `lbank:XLMUSDT` → `XLM`. */
function lbankBase(t: string): string {
  return t.replace(/\.P$/, '').replace(/_?(USDT|USDC)$/i, '').replace(/_.*/, '');
}

function isLbankGold(t: string): boolean {
  return ['GOLDUSDT.P', 'GOLDUSDT', 'GOLD', 'XAU', 'XAUUSDT', 'XAU-USDT-SWAP'].includes(t);
}

/** Ordered candidate books for a chart symbol: the first that answers wins. */
export function sourcesFor(symbol: string): Source[] {
  const i = symbol.indexOf(':');
  const venue = (i > 0 ? symbol.slice(0, i) : '').toLowerCase();
  const rest = i > 0 ? symbol.slice(i + 1) : symbol;

  if (venue === 'hyperliquid') {
    const coin = rest.includes(':') ? rest : rest.split('-')[0]!.toUpperCase();
    return [{ kind: 'hl', coin, label: coin.includes(':') ? `Hyperliquid ${coin.split(':')[0]} (HIP-3)` : 'Hyperliquid' }];
  }

  if (venue === 'lbank') {
    const t = rest.toUpperCase();
    if (isLbankGold(t)) {
      return [
        { kind: 'lbank-perp', sym: 'GOLDUSDT', label: 'LBank perp' },
        { kind: 'hl', coin: 'xyz:GOLD', label: 'Hyperliquid xyz:GOLD (LBank book n/a)' },
      ];
    }
    const base = lbankBase(t);
    if (t.endsWith('.P')) {
      return [
        { kind: 'lbank-perp', sym: t.replace(/\.P$/, ''), label: 'LBank perp' },
        { kind: 'lbank-spot', pair: `${base.toLowerCase()}_usdt`, label: 'LBank spot (perp book n/a)' },
        { kind: 'hl', coin: base, label: 'Hyperliquid (LBank book n/a)' },
      ];
    }
    const m = t.includes('_') ? [t, ...t.split('_')] : t.match(/^([A-Z0-9]+?)(USDT|USDC|BTC|ETH)$/);
    const pair = m ? `${m[1]!.toLowerCase()}_${m[2]!.toLowerCase()}` : `${base.toLowerCase()}_usdt`;
    return [
      { kind: 'lbank-spot', pair, label: 'LBank spot' },
      { kind: 'hl', coin: base, label: 'Hyperliquid (LBank book n/a)' },
    ];
  }

  if (venue === 'coinbase') {
    const product = rest.toUpperCase();
    const base = product.split('-')[0]!;
    return [
      { kind: 'coinbase', product, label: 'Coinbase' },
      { kind: 'hl', coin: base, label: 'Hyperliquid (Coinbase book n/a)' },
    ];
  }

  // Unknown venue: closest public book is Hyperliquid's perp on the same base.
  let base = rest.toUpperCase().replace(/\.P$/, '');
  if (base.includes('-')) base = base.split('-')[0]!;
  base = base.replace(/(USDT|USDC|USD)$/, '') || base;
  return [{ kind: 'hl', coin: base, label: `Hyperliquid (mapped from ${venue || 'chart'})` }];
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (res.status === 429) throw new RateLimited('429');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const lvl = (px: unknown, sz: unknown): Level | null => {
  const p = Number(px);
  const s = Number(sz);
  return Number.isFinite(p) && p > 0 && Number.isFinite(s) && s > 0 ? { px: p, sz: s } : null;
};
const clean = (rows: Array<Level | null>): Level[] => rows.filter((r): r is Level => r !== null);

async function fetchBook(src: Source, nSigFigs: number | null): Promise<Book> {
  let bids: Level[] = [];
  let asks: Level[] = [];
  if (src.kind === 'hl') {
    const body: Record<string, unknown> = { type: 'l2Book', coin: src.coin };
    if (nSigFigs) body.nSigFigs = nSigFigs;
    const json = (await getJson(HL_INFO, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })) as { levels?: Array<Array<{ px: string; sz: string }>> } | null;
    if (!json?.levels) throw new Error('no book');
    bids = clean((json.levels[0] ?? []).map((r) => lvl(r.px, r.sz)));
    asks = clean((json.levels[1] ?? []).map((r) => lvl(r.px, r.sz)));
  } else if (src.kind === 'lbank-spot') {
    const json = (await getJson(`/lbank-api/v2/depth.do?symbol=${encodeURIComponent(src.pair)}&size=200`)) as {
      result?: string | boolean;
      data?: { bids?: string[][]; asks?: string[][] };
    };
    if (String(json.result) !== 'true' || !json.data) throw new Error('no book');
    bids = clean((json.data.bids ?? []).map((r) => lvl(r[0], r[1])));
    asks = clean((json.data.asks ?? []).map((r) => lvl(r[0], r[1])));
  } else if (src.kind === 'lbank-perp') {
    const json = (await getJson(
      `/lbank-perp/cfd/openApi/v1/pub/marketOrder?symbol=${encodeURIComponent(src.sym)}&depth=200`,
    )) as { data?: { bids?: Array<{ price: string; volume: string }>; asks?: Array<{ price: string; volume: string }> } };
    if (!json.data) throw new Error('no book');
    bids = clean((json.data.bids ?? []).map((r) => lvl(r.price, r.volume)));
    asks = clean((json.data.asks ?? []).map((r) => lvl(r.price, r.volume)));
  } else {
    const json = (await getJson(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(src.product)}/book?level=2`,
    )) as { bids?: string[][]; asks?: string[][] };
    // Only the near-touch levels matter here; the full book has ~10k rows per side.
    bids = clean((json.bids ?? []).slice(0, 600).map((r) => lvl(r[0], r[1])));
    asks = clean((json.asks ?? []).slice(0, 600).map((r) => lvl(r[0], r[1])));
  }
  if (!bids.length && !asks.length) throw new Error('empty book');
  bids.sort((a, b) => b.px - a.px);
  asks.sort((a, b) => a.px - b.px);
  return { bids, asks, at: Date.now() };
}

/* ----------------------------------------------------------------- grouping */

const decimalsOf = (step: number): number => {
  if (step >= 1) return 0;
  return Math.min(10, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
};

const roundTo = (n: number, d: number): number => Number(n.toFixed(d));

/** Smallest gap between adjacent raw prices = the venue tick (as seen). */
function observedTick(book: Book): number {
  let tick = Infinity;
  for (const side of [book.bids, book.asks]) {
    for (let i = 1; i < Math.min(side.length, 60); i++) {
      const d = roundTo(Math.abs(side[i]!.px - side[i - 1]!.px), 10);
      if (d > 0 && d < tick) tick = d;
    }
  }
  return Number.isFinite(tick) ? tick : 0;
}

/** 1-2-5 grouping steps from the tick up to ~0.5% of price. */
function groupSteps(tick: number, mid: number): number[] {
  if (!(tick > 0) || !(mid > 0)) return [];
  const steps = [tick];
  let mag = Math.pow(10, Math.floor(Math.log10(tick) + 1e-9));
  while (steps.length < 9) {
    for (const k of [1, 2, 5]) {
      const s = roundTo(k * mag, 10);
      if (s > tick * 1.0001 && s <= Math.max(mid * 0.005, tick * 10) && !steps.includes(s)) steps.push(s);
    }
    mag *= 10;
    if (mag > mid) break;
  }
  return steps.sort((a, b) => a - b).slice(0, 9);
}

/** Hyperliquid server-side aggregation: coarsest `nSigFigs` whose resolution ≤ step. */
function hlSigFigs(step: number, mid: number): number | null {
  if (!(mid > 0)) return null;
  const intDigits = Math.floor(Math.log10(mid)) + 1;
  for (let n = 2; n <= 5; n++) {
    const res = Math.pow(10, intDigits - n);
    if (res <= step * 1.0001) return n === 5 ? null : n;
  }
  return null;
}

function aggregate(side: Level[], step: number, isBid: boolean, limit: number): Level[] {
  const d = decimalsOf(step) + 1;
  const out: Level[] = [];
  for (const l of side) {
    const q = l.px / step;
    const k = isBid ? Math.floor(q + 1e-7) : Math.ceil(q - 1e-7);
    const px = roundTo(k * step, d);
    const last = out[out.length - 1];
    if (last && last.px === px) last.sz += l.sz;
    else {
      if (out.length >= limit) break;
      out.push({ px, sz: l.sz });
    }
  }
  return out;
}

const bucketOf = (px: number, step: number, isBid: boolean): number => {
  const q = px / step;
  return roundTo((isBid ? Math.floor(q + 1e-7) : Math.ceil(q - 1e-7)) * step, decimalsOf(step) + 1);
};

function fmtSize(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 100) return n.toFixed(0);
  if (a >= 1) return n.toFixed(2);
  return n.toFixed(a >= 0.01 ? 4 : 6);
}

const fmtPx = (n: number, step: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: decimalsOf(step), maximumFractionDigits: decimalsOf(step) });

type Prefs = { steps: Record<string, number> };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { steps: {}, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* ignore */
  }
  return { steps: {} };
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------- panel */

export function registerOrderBookPanel(): void {
  registerSidePanel({
    id: 'desk.orderbook',
    title: 'Order Book',
    icon: 'desk-orderbook',
    order: 8,
    width: 300,
    resizable: true,
    minWidth: 240,
    maxWidth: 480,
    placement: 'column',
    mount: (_ctx, body) => {
      const prefs = loadPrefs();
      let chart: Vela | null = null;
      let offMarket: (() => void) | null = null;
      let symbol = '';
      let sources: Source[] = [];
      let srcIdx = 0;
      let book: Book | null = null;
      let tick = 0;
      let step = 0;
      let error = '';
      let backoffUntil = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let running = false;
      let inflight = false;
      let gen = 0;
      let prevMid = 0;
      /** Real top of book; differs from `book` when Hyperliquid aggregates server-side. */
      let touch: { bid?: number; ask?: number; at: number } | null = null;
      let pollN = 0;
      let midDir: 'up' | 'down' | '' = '';

      body.className = 'desk-panel desk-ob';
      body.innerHTML = `
        <div class="desk-ob__head">
          <div class="desk-ob__title">
            <span class="desk-ob__sym" data-sym></span>
            <span class="desk-ob__venue" data-venue></span>
          </div>
          <label class="desk-ob__group" title="Price grouping">
            <select data-group aria-label="Price grouping"></select>
          </label>
        </div>
        <div class="desk-ob__cols"><span>Price</span><span>Size</span><span>Total</span></div>
        <div class="desk-ob__side desk-ob__side--asks" data-asks></div>
        <div class="desk-ob__mid" data-mid></div>
        <div class="desk-ob__side desk-ob__side--bids" data-bids></div>
        <div class="desk-ob__ratio" data-ratio></div>
        <div class="desk-ob__foot" data-foot></div>`;
      const symEl = body.querySelector<HTMLElement>('[data-sym]')!;
      const venueEl = body.querySelector<HTMLElement>('[data-venue]')!;
      const groupEl = body.querySelector<HTMLSelectElement>('[data-group]')!;
      const asksEl = body.querySelector<HTMLElement>('[data-asks]')!;
      const bidsEl = body.querySelector<HTMLElement>('[data-bids]')!;
      const midEl = body.querySelector<HTMLElement>('[data-mid]')!;
      const ratioEl = body.querySelector<HTMLElement>('[data-ratio]')!;
      const footEl = body.querySelector<HTMLElement>('[data-foot]')!;

      const visible = (): boolean => body.isConnected && body.offsetParent !== null;
      const source = (): Source | undefined => sources[srcIdx];

      function renderGroups(): void {
        const mid = book ? ((book.bids[0]?.px ?? 0) + (book.asks[0]?.px ?? 0)) / 2 || book.bids[0]?.px || book.asks[0]?.px || 0 : 0;
        const steps = groupSteps(tick, mid);
        if (!steps.length) {
          groupEl.innerHTML = '<option>—</option>';
          groupEl.disabled = true;
          return;
        }
        if (!steps.includes(step)) step = steps[0]!;
        groupEl.disabled = false;
        const html = steps.map((s) => `<option value="${s}"${s === step ? ' selected' : ''}>${fmtPx(s, s)}</option>`).join('');
        if (groupEl.innerHTML !== html) groupEl.innerHTML = html;
      }

      /** Working paper orders keyed by the bid-side (`b:`) and ask-side (`a:`) bucket they fall in. */
      function workingOrders(): Map<string, { side: 'buy' | 'sell'; qty: number }> {
        const out = new Map<string, { side: 'buy' | 'sell'; qty: number }>();
        if (!step) return out;
        for (const o of getAccount().orders) {
          if (!sameSymbol(o.symbol, symbol)) continue;
          for (const key of [`b:${bucketOf(o.price, step, true)}`, `a:${bucketOf(o.price, step, false)}`]) {
            const prev = out.get(key);
            out.set(key, { side: o.side, qty: (prev?.qty ?? 0) + o.qty });
          }
        }
        return out;
      }

      function render(): void {
        symEl.textContent = symbol ? symbol.replace(/^[a-z]+:/i, '') : '—';
        const src = source();
        venueEl.textContent = src ? src.label : '';
        venueEl.title = src ? `Book source: ${src.label}` : '';
        venueEl.classList.toggle('is-mapped', !!src && /n\/a|mapped/.test(src.label));

        if (!book || !step) {
          asksEl.innerHTML = '';
          bidsEl.innerHTML = '';
          ratioEl.innerHTML = '';
          midEl.innerHTML = `<span class="desk-ob__empty">${error ? esc(error) : symbol ? 'Loading order book…' : 'No symbol'}</span>`;
          footEl.textContent = '';
          return;
        }

        const n = Math.max(4, Math.min(60, Math.floor(asksEl.clientHeight / ROW_H) || 15));
        const asks = aggregate(book.asks, step, false, n);
        const bids = aggregate(book.bids, step, true, n);
        let cum = 0;
        const askCum = asks.map((l) => (cum += l.sz));
        cum = 0;
        const bidCum = bids.map((l) => (cum += l.sz));
        const maxCum = Math.max(askCum[askCum.length - 1] ?? 0, bidCum[bidCum.length - 1] ?? 0) || 1;
        const orders = workingOrders();

        const row = (l: Level, total: number, isBid: boolean): string => {
          const pct = Math.min(100, (total / maxCum) * 100).toFixed(1);
          const sizePct = Math.min(100, (l.sz / maxCum) * 100).toFixed(1);
          const mine = orders.get(`${isBid ? 'b' : 'a'}:${l.px}`);
          const tag = mine
            ? `<span class="desk-ob__mine is-${mine.side}" title="Working paper ${mine.side} ${mine.qty}">${mine.side === 'buy' ? 'B' : 'S'} ${fmtSize(mine.qty)}</span>`
            : '';
          return `<div class="desk-ob__row${mine ? ' has-order' : ''}" data-side="${isBid ? 'buy' : 'sell'}" data-px="${l.px}" title="${isBid ? 'Buy' : 'Sell'} limit at ${fmtPx(l.px, step)}">
            <i class="desk-ob__bar" style="width:${pct}%"></i><i class="desk-ob__bar desk-ob__bar--lvl" style="width:${sizePct}%"></i>
            <span class="desk-ob__px">${tag}${fmtPx(l.px, step)}</span><span>${fmtSize(l.sz)}</span><span>${fmtSize(total)}</span>
          </div>`;
        };

        asksEl.innerHTML = asks
          .map((l, i) => row(l, askCum[i]!, false))
          .reverse()
          .join('');
        bidsEl.innerHTML = bids.map((l, i) => row(l, bidCum[i]!, true)).join('');

        const top = touch && Date.now() - touch.at < 15_000 ? touch : { bid: book.bids[0]?.px, ask: book.asks[0]?.px };
        const bestBid = top.bid;
        const bestAsk = top.ask;
        if (bestBid != null && bestAsk != null) {
          const mid = (bestBid + bestAsk) / 2;
          if (prevMid && mid !== prevMid) midDir = mid > prevMid ? 'up' : 'down';
          prevMid = mid;
          const spread = bestAsk - bestBid;
          const dTick = decimalsOf(tick || step);
          midEl.innerHTML = `<span class="desk-ob__midpx is-${midDir || 'flat'}" title="Mid price">${midDir === 'up' ? '▲' : midDir === 'down' ? '▼' : ''} ${mid.toLocaleString('en-US', { minimumFractionDigits: dTick, maximumFractionDigits: dTick + 1 })}</span>
            <span class="desk-ob__spread" title="Spread (best ask − best bid)">Spread ${spread.toLocaleString('en-US', { maximumFractionDigits: dTick + 1 })} · ${((spread / mid) * 100).toFixed(3)}%</span>`;
        } else {
          midEl.innerHTML = '<span class="desk-ob__empty">One-sided book</span>';
        }

        const bidSum = bidCum[bidCum.length - 1] ?? 0;
        const askSum = askCum[askCum.length - 1] ?? 0;
        const bp = bidSum + askSum > 0 ? (bidSum / (bidSum + askSum)) * 100 : 50;
        ratioEl.innerHTML = `<span class="is-buy">B ${bp.toFixed(0)}%</span><span class="desk-ob__ratiobar"><i style="width:${bp.toFixed(1)}%"></i></span><span class="is-sell">${(100 - bp).toFixed(0)}% S</span>`;

        const slow = Date.now() < backoffUntil;
        footEl.textContent = `Updated ${new Date(book.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}${
          slow ? ' · rate-limited, slowing down' : ''
        }${error ? ` · ${error}` : ''} · click a row for a paper limit order`;
      }

      function cadence(): number {
        const src = source();
        if (Date.now() < backoffUntil) return HL_BACKOFF_MS;
        return src?.kind === 'coinbase' ? COINBASE_MS : FAST_MS;
      }

      async function poll(): Promise<void> {
        const src = source();
        if (!src || inflight) return;
        inflight = true;
        const myGen = gen;
        try {
          const mid = book ? ((book.bids[0]?.px ?? 0) + (book.asks[0]?.px ?? 0)) / 2 : 0;
          const sig = src.kind === 'hl' && step > tick && tick > 0 ? hlSigFigs(step, mid) : null;
          // Coarse HL grouping: every 3rd poll re-reads the raw book for the real best bid/ask.
          const rawTouch = !!sig && !!book && ++pollN % 3 === 0;
          const next = await fetchBook(src, rawTouch ? null : sig);
          if (myGen !== gen) return;
          if (!sig || rawTouch) {
            touch = { bid: next.bids[0]?.px, ask: next.asks[0]?.px, at: next.at };
            // Learn the tick from the raw (un-aggregated) book only.
            const t = observedTick(next);
            if (t > 0 && (!tick || t < tick)) tick = t;
          }
          if (rawTouch) return;
          if (!step) {
            const saved = prefs.steps[symbol];
            const m = ((next.bids[0]?.px ?? 0) + (next.asks[0]?.px ?? 0)) / 2;
            step = saved && groupSteps(tick, m).includes(saved) ? saved : tick;
          }
          book = next;
          error = '';
          renderGroups();
        } catch (err) {
          if (myGen !== gen) return;
          if (err instanceof RateLimited) {
            backoffUntil = Date.now() + 30_000;
            error = book ? '' : `${src.label.split(' ')[0]} rate limit (429), retrying every ${HL_BACKOFF_MS / 1000} s…`;
          } else if (!book && srcIdx < sources.length - 1) {
            // Venue has no public book for this market: fall through to the next mapping.
            srcIdx++;
            tick = 0;
            step = 0;
          } else {
            error = book ? 'refresh failed' : `No order book (${(err as Error).message})`;
          }
        } finally {
          inflight = false;
          if (myGen === gen) render();
        }
      }

      function schedule(delay: number): void {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          timer = null;
          if (!visible()) {
            running = false;
            return;
          }
          await poll();
          if (running) schedule(cadence());
        }, delay);
      }

      function start(): void {
        running = true;
        schedule(0);
      }

      function stop(): void {
        running = false;
        if (timer) clearTimeout(timer);
        timer = null;
      }

      function setSymbol(sym: string | undefined): void {
        const s = sym ?? '';
        if (s === symbol) return;
        symbol = s;
        sources = s ? sourcesFor(s) : [];
        srcIdx = 0;
        book = null;
        tick = 0;
        step = 0;
        error = '';
        prevMid = 0;
        midDir = '';
        touch = null;
        pollN = 0;
        gen++;
        inflight = false;
        groupEl.innerHTML = '';
        render();
        if (running) schedule(0);
      }

      groupEl.addEventListener('change', () => {
        const v = Number(groupEl.value);
        if (!(v > 0)) return;
        step = v;
        prefs.steps[symbol] = v;
        savePrefs(prefs);
        render();
        // Hyperliquid only sends 20 levels: re-request a server-aggregated book.
        if (source()?.kind === 'hl' && running) schedule(0);
      });

      body.addEventListener('click', (ev) => {
        const rowEl = (ev.target as HTMLElement).closest<HTMLElement>('.desk-ob__row');
        if (!rowEl || !symbol) return;
        const price = Number(rowEl.dataset.px);
        if (!(price > 0)) return;
        openTicket({ side: rowEl.dataset.side === 'buy' ? 'buy' : 'sell', type: 'limit', price, symbol });
      });

      const offPaper = onPaperChange(() => {
        if (book) render();
      });
      const ro = new ResizeObserver(() => {
        if (book) render();
      });
      ro.observe(body);

      render();

      return {
        onChart: (c) => {
          chart = c;
          offMarket?.();
          offMarket = c.on('market:changed', () => setSymbol(chart?.market.symbol));
          setSymbol(c.market.symbol);
        },
        onOpen: () => {
          if (!symbol && chart) setSymbol(chart.market.symbol);
          start();
        },
        destroy: () => {
          stop();
          gen++;
          offMarket?.();
          offPaper();
          ro.disconnect();
        },
      };
    },
  });
}
