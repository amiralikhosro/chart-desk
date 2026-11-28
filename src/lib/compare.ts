/**
 * TradingView-style "Compare symbol": another market drawn as a line over the price
 * pane, rebased so both start together at the left edge of the view (what TradingView's
 * percent-scale compare shows). The legend reads the compared symbol's % change since
 * that point. Each comparison is a native indicator with a `symbol` input, so Vela
 * persists it with the chart and saved layouts carry it.
 */
import type { NativeIndicator, NativeIndicatorContext, OHLCV, InputValue, Vela, VisibleRange } from '@luxalgo/vela';
import { registerIcon, registerNativeIndicator, registerWidgetAction } from '@luxalgo/vela/plugin';
import { getWatchlist } from './watchlist-store';
import { parseSymbol } from './symbol-search';

export const COMPARE_TYPE = 'desk.compare';
export const COMPARE_COLORS = ['#ff9800', '#e040fb', '#00bcd4', '#ffeb3b', '#8bc34a', '#f06292', '#90a4ae'];

registerIcon(
  'desk-compare',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 12l3.5-4 3 2.5L14 4"/><path d="M2 9l3.5 1.5 3-4L14 8" stroke-dasharray="2 1.5"/></svg>',
);

let chartsOf: () => Vela[] = () => [];

/** The charts compare instances may live on (for their visible range). */
export function setCompareCharts(fn: () => Vela[]): void {
  chartsOf = fn;
}

const poll = (symbol: string): number => (symbol.toLowerCase().startsWith('hyperliquid:') ? 15_000 : 5_000);

/** Short display name: `lbank:ETHUSDT.P` → `ETHUSDT.P`. */
export function shortName(symbol: string): string {
  return symbol.split(':').slice(1).join(':') || symbol;
}

class CompareIndicator implements NativeIndicator {
  private ctx: NativeIndicatorContext | null = null;
  private symbol = '';
  private color = COMPARE_COLORS[0]!;
  private width = 2;
  private other: OHLCV[] = [];
  private fetchedFrom = Infinity;
  private token = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private anchorTime: number | null = null;
  private raf = 0;
  private loading = false;

