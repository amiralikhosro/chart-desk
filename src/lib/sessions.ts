/**
 * FX liquidity sessions with DST-correct local opens/closes.
 * Boxes span session open→close in time and session high→low in price.
 */
import type { OHLCV } from '@luxalgo/vela';

export type SessionDef = {
  id: string;
  label: string;
  letter: string;
  timeZone: string;
  open: { h: number; m: number };
  close: { h: number; m: number };
  /** Box border */
  lineColor: string;
  /** Box fill (with opacity set on the drawing) */
  fillColor: string;
  markColor: string;
};

/** Classic FX sessions — Mon–Fri in each session's local timezone. */
export const FX_SESSIONS: SessionDef[] = [
  {
    id: 'asia',
    label: 'Asia',
    letter: 'A',
    timeZone: 'Asia/Tokyo',
    open: { h: 9, m: 0 },
    close: { h: 18, m: 0 },
    lineColor: 'rgba(255, 152, 0, 0.85)',
    fillColor: 'rgba(255, 152, 0, 0.14)',
    markColor: '#ff9800',
  },
  {
    id: 'london',
    label: 'London',
    letter: 'L',
    timeZone: 'Europe/London',
    open: { h: 8, m: 0 },
    close: { h: 16, m: 30 },
    lineColor: 'rgba(41, 98, 255, 0.85)',
    fillColor: 'rgba(41, 98, 255, 0.12)',
    markColor: '#2962FF',
  },
  {
    id: 'newyork',
    label: 'New York',
    letter: 'N',
    timeZone: 'America/New_York',
    open: { h: 8, m: 0 },
    close: { h: 17, m: 0 },
    lineColor: 'rgba(8, 153, 129, 0.85)',
    fillColor: 'rgba(8, 153, 129, 0.12)',
    markColor: '#089981',
  },
];

export type SessionBox = {
  id: string;
  sessionId: string;
  label: string;
  from: number;
  to: number;
  high: number;
  low: number;
  lineColor: string;
  fillColor: string;
  markColor: string;
  letter: string;
};

export type SessionMark = {
  id: string;
  time: number;
  title: string;
  tooltip: string;
  group: string;
  glyph: { shape: 'circle'; color: string; letter: string };
  content: { text: string };
};

/** Tag in drawing text so we can clear session boxes without touching desk lines. */
export const SESSION_TAG = 'SESSION';

/**
 * Convert a wall-clock time in `timeZone` to UTC epoch-ms (DST-aware).
 */
export function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(new Date(utcGuess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return utcGuess - (asIfUtc - utcGuess);
}

function ymdInZone(
  ms: number,
  timeZone: string,
): { y: number; m: number; d: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = dtf.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    weekday: weekdayMap[get('weekday')] ?? 0,
  };
}

function formatLocal(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

function eachLocalDay(
  fromMs: number,
  toMs: number,
  timeZone: string,
  fn: (y: number, m: number, d: number, weekday: number) => void,
): void {
  const step = 12 * 60 * 60 * 1000;
  const start = fromMs - 36 * 60 * 60 * 1000;
  const end = toMs + 36 * 60 * 60 * 1000;
  const seen = new Set<string>();
  for (let t = start; t <= end; t += step) {
    const { y, m, d, weekday } = ymdInZone(t, timeZone);
    const key = `${y}-${m}-${d}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fn(y, m, d, weekday);
  }
}

/** High/low of bars whose open falls inside [from, to). */
export function sessionHighLow(
  bars: readonly OHLCV[],
  from: number,
  to: number,
): { high: number; low: number } | null {
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let hit = false;
  for (const b of bars) {
    if (b.time < from || b.time >= to) continue;
    hit = true;
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  if (!hit || !(high >= low) || !Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low };
}

/**
 * Build session boxes (time × high/low) + open marks for the visible window.
 */
export function buildSessionBoxes(
  fromMs: number,
  toMs: number,
  bars: readonly OHLCV[],
  sessions: SessionDef[] = FX_SESSIONS,
  nowMs = Date.now(),
): { boxes: SessionBox[]; marks: SessionMark[] } {
  const boxes: SessionBox[] = [];
  const marks: SessionMark[] = [];

  for (const s of sessions) {
    eachLocalDay(fromMs, toMs, s.timeZone, (y, m, d, weekday) => {
      if (weekday === 0 || weekday === 6) return;

      const openMs = zonedLocalToUtc(y, m, d, s.open.h, s.open.m, s.timeZone);
      const closeMs = zonedLocalToUtc(y, m, d, s.close.h, s.close.m, s.timeZone);
      if (!(closeMs > openMs)) return;
      if (closeMs <= fromMs || openMs >= toMs) return;
      // Skip sessions that haven't started yet
      if (openMs > nowMs) return;

      const rangeEnd = Math.min(closeMs, nowMs + 1);
      const hl = sessionHighLow(bars, openMs, rangeEnd);
      if (!hl) return;

      const day = `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
      const boxTo = Math.min(closeMs, Math.max(rangeEnd, openMs + 60_000));

      boxes.push({
        id: `sess-${s.id}-${day}`,
        sessionId: s.id,
        label: s.label,
        from: openMs,
        to: boxTo,
        high: hl.high,
        low: hl.low,
        lineColor: s.lineColor,
        fillColor: s.fillColor,
        markColor: s.markColor,
        letter: s.letter,
      });

      if (openMs >= fromMs && openMs < toMs) {
        const openLabel = formatLocal(openMs, s.timeZone);
        const closeLabel = formatLocal(closeMs, s.timeZone);
        marks.push({
          id: `session-mark-${s.id}-${day}`,
          time: openMs,
          title: `${s.label} open`,
          tooltip: `${s.label} · H ${hl.high} / L ${hl.low}`,
          group: 'sessions',
          glyph: { shape: 'circle', color: s.markColor, letter: s.letter },
          content: {
            text: `${s.label} session\nOpen: ${openLabel}\nClose: ${closeLabel}\nHigh: ${hl.high}\nLow: ${hl.low}\nZone: ${s.timeZone}`,
          },
        });
      }
    });
  }

  boxes.sort((a, b) => a.from - b.from);
  marks.sort((a, b) => a.time - b.time);
  return { boxes, marks };
}

export function sessionsUsefulForTf(timeframe: string): boolean {
  const u = timeframe.toUpperCase();
  if (u === 'D' || u === '1D' || u === 'W' || u === '1W' || u === 'M' || u === '1M') return false;
  const n = Number.parseInt(timeframe, 10);
  if (Number.isFinite(n) && n >= 720) return false;
  return true;
}
