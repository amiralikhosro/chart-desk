/**
 * Paper positions and working orders drawn as price lines on the chart —
 * TradingView's position line (avg + P&L), TP / SL lines and order lines.
 * Legend-less: its on/off lives in the trading panel, not the indicator legend.
 */
import type { DrawingLabel, NativeIndicator, NativeIndicatorContext, PriceLine } from '@luxalgo/vela';
import { registerNativeIndicator } from '@luxalgo/vela/plugin';
import {
  fmtPrice,
  fmtSigned,
  getAccount,
  onPaperChange,
  positionFor,
  sameSymbol,
  unrealized,
} from './paper-store';

export const POSITIONS_INDICATOR_TYPE = 'desk.positions';

const BLUE = '#2962ff';
const GREEN = '#089981';
const RED = '#f23645';
const GREY = '#787b86';

function lines(symbol: string): PriceLine[] {
  const out: PriceLine[] = [];
  const pos = positionFor(symbol);
  if (pos) {
    const pnl = unrealized(pos);
    const side = pos.qty > 0 ? 'Long' : 'Short';
    out.push({
      id: 'pos',
      paneId: '',
      price: pos.avgPrice,
      color: pnl == null ? BLUE : pnl >= 0 ? GREEN : RED,
      lineStyle: 'solid',
      width: 1,
      title: `${side} ${Math.abs(pos.qty)}  ${fmtSigned(pnl)}`,
    });
    if (pos.tp != null) {
      out.push({ id: 'tp', paneId: '', price: pos.tp, color: GREEN, lineStyle: 'dashed', width: 1, title: 'TP' });
    }
    if (pos.sl != null) {
      out.push({ id: 'sl', paneId: '', price: pos.sl, color: RED, lineStyle: 'dashed', width: 1, title: 'SL' });
    }
  }
  for (const o of getAccount().orders) {
    if (!sameSymbol(o.symbol, symbol)) continue;
    out.push({
      id: `o-${o.id}`,
      paneId: '',
      price: o.price,
      color: o.side === 'buy' ? BLUE : '#ff9800',
      lineStyle: 'dotted',
      width: 1,
      title: `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.type === 'limit' ? 'LMT' : 'STP'} ${o.qty} @ ${fmtPrice(o.price)}`,
    });
    if (o.tp != null) {
      out.push({ id: `o-${o.id}-tp`, paneId: '', price: o.tp, color: GREY, lineStyle: 'dotted', width: 1, title: 'TP (order)' });
    }
    if (o.sl != null) {
      out.push({ id: `o-${o.id}-sl`, paneId: '', price: o.sl, color: GREY, lineStyle: 'dotted', width: 1, title: 'SL (order)' });
    }
  }
  return out;
}

/** TradingView-style tags at the right edge naming each line. */
function tags(priceLines: PriceLine[], time: number): DrawingLabel[] {
  return priceLines.map((l) => ({
    id: `tag-${l.id}`,
    paneId: '',
    xloc: 'bar_time' as const,
    x: time,
    y: l.price,
    yloc: 'price' as const,
    text: l.title ?? '',
    style: 'label_right' as const,
    color: l.color,
    textColor: '#ffffff',
    size: 'small' as const,
    textAlign: 'right' as const,
    fontFamily: 'default' as const,
    bold: l.id === 'pos',
  }));
}

class PositionsIndicator implements NativeIndicator {
  private ctx: NativeIndicatorContext | null = null;
  private off: (() => void) | null = null;
  private raf = 0;
  private lastKey = '';

  start(ctx: NativeIndicatorContext): void {
    this.ctx = ctx;
    this.off = onPaperChange(() => this.schedule());
    this.paint(true);
  }

  onBars(): void {
    this.schedule();
  }

  onViewport(): void {
    /* price lines span the pane */
  }

  setInputs(): void {
    this.paint(true);
  }

  suspend(): void {
    this.off?.();
    this.off = null;
  }

  resume(): void {
    if (!this.off) this.off = onPaperChange(() => this.schedule());
    this.paint(true);
  }

  stop(): void {
    this.off?.();
    this.off = null;
    cancelAnimationFrame(this.raf);
    this.ctx = null;
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint(false);
    });
  }

  private paint(force: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const priceLines = lines(ctx.symbol);
    const bars = ctx.bars();
    const lastTime = bars[bars.length - 1]?.time;
    const key = JSON.stringify(priceLines) + lastTime;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    ctx.emit({ priceLines, labels: lastTime == null ? [] : tags(priceLines, lastTime) });
    ctx.setStatus('live');
  }
}

let registered = false;

export function registerPositionsIndicator(): void {
  if (registered) return;
  registered = true;
  registerNativeIndicator({
    type: POSITIONS_INDICATOR_TYPE,
    title: 'Paper positions',
    shortTitle: 'Positions',
    paneHint: 'price',
    overlay: true,
    legend: false,
    multiInstance: false,
    inputsSchema: () => [],
    defaultInputs: () => ({}),
    create: () => new PositionsIndicator(),
  });
}
