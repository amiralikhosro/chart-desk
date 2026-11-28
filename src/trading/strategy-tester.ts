/**
 * TradingView's Strategy Tester: a bottom strip that appears while a Pine strategy runs
 * on the active chart. Tabs: Overview (headline stats + equity curve), Performance
 * Summary (all / long / short), and List of trades (click a trade to jump to it).
 * Data is what the scripting engine reports through `script:run` (`StrategyState`) and
 * the run's trade ledger.
 */
import type { ScriptRun, StrategyState, StrategyTrade } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { registerWidgetAttachment } from '@luxalgo/vela/plugin';
import { fmtMoney, fmtPrice } from './paper-store';
import { tfMs } from '../lib/bottombar';
import './strategy-tester.css';

type Entry = { id: string; cell: string; title: string; state?: StrategyState; trades: readonly StrategyTrade[]; at: number };
type Tab = 'overview' | 'summary' | 'trades';

const LS_KEY = 'chart-desk-strategy-tester';
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const sgn = (n: number | undefined): string => (n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}${fmtMoney(Math.abs(n))}`);
const pct = (n: number | undefined, digits = 2): string => (n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}%`);
const cls = (n: number | undefined): string => (n == null || !Number.isFinite(n) || n === 0 ? '' : n > 0 ? 'is-up' : 'is-down');
const fmtQty = (q: number): string => q.toLocaleString('en-US', { maximumFractionDigits: q >= 100 ? 2 : 6 });
const when = (t: number): string =>
  new Date(t).toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

type Stats = {
  net: number;
  grossProfit: number;
  grossLoss: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  avg: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  ratio: number;
};

function stats(trades: readonly StrategyTrade[]): Stats {
  const closed = trades.filter((t) => !t.open && t.pnl != null);
  const pnls = closed.map((t) => t.pnl!);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const gp = wins.reduce((a, b) => a + b, 0);
  const gl = -losses.reduce((a, b) => a + b, 0);
  const avgWin = wins.length ? gp / wins.length : 0;
  const avgLoss = losses.length ? gl / losses.length : 0;
  return {
    net: gp - gl,
    grossProfit: gp,
    grossLoss: gl,
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avg: closed.length ? (gp - gl) / closed.length : 0,
    avgWin,
    avgLoss,
    largestWin: wins.length ? Math.max(...wins) : 0,
    largestLoss: losses.length ? -Math.min(...losses) : 0,
    ratio: avgLoss > 0 ? avgWin / avgLoss : 0,
  };
}

