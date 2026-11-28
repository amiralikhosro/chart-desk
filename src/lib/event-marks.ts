/**
 * TradingView's chart event marks above the time axis:
 *  - **Economic events** from the week's calendar (`/feeds/calendar`): high- and
 *    medium-impact USD releases plus high-impact EUR/GBP/JPY/CNY, red / orange tokens;
 *  - **Paper trades**: every paper fill on the charted symbol (B / S), like
 *    TradingView's executions on chart.
 * Both groups get a checkbox in the chart settings' Events tab.
 */
import type { TimelineMark, Vela } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { fmtPrice, fmtSigned, getAccount, onPaperChange, sameSymbol } from '../trading/paper-store';

type CalEvent = { title: string; country: string; date: string; impact: string; forecast?: string; previous?: string; actual?: string };

const CODES: Record<string, string> = { USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', CNY: 'CN', CAD: 'CA', AUD: 'AU', NZD: 'NZ', CHF: 'CH' };
const MAJOR_HIGH = new Set(['EUR', 'GBP', 'JPY', 'CNY']);

let events: CalEvent[] = [];

async function loadCalendar(): Promise<void> {
  try {
    const res = await fetch('/feeds/calendar');
    if (res.ok) events = (await res.json()) as CalEvent[];
  } catch {
    /* keep the last set */
  }
}

function economicMarks(): TimelineMark[] {
  return events
    .filter((e) => (e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium')) || (MAJOR_HIGH.has(e.country) && e.impact === 'High'))
    .map((e, i) => {
      const time = Date.parse(e.date);
      const when = new Date(time).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      return {
        id: `econ-${i}-${time}`,
        time,
        title: `${e.country} · ${e.title}`,
        group: 'economic',
        tooltip: `${e.country} ${e.title} (${e.impact})`,
        glyph: { shape: 'circle' as const, color: e.impact === 'High' ? '#f23645' : '#ff9800', letter: CODES[e.country] ?? e.country.slice(0, 2) },
        content: {
          panel: {
            items: [
              { type: 'field' as const, label: 'Time', value: when },
              { type: 'field' as const, label: 'Impact', value: e.impact },
              ...(e.actual ? [{ type: 'field' as const, label: 'Actual', value: e.actual }] : []),
              { type: 'field' as const, label: 'Forecast', value: e.forecast || '—' },
              { type: 'field' as const, label: 'Previous', value: e.previous || '—' },
            ],
          },
        },
      };
    })
    .filter((m) => Number.isFinite(m.time));
}

function tradeMarks(symbol: string | undefined): TimelineMark[] {
  if (!symbol) return [];
  return getAccount()
    .history.filter((f) => sameSymbol(f.symbol, symbol))
    .map((f) => ({
      id: `fill-${f.id}`,
      time: f.time,
      title: `${f.side === 'buy' ? 'Buy' : 'Sell'} ${f.qty} @ ${fmtPrice(f.price)}`,
      group: 'paper-trades',
      tooltip: `${f.reason}: ${f.side === 'buy' ? 'Buy' : 'Sell'} ${f.qty} @ ${fmtPrice(f.price)}`,
      glyph: { shape: 'square' as const, color: f.side === 'buy' ? '#2962ff' : '#f23645', letter: f.side === 'buy' ? 'B' : 'S' },
      content: {
        panel: {
          items: [
            { type: 'field' as const, label: 'Time', value: new Date(f.time).toLocaleString([], { hourCycle: 'h23' }) },
            { type: 'field' as const, label: 'Order', value: f.reason },
            { type: 'field' as const, label: 'Price', value: fmtPrice(f.price) },
            { type: 'field' as const, label: 'Quantity', value: String(f.qty) },
            ...(f.realized ? [{ type: 'field' as const, label: 'Realized P&L', value: fmtSigned(f.realized) }] : []),
          ],
        },
      },
    }));
}

function paint(chart: Vela): void {
  if (!chart.marks.supported) return;
  chart.marks.set([...economicMarks(), ...tradeMarks(chart.market.symbol)]);
}

export function installEventMarks(ws: VelaWorkspace): void {
  const charts = (): Vela[] => ws.cells().map((c) => c.chart);
  const seed = (chart: Vela): void => {
    chart.marks.defineGroup({ id: 'economic', label: 'Economic events' });
    chart.marks.defineGroup({ id: 'paper-trades', label: 'Paper trades' });
    void chart.ready().then(() => paint(chart));
    chart.on('market:changed', () => paint(chart));
  };
  for (const c of charts()) seed(c);
  ws.on('cell:created', ({ id }) => {
    const c = ws.cell(id)?.chart;
    if (c) seed(c);
  });
  let lastFills = getAccount().history.length;
  onPaperChange(() => {
    const n = getAccount().history.length;
    if (n === lastFills) return;
    lastFills = n;
    for (const c of charts()) paint(c);
  });
  const refresh = async (): Promise<void> => {
    await loadCalendar();
    for (const c of charts()) paint(c);
  };
  void refresh();
  setInterval(() => void refresh(), 30 * 60_000);
}