  start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
    this.ctx = ctx;
    this.apply(inputs);
  }

  onBars(): void {
    const first = this.ctx?.bars()[0]?.time;
    // History landed in front of what we fetched: fetch the compared symbol that far back too.
    if (first != null && first < this.fetchedFrom) void this.load(true);
    else this.schedule();
  }

  onViewport(range: VisibleRange): void {
    if (range.from !== this.anchorTime) {
      this.anchorTime = range.from;
      this.schedule();
    }
  }

  setInputs(inputs: Record<string, InputValue>): void {
    this.apply(inputs);
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
    cancelAnimationFrame(this.raf);
    this.token++;
    this.ctx = null;
  }

  private apply(inputs: Record<string, InputValue>): void {
    const symbol = String(inputs.symbol ?? '').trim();
    this.color = String(inputs.color || COMPARE_COLORS[0]);
    this.width = Number(inputs.width) || 2;
    if (symbol !== this.symbol) {
      this.symbol = symbol;
      this.other = [];
      this.fetchedFrom = Infinity;
      void this.load(true);
    } else {
      this.paint();
    }
    this.startTimer();
  }

  private startTimer(): void {
    this.stopTimer();
    if (!this.symbol || !this.ctx?.live) return;
    this.timer = setInterval(() => void this.load(false), poll(this.symbol));
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** `full`: (re)fetch from the chart's first bar; otherwise just the tail. */
  private async load(full: boolean): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.symbol) {
      ctx.emit({ series: [], labels: [] });
      ctx.setStatus('idle');
      return;
    }
    if (this.loading && !full) return;
    const bars = ctx.bars();
    if (!bars.length) return;
    const r = ctx.data.resolve(this.symbol);
    const provider = r && ctx.data.providerInstance(r.provider);
    if (!r || !provider) {
      ctx.setStatus('idle');
      return;
    }
    const my = ++this.token;
    this.loading = true;
    if (full) ctx.setStatus('loading');
    try {
      const from = full || !this.other.length ? bars[0]!.time : this.other[Math.max(0, this.other.length - 2)]!.time;
      const got = await provider.getBars(r.ticker, ctx.timeframe, { from, to: Date.now() });
      if (my !== this.token || !this.ctx) return;
      if (full || !this.other.length) {
        this.other = got;
        this.fetchedFrom = bars[0]!.time;
      } else {
        const byTime = new Map(this.other.map((b) => [b.time, b] as const));
        for (const b of got) byTime.set(b.time, b);
        this.other = [...byTime.values()].sort((a, b) => a.time - b.time);
      }
      ctx.setStatus(ctx.live ? 'live' : 'idle');
      this.paint();
    } catch (err) {
      console.warn('[compare]', this.symbol, err);
      if (my === this.token) ctx.setStatus('idle');
    } finally {
      if (my === this.token) this.loading = false;
    }
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  private paint(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const bars = ctx.bars();
    const other = this.other;
    if (!bars.length || !other.length) {
      ctx.emit({ series: [], labels: [] });
      return;
    }
    // Compared close on/before each chart bar (forward-filled across gaps).
    const aligned: Array<number | null> = new Array(bars.length).fill(null);
    let j = 0;
    let last: number | null = null;
    for (let i = 0; i < bars.length; i++) {
      const t = bars[i]!.time;
      while (j < other.length && other[j]!.time <= t) last = other[j++]!.close;
      aligned[i] = last;
    }
    // Anchor: the first bar in view (or ~150 bars back before the view is known)
    // that both series have.
    const owner = chartsOf().find((c) => c.indicators().some((h) => h.id === ctx.id));
    const from = owner?.getVisibleRange()?.from ?? this.anchorTime;
    if (from != null) this.anchorTime = from;
    let a = from == null ? Math.max(0, bars.length - 150) : bars.findIndex((b) => b.time >= from);
    if (a < 0) a = bars.length - 1;
    while (a < bars.length - 1 && aligned[a] == null) a++;
    const base = aligned[a];
    if (base == null || !(base > 0)) {
      ctx.emit({ series: [], labels: [] });
      return;
    }
    const scale = bars[a]!.close / base;
    const name = shortName(this.symbol);
    const line = bars.map((b, i) => ({ time: b.time, value: aligned[i] == null ? null : aligned[i]! * scale }));
    const pct = bars.map((b, i) => ({ time: b.time, value: aligned[i] == null ? null : (aligned[i]! / base - 1) * 100 }));
    const lastPct = pct[pct.length - 1]?.value;
    const lastVal = line[line.length - 1]?.value;
    ctx.emit({
      series: [
        {
          id: `cmp-${ctx.id}`,
          title: name,
          paneId: '',
          kind: 'line',
          points: line,
          style: { color: this.color, width: this.width, lineStyle: 'solid' },
          display: { legend: false, dataWindow: false },
        },
        {
          id: `cmp-pct-${ctx.id}`,
          title: `${name} %`,
          paneId: '',
          kind: 'line',
          points: pct,
          style: { color: this.color, width: 1, lineStyle: 'solid' },
          display: { pane: false, priceScale: false, legend: true, dataWindow: true },
        },
      ],
      labels:
        lastVal == null || lastPct == null
          ? []
          : [
              {
                id: `cmp-tag-${ctx.id}`,
                paneId: '',
                xloc: 'bar_time',
                x: bars[bars.length - 1]!.time,
                y: lastVal,
                yloc: 'price',
                text: `${name} ${lastPct >= 0 ? '+' : ''}${lastPct.toFixed(2)}%`,
                style: 'label_right',
                color: this.color,
                textColor: '#131722',
                size: 'small',
                textAlign: 'right',
                fontFamily: 'default',
                bold: true,
              },
            ],
    });
  }
}