/** Equity curve (initial capital + cumulative closed P&L) as an SVG area. */
function equitySvg(trades: readonly StrategyTrade[], capital: number): string {
  const closed = trades.filter((t) => !t.open && t.pnl != null && t.exit);
  if (closed.length < 2) return '<div class="desk-st__empty">Not enough closed trades for an equity curve.</div>';
  const pts = [capital];
  for (const t of closed) pts.push(pts[pts.length - 1]! + t.pnl!);
  const w = 1000;
  const h = 140;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * w, h - 6 - ((v - lo) / span) * (h - 12)] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const baseY = h - 6 - ((capital - lo) / span) * (h - 12);
  const up = pts[pts.length - 1]! >= capital;
  const col = up ? '#089981' : '#f23645';
  return `<svg class="desk-st__equity" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Equity curve">
    <defs><linearGradient id="desk-st-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" x2="${w}" y1="${baseY.toFixed(1)}" y2="${baseY.toFixed(1)}" stroke="#434651" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
    <path d="${line}L${w},${h}L0,${h}Z" fill="url(#desk-st-g)"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

export function registerStrategyTester(getWs: () => VelaWorkspace | null): void {
  registerWidgetAttachment({
    id: 'desk.strategy-tester',
    mount: (ctx) => {
      const entries = new Map<string, Entry>();
      let selected: string | null = null;
      let ui: { open: boolean; tab: Tab } = { open: true, tab: 'overview' };
      try {
        ui = { ...ui, ...(JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Partial<typeof ui>) };
      } catch {
        /* ignore */
      }
      const saveUi = (): void => localStorage.setItem(LS_KEY, JSON.stringify(ui));

      const el = document.createElement('section');
      el.className = 'desk-st';
      el.setAttribute('aria-label', 'Strategy tester');
      el.hidden = true;
      const dock = ctx.dockStrip(el, { position: 'below-bottombar' });

      const activeCell = (): string | undefined => getWs()?.cells().find((c) => c.chart === ctx.chart)?.id;
      const live = (): Entry[] => {
        const ids = new Set(ctx.chart.indicators().map((h) => h.id));
        const cell = activeCell();
        return [...entries.values()].filter((e) => ids.has(e.id) && (!cell || e.cell === cell));
      };

      const render = (): void => {
        const list = live();
        el.hidden = list.length === 0;
        if (!list.length) return;
        const cur = list.find((e) => e.id === selected) ?? list[0]!;
        selected = cur.id;
        const s = cur.state;
        const st = stats(cur.trades);
        const capital = s?.initialCapital ?? 0;
        const net = s?.netPnl ?? st.net;
        const head = `
          <header class="desk-st__bar">
            <button type="button" class="desk-st__title" data-act="toggle"><span class="desk-st__caret">▸</span> Strategy Tester</button>
            ${
              list.length > 1
                ? `<select data-pick>${list.map((e) => `<option value="${esc(e.id)}"${e.id === cur.id ? ' selected' : ''}>${esc(e.title)}</option>`).join('')}</select>`
                : `<span class="desk-st__name">${esc(cur.title)}</span>`
            }
            <nav class="desk-st__tabs">
              <button type="button" data-tab="overview"${ui.tab === 'overview' ? ' class="is-active"' : ''}>Overview</button>
              <button type="button" data-tab="summary"${ui.tab === 'summary' ? ' class="is-active"' : ''}>Performance Summary</button>
              <button type="button" data-tab="trades"${ui.tab === 'trades' ? ' class="is-active"' : ''}>List of trades</button>
            </nav>
            <span class="desk-st__quick">Net ${esc(sgn(net))} · ${st.trades} trades · ${st.winRate.toFixed(1)}% win</span>
          </header>`;
        let body = '';
        if (ui.tab === 'overview') {
          const tiles: Array<[string, string, string]> = [
            ['Net profit', `${sgn(net)}${capital ? ` <small>${pct((net / capital) * 100)}</small>` : ''}`, cls(net)],
            ['Total closed trades', String(st.trades), ''],
            ['Percent profitable', `${st.winRate.toFixed(2)}% <small>${st.wins}/${st.trades}</small>`, ''],
            ['Profit factor', Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(3) : '∞', ''],
            ['Max drawdown', s ? `${fmtMoney(s.maxDrawdown)}${capital ? ` <small>${(s.maxDrawdown / capital * 100).toFixed(2)}%</small>` : ''}` : '—', s?.maxDrawdown ? 'is-down' : ''],
            ['Avg trade', sgn(st.avg), cls(st.avg)],
            ['Avg # bars in trades', '—', ''],
          ];
          // Bars in trade from entry/exit times and the chart timeframe.
          const tf = tfMs(ctx.chart.market.timeframe ?? '60');
          const closed = cur.trades.filter((t) => t.exit);
          if (closed.length) tiles[6]![1] = String(Math.round(closed.reduce((a, t) => a + (t.exit!.time - t.entry.time) / tf, 0) / closed.length));
          body = `<div class="desk-st__tiles">${tiles.map(([l, v, c]) => `<div class="desk-st__tile"><span>${l}</span><b class="${c}">${v}</b></div>`).join('')}</div>${equitySvg(cur.trades, capital)}`;
        } else if (ui.tab === 'summary') {
          const longT = cur.trades.filter((t) => t.side === 'long');
          const shortT = cur.trades.filter((t) => t.side === 'short');
          const [a, l, sh] = [st, stats(longT), stats(shortT)];
          const row = (label: string, f: (x: Stats) => string, c?: (x: Stats) => string): string =>
            `<tr><td>${label}</td>${[a, l, sh].map((x) => `<td class="${c ? c(x) : ''}">${f(x)}</td>`).join('')}</tr>`;
          body = `<table class="desk-st__table"><thead><tr><th></th><th>All</th><th>Long</th><th>Short</th></tr></thead><tbody>
            ${row('Net profit', (x) => sgn(x.net), (x) => cls(x.net))}
            ${row('Gross profit', (x) => fmtMoney(x.grossProfit), () => 'is-up')}
            ${row('Gross loss', (x) => fmtMoney(x.grossLoss), () => 'is-down')}
            ${row('Profit factor', (x) => (Number.isFinite(x.profitFactor) ? x.profitFactor.toFixed(3) : '∞'))}
            ${row('Total closed trades', (x) => String(x.trades))}
            ${row('Winning trades', (x) => String(x.wins))}
            ${row('Losing trades', (x) => String(x.losses))}
            ${row('Percent profitable', (x) => `${x.winRate.toFixed(2)}%`)}
            ${row('Avg trade', (x) => sgn(x.avg), (x) => cls(x.avg))}
            ${row('Avg winning trade', (x) => fmtMoney(x.avgWin), () => 'is-up')}
            ${row('Avg losing trade', (x) => fmtMoney(x.avgLoss), () => 'is-down')}
            ${row('Ratio avg win / avg loss', (x) => x.ratio.toFixed(3))}
            ${row('Largest winning trade', (x) => fmtMoney(x.largestWin), () => 'is-up')}
            ${row('Largest losing trade', (x) => fmtMoney(x.largestLoss), () => 'is-down')}
            <tr><td>Max drawdown</td><td colspan="3">${s ? fmtMoney(s.maxDrawdown) : '—'}</td></tr>
            <tr><td>Max run-up</td><td colspan="3">${s ? fmtMoney(s.maxRunup) : '—'}</td></tr>
            <tr><td>Sharpe ratio</td><td colspan="3">${s?.sharpe != null ? s.sharpe.toFixed(3) : '—'}</td></tr>
            <tr><td>Sortino ratio</td><td colspan="3">${s?.sortino != null ? s.sortino.toFixed(3) : '—'}</td></tr>
            <tr><td>Buy &amp; hold return</td><td colspan="3" class="${cls(s?.buyHoldPnl)}">${s?.buyHoldPnl != null ? `${sgn(s.buyHoldPnl)} (${pct(s.buyHoldPct)})` : '—'}</td></tr>
            <tr><td>Open P&amp;L</td><td colspan="3" class="${cls(s?.openPnl)}">${s ? sgn(s.openPnl) : '—'}</td></tr>
            <tr><td>Initial capital</td><td colspan="3">${capital ? fmtMoney(capital) : '—'}</td></tr>
          </tbody></table>`;
        } else {
          let cum = 0;
          const rows = cur.trades.map((t, i) => {
            if (t.pnl != null && !t.open) cum += t.pnl;
            const ret = t.pnl != null ? (t.pnl / (t.entry.price * t.qty)) * 100 : undefined;
            return `<tr data-t="${t.entry.time}" data-t2="${t.exit?.time ?? t.entry.time}">
              <td rowspan="2">${i + 1}</td><td class="${t.side === 'long' ? 'is-up' : 'is-down'}">${t.side === 'long' ? 'Long' : 'Short'}</td>
              <td>Entry</td><td>${esc(t.entry.id)}</td><td>${when(t.entry.time)}</td><td>${fmtPrice(t.entry.price)}</td>
              <td rowspan="2">${fmtQty(t.qty)}</td>
              <td rowspan="2" class="${cls(t.pnl)}">${t.open ? 'Open' : `${sgn(t.pnl)}<small>${pct(ret)}</small>`}</td>
              <td rowspan="2" class="${cls(cum)}">${sgn(cum)}</td>
              <td rowspan="2">${t.maxRunup != null ? fmtMoney(t.maxRunup) : '—'}</td>
              <td rowspan="2">${t.maxDrawdown != null ? fmtMoney(t.maxDrawdown) : '—'}</td>
            </tr><tr data-t="${t.exit?.time ?? t.entry.time}" data-t2="${t.exit?.time ?? t.entry.time}"><td></td><td>Exit</td><td>${esc(t.exit?.id ?? '')}</td><td>${t.exit ? when(t.exit.time) : '—'}</td><td>${t.exit ? fmtPrice(t.exit.price) : '—'}</td></tr>`;
          });
          body = rows.length
            ? `<table class="desk-st__table desk-st__trades"><thead><tr><th>#</th><th>Side</th><th>Type</th><th>Signal</th><th>Date/Time</th><th>Price</th><th>Qty</th><th>Profit</th><th>Cum. profit</th><th>Run-up</th><th>Drawdown</th></tr></thead><tbody>${rows.reverse().join('')}</tbody></table>`
            : '<div class="desk-st__empty">The strategy has no trades on this chart.</div>';
        }
        const scroll = el.querySelector('.desk-st__body')?.scrollTop ?? 0;
        el.innerHTML = `${head}<div class="desk-st__body">${body}</div>`;
        el.classList.toggle('is-open', ui.open);
        const b = el.querySelector('.desk-st__body');
        if (b) b.scrollTop = scroll;
      };

      el.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const tab = t.closest<HTMLElement>('[data-tab]')?.dataset.tab as Tab | undefined;
        if (tab) {
          ui.tab = tab;
          ui.open = true;
          saveUi();
          return render();
        }
        if (t.closest('[data-act="toggle"]')) {
          ui.open = !ui.open;
          saveUi();
          render();
          window.dispatchEvent(new Event('resize'));
          return;
        }
        // Jump to a trade on the chart.
        const row = t.closest<HTMLElement>('tr[data-t]');
        if (row) {
          const a = Number(row.dataset.t);
          const z = Number(row.dataset.t2);
          const tf = tfMs(ctx.chart.market.timeframe ?? '60');
          ctx.chart.setVisibleRange({ from: Math.min(a, z) - 40 * tf, to: Math.max(a, z) + 40 * tf });
        }
      });
      el.addEventListener('change', (e) => {
        const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('[data-pick]');
        if (sel) {
          selected = sel.value;
          render();
        }
      });

      let pending = 0;
      let offRun: (() => void) | undefined;
      // The strip mounts while the workspace is still being built: subscribe once it exists.
      const subscribe = (): void => {
        const ws = getWs();
        if (!ws) {
          setTimeout(subscribe, 50);
          return;
        }
        offRun = ws.on('script:run', onRun);
      };
      const onRun = (run: ScriptRun & { cell: string }): void => {
        if (run.kind !== 'strategy') return;
        const prev = entries.get(run.id);
        const entry: Entry = { id: run.id, cell: run.cell, title: run.title, state: run.strategy, trades: prev?.trades ?? [], at: Date.now() };
        entries.set(run.id, entry);
        // The ledger is async and can be large: fetch it at most every 2 s per strategy.
        if (!prev || Date.now() - (prev.at ?? 0) > 2_000 || run.first) {
          void run.trades().then((tr) => {
            entry.trades = tr;
            render();
          });
        }
        if (!pending) pending = requestAnimationFrame(() => ((pending = 0), render()));
      };
      subscribe();
      const offInd = ctx.chart.on('indicator:removed' as never, () => render());
      const offMarket = ctx.chart.on('market:changed', () => render());
      render();
      return () => {
        offRun?.();
        offInd?.();
        offMarket();
        dock();
        el.remove();
      };
    },
  });
}
