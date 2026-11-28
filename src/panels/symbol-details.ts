/**
 * TradingView-style symbol details under the watchlist: big last price and
 * change, day's range bar, 24h volume, and performance tiles (1W … 1Y)
 * computed from the source's own daily bars.
 */
import type { OHLCV, Vela } from '@luxalgo/vela';
import { displaySymbol } from '../desk/approvals';
import { onHlQuotes } from '../lib/hl-quotes';
import { fmtPrice } from '../trading/paper-store';

const DAY = 86_400_000;
const PERIODS: Array<{ id: string; days: number | 'ytd' }> = [
  { id: '1W', days: 7 },
  { id: '1M', days: 30 },
  { id: '3M', days: 91 },
  { id: '6M', days: 182 },
  { id: 'YTD', days: 'ytd' },
  { id: '1Y', days: 365 },
];

const dailyCache = new Map<string, { at: number; bars: OHLCV[] }>();

async function dailyBars(chart: Vela, symbol: string): Promise<OHLCV[]> {
  const hit = dailyCache.get(symbol);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.bars;
  const r = chart.data.resolve(symbol);
  if (!r) return [];
  const provider = chart.data.providerInstance(r.provider);
  if (!provider) return [];
  const bars = await provider.getBars(r.ticker, '1D', { from: Date.now() - 400 * DAY, to: Date.now() });
  dailyCache.set(symbol, { at: Date.now(), bars });
  return bars;
}

function closeOnOrBefore(bars: OHLCV[], t: number): number | undefined {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i]!.time <= t) return bars[i]!.close;
  return undefined;
}

function fmtVol(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—';
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [n, u] of units) if (v >= n) return `${(v / n).toFixed(2)}${u}`;
  return v.toFixed(2);
}

export function mountSymbolDetails(host: HTMLElement, getChart: () => Vela): () => void {
  host.className = 'desk-details';
  host.innerHTML = `
    <div class="desk-details__head">
      <span class="desk-details__sym" data-sym></span>
      <span class="desk-details__venue" data-venue></span>
    </div>
    <div class="desk-details__price"><b data-last>—</b><span data-chg></span></div>
    <div class="desk-details__range">
      <div class="desk-details__range-labels"><span data-lo>—</span><span>Day's range</span><span data-hi>—</span></div>
      <div class="desk-details__range-bar"><i data-pos></i></div>
    </div>
    <div class="desk-details__stats">
      <span>Volume (1D)</span><b data-vol>—</b>
      <span>Prev close</span><b data-prev>—</b>
    </div>
    <div class="desk-details__perf" data-perf></div>
  `;
  const $ = (k: string): HTMLElement => host.querySelector(`[data-${k}]`) as HTMLElement;

  let symbol: string | undefined;
  let bars: OHLCV[] = [];
  let live: number | undefined;
  let token = 0;

  const render = (): void => {
    const last = live ?? bars[bars.length - 1]?.close;
    const today = bars[bars.length - 1];
    const prev = bars[bars.length - 2]?.close;
    $('last').textContent = fmtPrice(last);
    const chgEl = $('chg');
    if (last != null && prev) {
      const d = last - prev;
      const pct = (d / prev) * 100;
      chgEl.textContent = `${d >= 0 ? '+' : '−'}${fmtPrice(Math.abs(d))}  ${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`;
      chgEl.className = d >= 0 ? 'is-up' : 'is-down';
    } else {
      chgEl.textContent = '';
    }
    if (today) {
      const lo = Math.min(today.low, last ?? today.low);
      const hi = Math.max(today.high, last ?? today.high);
      $('lo').textContent = fmtPrice(lo);
      $('hi').textContent = fmtPrice(hi);
      const pos = hi > lo && last != null ? ((last - lo) / (hi - lo)) * 100 : 50;
      $('pos').style.left = `${Math.max(0, Math.min(100, pos))}%`;
      $('vol').textContent = fmtVol(today.volume ?? 0);
    }
    $('prev').textContent = fmtPrice(prev);

    const perf = $('perf');
    if (!bars.length || last == null) {
      perf.innerHTML = '';
      return;
    }
    const now = Date.now();
    perf.innerHTML = PERIODS.map((p) => {
      const from =
        p.days === 'ytd' ? Date.UTC(new Date(now).getUTCFullYear(), 0, 1) - 1 : now - p.days * DAY;
      const base = bars[0]!.time <= from ? closeOnOrBefore(bars, from) : undefined;
      if (base == null) return `<div class="desk-perf"><b>—</b><span>${p.id}</span></div>`;
      const pct = ((last - base) / base) * 100;
      const cls = pct >= 0 ? 'is-up' : 'is-down';
      return `<div class="desk-perf ${cls}"><b>${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%</b><span>${p.id}</span></div>`;
    }).join('');
  };

  const load = async (): Promise<void> => {
    const chart = getChart();
    const sym = chart.market.symbol;
    if (!sym) return;
    if (sym !== symbol) {
      symbol = sym;
      bars = [];
      live = undefined;
      $('sym').textContent = displaySymbol(sym);
      $('venue').textContent = (chart.data.displayPrefix(sym) ?? '').toUpperCase();
      render();
    }
    const my = ++token;
    try {
      const b = await dailyBars(chart, sym);
      if (my !== token) return;
      bars = b;
      render();
    } catch (err) {
      console.warn('[details]', err);
    }
  };

  const chart = getChart();
  const offMarket = chart.on('market:changed', () => void load());
  const offBar = chart.on('bar', (bar) => {
    live = bar.close;
    render();
  });
  const offQuotes = onHlQuotes((map) => {
    if (!symbol) return;
    const q = map.get(symbol);
    if (q) {
      live = q.price;
      render();
    }
  });
  const timer = window.setInterval(() => void load(), 5 * 60_000);
  void load();

  return () => {
    offMarket();
    offBar();
    offQuotes();
    clearInterval(timer);
  };
}