export function registerCompareIndicator(): void {
  registerNativeIndicator({
    type: COMPARE_TYPE,
    title: 'Compare symbol',
    shortTitle: 'Compare',
    paneHint: 'price',
    overlay: true,
    reactsToViewport: true,
    multiInstance: true,
    inputsSchema: () => [
      { key: 'symbol', title: 'Symbol', type: 'symbol', defval: '' },
      { key: 'color', title: 'Color', type: 'color', defval: COMPARE_COLORS[0]! },
      { key: 'width', title: 'Line width', type: 'int', defval: 2, min: 1, max: 4 },
    ],
    defaultInputs: () => ({ symbol: '', color: COMPARE_COLORS[0]!, width: 2 }),
    create: () => new CompareIndicator(),
  });
}

/** The compare indicators on a chart, with their symbols. */
export function compares(chart: Vela): Array<{ id: string; symbol: string; color: string; remove: () => void }> {
  return chart
    .indicators()
    .filter((h) => h.nativeType === COMPARE_TYPE)
    .map((h) => {
      const v = h.inputValues();
      return { id: h.id, symbol: String(v.symbol ?? ''), color: String(v.color ?? ''), remove: () => h.remove() };
    });
}

export function addCompare(chart: Vela, symbol: string): void {
  const used = new Set(compares(chart).map((c) => c.color));
  const color = COMPARE_COLORS.find((c) => !used.has(c)) ?? COMPARE_COLORS[compares(chart).length % COMPARE_COLORS.length]!;
  chart.addNativeIndicator(COMPARE_TYPE, { inputs: { symbol, color, width: 2 } });
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Row = { symbol: string; ticker: string; desc: string; provider: string };

function searchSymbols(chart: Vela, q: string): Row[] {
  const query = q.trim().toLowerCase();
  const all = chart.data.symbols();
  const rows: Array<Row & { score: number }> = [];
  for (const s of all) {
    const provider = (s.provider ?? '').toLowerCase();
    const ticker = s.ticker;
    const { base, quote, perp } = parseSymbol(s);
    const t = ticker.toLowerCase();
    const b = base.toLowerCase();
    const d = (s.description ?? '').toLowerCase();
    let score: number;
    if (!query) score = 0;
    else if (b === query || t === query) score = 0;
    else if (b.startsWith(query) || t.startsWith(query)) score = 1;
    else if (t.includes(query) || d.includes(query)) score = 2;
    else continue;
    score = score * 10 + (/(USDT?|USDC)$/.test(quote) ? 0 : 3) + (perp ? 0 : 1);
    rows.push({ symbol: `${provider}:${ticker}`, ticker, desc: s.description ?? '', provider, score });
  }
  rows.sort((x, y) => x.score - y.score || x.ticker.length - y.ticker.length);
  return rows.slice(0, 60);
}

/** The Compare dialog: search any symbol, quick-add from the watchlist, remove current ones. */
export function openCompareDialog(chart: Vela): void {
  document.querySelector('.desk-cmp')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'desk-cmp';
  wrap.innerHTML = `
    <div class="desk-cmp__dialog" role="dialog" aria-label="Compare symbol">
      <div class="desk-cmp__head"><b>Compare symbol</b><button type="button" data-act="close" aria-label="Close">✕</button></div>
      <input class="desk-cmp__input" type="text" placeholder="Search symbol, e.g. ETH, gold, lbank sol" spellcheck="false" autocomplete="off">
      <div class="desk-cmp__current" data-current></div>
      <div class="desk-cmp__label" data-label>From your watchlist</div>
      <div class="desk-cmp__list" data-list></div>
      <div class="desk-cmp__foot">Lines start together at the left edge of the chart. The legend shows each symbol's % change since then.</div>
    </div>`;
  document.body.appendChild(wrap);
  const input = wrap.querySelector<HTMLInputElement>('.desk-cmp__input')!;
  const listEl = wrap.querySelector<HTMLElement>('[data-list]')!;
  const currentEl = wrap.querySelector<HTMLElement>('[data-current]')!;
  const labelEl = wrap.querySelector<HTMLElement>('[data-label]')!;
  let rows: Row[] = [];
  let sel = 0;

  const close = (): void => {
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
  };

  const renderCurrent = (): void => {
    const cur = compares(chart);
    currentEl.innerHTML = cur.length
      ? cur
          .map(
            (c) =>
              `<span class="desk-cmp__pill" style="--c:${esc(c.color)}"><i></i>${esc(shortName(c.symbol) || '(none)')}<button type="button" data-remove="${esc(c.id)}" aria-label="Remove ${esc(c.symbol)}">✕</button></span>`,
          )
          .join('')
      : '';
  };

  const renderList = (): void => {
    const q = input.value;
    if (q.trim()) {
      rows = searchSymbols(chart, q);
      labelEl.textContent = rows.length ? 'Symbols' : 'No matches';
    } else {
      rows = getWatchlist()
        .filter((w) => w.symbol !== chart.market.symbol)
        .map((w) => ({ symbol: w.symbol, ticker: w.label, desc: w.symbol, provider: w.symbol.split(':')[0] ?? '' }));
      labelEl.textContent = 'From your watchlist';
    }
    sel = Math.min(sel, Math.max(0, rows.length - 1));
    const have = new Set(compares(chart).map((c) => c.symbol.toLowerCase()));
    listEl.innerHTML = rows
      .map(
        (r, i) => `<button type="button" class="desk-cmp__row${i === sel ? ' is-sel' : ''}" data-i="${i}">
          <b>${esc(r.ticker)}</b><span>${esc(r.desc)}</span><em>${esc(r.provider)}</em>${have.has(r.symbol.toLowerCase()) ? '<small>added</small>' : ''}
        </button>`,
      )
      .join('');
  };

  const pick = (r: Row | undefined): void => {
    if (!r) return;
    if (r.symbol === chart.market.symbol) return;
    if (compares(chart).some((c) => c.symbol.toLowerCase() === r.symbol.toLowerCase())) return;
    addCompare(chart, r.symbol);
    input.value = '';
    // The handle list updates synchronously; repaint pills and the list.
    renderCurrent();
    renderList();
    input.focus();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(0, Math.min(rows.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      renderList();
      listEl.querySelector('.is-sel')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && document.activeElement === input) {
      e.preventDefault();
      pick(rows[sel]);
    }
  };
  document.addEventListener('keydown', onKey, true);

  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) close();
  });
  wrap.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-act="close"]')) return close();
    const rm = t.closest<HTMLElement>('[data-remove]')?.dataset.remove;
    if (rm) {
      compares(chart).find((c) => c.id === rm)?.remove();
      renderCurrent();
      renderList();
      return;
    }
    const i = t.closest<HTMLElement>('[data-i]')?.dataset.i;
    if (i != null) pick(rows[Number(i)]);
  });
  input.addEventListener('input', () => {
    sel = 0;
    renderList();
  });

  renderCurrent();
  renderList();
  input.focus();
}

