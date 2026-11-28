/**
 * Sessions as a removable native indicator (Indicators picker + legend ✕).
 * Asia / London / New York high–low boxes — DST-correct local opens/closes.
 */
import type {
  DrawingBox,
  DrawingLabel,
  InputSchema,
  InputValue,
  NativeIndicator,
  NativeIndicatorContext,
  OHLCV,
  Vela,
  VisibleRange,
} from '@luxalgo/vela';
import { registerNativeIndicator } from '@luxalgo/vela/plugin';
import {
  buildSessionBoxes,
  FX_SESSIONS,
  SESSION_TAG,
  sessionsUsefulForTf,
  type SessionDef,
} from '../lib/sessions';

export const SESSIONS_INDICATOR_TYPE = 'sessions';

const DAY = 86_400_000;

const INPUT_SCHEMA: InputSchema[] = [
  {
    key: 'asia',
    title: 'Asia (Tokyo)',
    type: 'bool',
    defval: true,
    group: 'Sessions',
  },
  {
    key: 'london',
    title: 'London',
    type: 'bool',
    defval: true,
    group: 'Sessions',
  },
  {
    key: 'newyork',
    title: 'New York',
    type: 'bool',
    defval: true,
    group: 'Sessions',
  },
  {
    key: 'labels',
    title: 'Open labels',
    type: 'bool',
    defval: false,
    group: 'Display',
  },
];

function bool(inputs: Record<string, InputValue>, key: string, fallback: boolean): boolean {
  const v = inputs[key];
  return typeof v === 'boolean' ? v : fallback;
}

function activeSessions(inputs: Record<string, InputValue>): SessionDef[] {
  return FX_SESSIONS.filter((s) => bool(inputs, s.id, true));
}

function toBoxes(sessionBoxes: ReturnType<typeof buildSessionBoxes>['boxes']): DrawingBox[] {
  return sessionBoxes.map((b) => ({
    id: b.id,
    paneId: '',
    xloc: 'bar_time' as const,
    left: b.from,
    top: b.high,
    right: b.to,
    bottom: b.low,
    extend: 'none' as const,
    bgColor: b.fillColor,
    borderColor: b.lineColor,
    borderWidth: 1,
    borderStyle: 'solid' as const,
    text: '',
    textColor: b.markColor,
    textSize: 'tiny' as const,
    hAlign: 'left' as const,
    vAlign: 'top' as const,
    wrap: false,
    fontFamily: 'default' as const,
    bold: false,
    italic: false,
  }));
}

function toLabels(
  marks: ReturnType<typeof buildSessionBoxes>['marks'],
): DrawingLabel[] {
  return marks.map((m) => ({
    id: m.id,
    paneId: '',
    xloc: 'bar_time' as const,
    x: m.time,
    y: 0,
    yloc: 'abovebar' as const,
    text: m.glyph.letter,
    style: 'circle' as const,
    color: m.glyph.color,
    textColor: '#ffffff',
    size: 'tiny' as const,
    textAlign: 'center' as const,
    tooltip: m.tooltip,
    fontFamily: 'default' as const,
    bold: true,
  }));
}

function windowFor(bars: readonly OHLCV[], range: VisibleRange | null): {
  from: number;
  to: number;
} | null {
  let from: number;
  let to: number;
  if (range && range.to > range.from) {
    from = range.from - DAY;
    to = range.to + DAY;
  } else if (bars.length) {
    from = bars[0]!.time;
    to = bars[bars.length - 1]!.time + DAY;
  } else {
    return null;
  }
  const span = to - from;
  const maxSpan = 21 * DAY;
  if (span > maxSpan) from = to - maxSpan;
  return { from, to };
}

class SessionsIndicator implements NativeIndicator {
  private ctx: NativeIndicatorContext | null = null;
  private inputs: Record<string, InputValue> = {};
  private range: VisibleRange | null = null;

  start(ctx: NativeIndicatorContext, inputs: Record<string, InputValue>): void {
    this.ctx = ctx;
    this.inputs = inputs;
    this.paint();
  }

  onBars(): void {
    this.paint();
  }

  onViewport(range: VisibleRange): void {
    this.range = range;
    this.paint();
  }

  setInputs(inputs: Record<string, InputValue>): void {
    this.inputs = inputs;
    if (this.ctx) this.paint();
  }

  suspend(): void {
    /* no timers */
  }

  resume(): void {
    this.paint();
  }

  stop(): void {
    this.ctx = null;
    this.range = null;
  }

  private paint(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const tf = ctx.timeframe;
    if (!sessionsUsefulForTf(tf)) {
      ctx.emit({ boxes: [], labels: [] });
      ctx.setStatus('idle');
      return;
    }

    const sessions = activeSessions(this.inputs);
    if (!sessions.length) {
      ctx.emit({ boxes: [], labels: [] });
      ctx.setStatus('idle');
      return;
    }

    const bars = ctx.bars();
    const win = windowFor(bars, this.range);
    if (!win || !bars.length) {
      ctx.emit({ boxes: [], labels: [] });
      ctx.setStatus('idle');
      return;
    }

    const { boxes, marks } = buildSessionBoxes(win.from, win.to, bars, sessions);
    const showLabels = bool(this.inputs, 'labels', false);
    ctx.emit({
      boxes: toBoxes(boxes),
      labels: showLabels ? toLabels(marks) : [],
    });
    ctx.setStatus('idle');
  }
}

let registered = false;

/** Register once before the workspace mounts. */
export function registerSessionsIndicator(): void {
  if (registered) return;
  registered = true;
  registerNativeIndicator({
    type: SESSIONS_INDICATOR_TYPE,
    title: 'Sessions',
    shortTitle: 'Sessions',
    paneHint: 'price',
    overlay: true,
    reactsToViewport: true,
    waitsForHistory: true,
    multiInstance: false,
    inputsSchema: () => INPUT_SCHEMA,
    defaultInputs: () =>
      Object.fromEntries(INPUT_SCHEMA.map((i) => [i.key, i.defval])),
    create: () => new SessionsIndicator(),
  });
}

/** Remove leftover drawing-tool boxes from the pre-indicator sessions overlay. */
export function clearLegacySessionDrawings(chart: Vela): void {
  try {
    const ids = chart.drawings
      .all()
      .filter((d) => {
        const text = d.text?.value ?? '';
        return text.includes(SESSION_TAG) || d.id.startsWith('sess-');
      })
      .map((d) => d.id);
    if (ids.length) chart.drawings.removeMany(ids);
  } catch {
    /* optional */
  }
  try {
    chart.renderer.set('highlights', []);
  } catch {
    /* optional */
  }
  try {
    const keep = chart.marks.all().filter((m) => m.group !== 'sessions');
    chart.marks.set(keep);
  } catch {
    /* optional */
  }
}