export function registerCompareAction(): void {
  registerCompareIndicator();
  registerWidgetAction({
    id: 'desk.compare',
    target: 'topbar',
    align: 'left',
    label: 'Compare',
    icon: 'desk-compare',
    order: 10,
    run: (ctx) => openCompareDialog(ctx.chart),
  });
}

/**
 * Vela's legend row shows the type's short title ("Compare") for every instance and
 * carries no instance id. Relabel the rows in order with each compare's symbol, the
 * way TradingView's legend names the compared market.
 */
export function installCompareLegend(getChart: () => Vela): void {
  let raf = 0;
  const relabel = (): void => {
    raf = 0;
    let chart: Vela;
    try {
      chart = getChart();
    } catch {
      return;
    }
    const names = compares(chart).map((c) => ({ name: shortName(c.symbol) || 'Compare', color: c.color }));
    const titles = [...document.querySelectorAll<HTMLElement>('span[style*="font-weight: 600"]')].filter((el) => {
      const row = el.parentElement?.parentElement;
      return !!row?.querySelector('.vela-ind-ctl') && (el.textContent === 'Compare' || el.dataset.deskCmp != null);
    });
    titles.forEach((el, i) => {
      const n = names[i];
      if (!n) return;
      el.dataset.deskCmp = '';
      if (el.textContent !== n.name) el.textContent = n.name;
      if (el.style.color !== n.color) el.style.color = n.color;
    });
  };
  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(relabel);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
}
