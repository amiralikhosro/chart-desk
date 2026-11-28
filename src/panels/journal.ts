/**
 * Trade Journal side panel for the paper account.
 *
 * Closed trades (round trips) are rebuilt from the netting account's fill history:
 * per symbol, fills are walked oldest → newest tracking the signed position. A trade
 * opens when the position leaves 0 and closes when it returns to 0; a fill that flips
 * the position closes one trade and opens the next with the remainder.
 *
 * Notes per trade (text, setup tags, grade, emotion, planned risk for R, a chart
 * screenshot) live in localStorage `chart-desk-journal-v1`; screenshots go to the
 * server blob store (`PUT /api/blob/<id>`) with an inline data-URL fallback.
 */
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { registerIcon, registerSidePanel } from '@luxalgo/vela/plugin';
import * as paper from '../trading/paper-store';
import type { PaperFill } from '../trading/paper-store';
import './journal.css';

registerIcon(
  'desk-journal',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4z"/><path d="M4 2.5v11M2.5 5h3M2.5 8h3M2.5 11h3"/><path d="M7.5 6h3.5M7.5 8.5h3.5" opacity=".7"/></svg>',
);

// ───────────────────────────── types ─────────────────────────────

type TradeSide = 'long' | 'short';

export type JournalTrade = {
  key: string;
  symbol: string;
  side: TradeSide;
  openTime: number;
  /** Null while the position is still open. */
  closeTime: number | null;
  entry: number;
  exit: number | null;
  maxQty: number;
  pnl: number;
  fills: number;
  open: boolean;
  /** History hit its cap: the oldest trade of a symbol may be missing earlier fills. */
  partial: boolean;
};

type Grade = 'A' | 'B' | 'C';
type Shot = { id: string; url?: string; dataUrl?: string; at: number };
type TradeNote = {
  note: string;
  tags: string[];
  grade?: Grade;
  emotion?: string;
  /** Planned risk in account currency — R = P&L / risk. */
  risk?: number;
  shot?: Shot;
  updatedAt: number;
};
type JournalDoc = { notes: Record<string, TradeNote>; tags: string[] };

type Range = '7D' | '30D' | '90D' | 'All';
type Tab = 'overview' | 'trades';
type Breakdown = 'symbol' | 'hour' | 'weekday';
type Ui = { tab: Tab; range: Range; symbol: string; side: '' | TradeSide; tag: string; breakdown: Breakdown };

const LS_KEY = 'chart-desk-journal-v1';
const UI_KEY = 'chart-desk-journal-ui';
const DEFAULT_TAGS = ['Breakout', 'Pullback', 'Reversal', 'Range', 'News', 'Other'];
const EMOTIONS = ['Calm', 'Confident', 'FOMO', 'Fearful', 'Revenge', 'Bored'];
const GRADES: Grade[] = ['A', 'B', 'C'];
const RANGES: Range[] = ['7D', '30D', '90D', 'All'];
const RANGE_MS: Record<Range, number> = { '7D': 7 * 864e5, '30D': 30 * 864e5, '90D': 90 * 864e5, All: Infinity };
const DEFAULT_UI: Ui = { tab: 'overview', range: 'All', symbol: '', side: '', tag: '', breakdown: 'symbol' };
const HISTORY_CAP = 500;
const INLINE_SHOT_CAP = 600_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ───────────────────────────── storage ─────────────────────────────

function loadDoc(): JournalDoc {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const d = JSON.parse(raw) as Partial<JournalDoc>;
      return {
        notes: d.notes && typeof d.notes === 'object' ? d.notes : {},
        tags: Array.isArray(d.tags) && d.tags.length ? d.tags.filter((t) => typeof t === 'string') : [...DEFAULT_TAGS],
      };
    }
  } catch {
    /* ignore */
  }
  return { notes: {}, tags: [...DEFAULT_TAGS] };
}

function saveDoc(d: JournalDoc): boolean {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

function loadUi(): Ui {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) return { ...DEFAULT_UI, ...(JSON.parse(raw) as Partial<Ui>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_UI };
}

function saveUi(u: Ui): void {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(u));
  } catch {
    /* ignore */
  }
}

// ───────────────────────────── helpers ─────────────────────────────

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** `hyperliquid:xyz:GOLD` → `GOLD`, `lbank:BTCUSDT.P` → `BTCUSDT.P`. */
const shortSym = (s: string): string => s.split(':').pop() || s;

const cls = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) || n === 0 ? '' : n > 0 ? 'is-up' : 'is-down');

function getMode(): 'live' | 'replay' {
  const fn = (paper as unknown as Record<string, unknown>).getMode;
  if (typeof fn !== 'function') return 'live';
  try {
    return (fn as () => unknown)() === 'replay' ? 'replay' : 'live';
  } catch {
    return 'live';
  }
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Chart runs on UTC — the journal shows UTC too so times line up with the axis. */
function fmtTime(t: number): string {
  const d = new Date(t);
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${mon} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const isoUtc = (t: number | null): string => (t == null ? '' : new Date(t).toISOString());

/** Vela timeframe (`'60'`, `'1D'`, `'1W'`, `'1M'`, `'30S'`) → bar length in ms. */
function tfMs(tf: string | undefined): number {
  if (!tf) return 3600_000;
  const m = tf.match(/^(\d*)([SDWM]?)$/i);
  if (!m) return 3600_000;
  const n = Number(m[1] || 1);
  const u = m[2]!.toUpperCase();
  if (u === 'S') return n * 1000;
  if (u === 'D') return n * 864e5;
  if (u === 'W') return n * 7 * 864e5;
  if (u === 'M') return n * 30 * 864e5;
  return n * 60_000;
}

const returnPct = (t: JournalTrade): number => {
  const notional = t.entry * t.maxQty;
  return notional > 0 ? (t.pnl / notional) * 100 : 0;
};

const rMultiple = (t: JournalTrade, n: TradeNote | undefined): number | null =>
  !t.open && n?.risk != null && n.risk > 0 ? t.pnl / n.risk : null;

// ───────────────────────────── round trips ─────────────────────────────

/**
 * Rebuild round trips from a newest-first fill list (the paper account's `history`).
 * Symbols are grouped the way the engine nets them (`sameSymbol`).
 */
export function buildTrades(history: readonly PaperFill[], keyPrefix = ''): JournalTrade[] {
  const EPS = 1e-9;
  type Cur = {
    side: TradeSide;
    openTime: number;
    entryQty: number;
    entrySum: number;
    exitQty: number;
    exitSum: number;
    maxQty: number;
    pnl: number;
    fills: number;
  };
  type State = { symbol: string; pos: number; cur: Cur | null; first: boolean };
  const states: State[] = [];
  const out: JournalTrade[] = [];
  const truncated = history.length >= HISTORY_CAP;
  const usedKeys = new Set<string>();

  const stateFor = (sym: string): State => {
    let s = states.find((x) => paper.sameSymbol(x.symbol, sym));
    if (!s) {
      s = { symbol: sym, pos: 0, cur: null, first: true };
      states.push(s);
    }
    return s;
  };

  const start = (s: State, sign: number, qty: number, price: number, time: number): void => {
    s.cur = {
      side: sign > 0 ? 'long' : 'short',
      openTime: time,
      entryQty: qty,
      entrySum: qty * price,
      exitQty: 0,
      exitSum: 0,
      maxQty: qty,
      pnl: 0,
      fills: 1,
    };
    s.pos = sign * qty;
  };

  const finish = (s: State, closeTime: number | null): void => {
    const c = s.cur!;
    let key = `${keyPrefix}${s.symbol}|${c.openTime}`;
    for (let i = 2; usedKeys.has(key); i++) key = `${keyPrefix}${s.symbol}|${c.openTime}#${i}`;
    usedKeys.add(key);
    out.push({
      key,
      symbol: s.symbol,
      side: c.side,
      openTime: c.openTime,
      closeTime,
      entry: c.entrySum / c.entryQty,
      exit: c.exitQty > 0 ? c.exitSum / c.exitQty : null,
      maxQty: c.maxQty,
      pnl: c.pnl,
      fills: c.fills,
      open: closeTime == null,
      partial: truncated && s.first,
    });
    s.first = false;
    s.cur = null;
  };

  for (let i = history.length - 1; i >= 0; i--) {
    const f = history[i]!;
    if (!(f.qty > 0) || !Number.isFinite(f.price)) continue;
    const s = stateFor(f.symbol);
    const d = f.side === 'buy' ? f.qty : -f.qty;
    const realized = Number.isFinite(f.realized) ? f.realized : 0;

    if (Math.abs(s.pos) < EPS || !s.cur) {
      // A closing fill while we think we're flat: its opening fills fell off the capped history.
      if (realized !== 0 && truncated && s.first) continue;
      start(s, Math.sign(d), f.qty, f.price, f.time);
      continue;
    }

    const c = s.cur;
    c.fills++;
    if (Math.sign(d) === Math.sign(s.pos)) {
      c.entryQty += f.qty;
      c.entrySum += f.qty * f.price;
      s.pos += d;
      c.maxQty = Math.max(c.maxQty, Math.abs(s.pos));
      continue;
    }

    const closing = Math.min(Math.abs(s.pos), f.qty);
    c.exitQty += closing;
    c.exitSum += closing * f.price;
    c.pnl += realized;
    const next = s.pos + d;
    if (Math.abs(next) < EPS * Math.max(1, f.qty)) {
      s.pos = 0;
      finish(s, f.time);
    } else if (Math.sign(next) !== Math.sign(s.pos)) {
      finish(s, f.time);
      start(s, Math.sign(next), Math.abs(next), f.price, f.time);
    } else {
      s.pos = next;
    }
  }
  for (const s of states) if (s.cur) finish(s, null);
  return out;
}

// ───────────────────────────── stats ─────────────────────────────

type Stats = {
  n: number;
  wins: number;
  losses: number;
  net: number;
  grossWin: number;
  grossLoss: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  maxDd: number;
  maxDdPct: number;
  avgDur: number;
  avgR: number | null;
  rCount: number;
};

function computeStats(closed: readonly JournalTrade[], start: number, notes: Record<string, TradeNote>): Stats {
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const net = grossWin - grossLoss;
  let eq = start;
  let peak = start;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const t of [...closed].sort((a, b) => a.closeTime! - b.closeTime!)) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }
  const rs = closed.map((t) => rMultiple(t, notes[t.key])).filter((r): r is number => r != null);
  return {
    n: closed.length,
    wins: wins.length,
    losses: losses.length,
    net,
    grossWin,
    grossLoss,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: closed.length ? net / closed.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
    maxDd,
    maxDdPct: maxDdPct * 100,
    avgDur: closed.length ? closed.reduce((a, t) => a + (t.closeTime! - t.openTime), 0) / closed.length : 0,
    avgR: rs.length ? rs.reduce((a, r) => a + r, 0) / rs.length : null,
    rCount: rs.length,
  };
}

/** Realized equity curve — same approach as the strategy tester's `equitySvg`. */
function equitySvg(closed: readonly JournalTrade[], start: number): string {
  const sorted = [...closed].sort((a, b) => a.closeTime! - b.closeTime!);
  if (sorted.length < 1) return '<div class="desk-jr__empty">No closed trades for an equity curve yet.</div>';
  const pts = [start];
  for (const t of sorted) pts.push(pts[pts.length - 1]! + t.pnl);
  const w = 1000;
  const h = 140;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * w, h - 6 - ((v - lo) / span) * (h - 12)] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const baseY = h - 6 - ((start - lo) / span) * (h - 12);
  const up = pts[pts.length - 1]! >= start;
  const col = up ? '#089981' : '#f23645';
  return `<div class="desk-jr__eqlab"><span>High <b>${paper.fmtMoney(hi)}</b></span><span>Low <b>${paper.fmtMoney(lo)}</b></span><span>Now <b class="${up ? 'is-up' : 'is-down'}">${paper.fmtMoney(pts[pts.length - 1])}</b></span></div>
    <svg class="desk-jr__equity" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Realized equity curve">
    <defs><linearGradient id="desk-jr-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" x2="${w}" y1="${baseY.toFixed(1)}" y2="${baseY.toFixed(1)}" stroke="#434651" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
    <path d="${line}L${w},${h}L0,${h}Z" fill="url(#desk-jr-g)"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

type Bucket = { label: string; n: number; wins: number; net: number };

function bucketize(closed: readonly JournalTrade[], keyOf: (t: JournalTrade) => string, labels?: string[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const l of labels ?? []) map.set(l, { label: l, n: 0, wins: 0, net: 0 });
  for (const t of closed) {
    const k = keyOf(t);
    const b = map.get(k) ?? { label: k, n: 0, wins: 0, net: 0 };
    b.n++;
    if (t.pnl > 0) b.wins++;
    b.net += t.pnl;
    map.set(k, b);
  }
  return [...map.values()];
}

function bucketTable(rows: Bucket[], head: string, skipEmpty = false): string {
  const shown = skipEmpty ? rows.filter((b) => b.n) : rows;
  if (!shown.some((b) => b.n)) return '<div class="desk-jr__empty">No closed trades in this view.</div>';
  const maxAbs = Math.max(...shown.map((b) => Math.abs(b.net)), 1e-9);
  return `<table class="desk-jr__table"><thead><tr><th>${head}</th><th>Trades</th><th>Win %</th><th class="desk-jr__barcol">Net P&amp;L</th></tr></thead><tbody>
    ${shown
      .map((b) => {
        const wpct = b.n ? `${((b.wins / b.n) * 100).toFixed(0)}%` : '—';
        const width = b.n ? Math.max(2, (Math.abs(b.net) / maxAbs) * 100) : 0;
        return `<tr class="${b.n ? '' : 'is-dim'}"><td>${esc(b.label)}</td><td>${b.n || '—'}</td><td>${wpct}</td>
          <td class="desk-jr__barcol"><span class="desk-jr__hbar ${b.net >= 0 ? 'is-up' : 'is-down'}" style="width:${width.toFixed(1)}%"></span><span class="${cls(b.net)}">${b.n ? paper.fmtSigned(b.net) : ''}</span></td></tr>`;
      })
      .join('')}
  </tbody></table>`;
}

function hourChart(closed: readonly JournalTrade[]): string {
  const hours = bucketize(closed, (t) => String(new Date(t.openTime).getUTCHours()), Array.from({ length: 24 }, (_, i) => String(i)));
  if (!hours.some((b) => b.n)) return '<div class="desk-jr__empty">No closed trades in this view.</div>';
  const maxAbs = Math.max(...hours.map((b) => Math.abs(b.net)), 1e-9);
  const w = 24 * 20;
  const h = 120;
  const mid = h / 2;
  const bars = hours
    .map((b, i) => {
      const bh = b.n ? Math.max(1.5, (Math.abs(b.net) / maxAbs) * (mid - 14)) : 0;
      const y = b.net >= 0 ? mid - bh : mid;
      const col = b.net >= 0 ? '#089981' : '#f23645';
      const tip = `${String(i).padStart(2, '0')}:00 UTC · ${b.n} trade${b.n === 1 ? '' : 's'}${b.n ? ` · win ${((b.wins / b.n) * 100).toFixed(0)}% · ${paper.fmtSigned(b.net)}` : ''}`;
      return `<g><title>${esc(tip)}</title><rect x="${i * 20}" y="0" width="20" height="${h}" fill="transparent"/>${b.n ? `<rect x="${i * 20 + 3}" y="${y.toFixed(1)}" width="14" height="${bh.toFixed(1)}" rx="1.5" fill="${col}"/>` : ''}${b.n ? `<text x="${i * 20 + 10}" y="${(b.net >= 0 ? y - 3 : y + bh + 10).toFixed(1)}" text-anchor="middle" class="desk-jr__cnt">${b.n}</text>` : ''}</g>`;
    })
    .join('');
  const ticks = [0, 3, 6, 9, 12, 15, 18, 21].map((i) => `<span style="left:${((i * 20 + 10) / w) * 100}%">${String(i).padStart(2, '0')}</span>`).join('');
  const best = [...hours].filter((b) => b.n).sort((a, b) => b.net - a.net);
  return `<svg class="desk-jr__hours" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Net P&amp;L by UTC hour of entry">
      <line x1="0" x2="${w}" y1="${mid}" y2="${mid}" stroke="#434651" vector-effect="non-scaling-stroke"/>${bars}</svg>
    <div class="desk-jr__ticks">${ticks}</div>
    <div class="desk-jr__hint">Net P&amp;L by hour of entry (UTC). Best ${esc(best[0]!.label.padStart(2, '0'))}:00 (${paper.fmtSigned(best[0]!.net)}), worst ${esc(best[best.length - 1]!.label.padStart(2, '0'))}:00 (${paper.fmtSigned(best[best.length - 1]!.net)}).</div>`;
}

// ───────────────────────────── screenshots ─────────────────────────────

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

/** Shrink a PNG data URL (to JPEG) until it fits the inline cap; null if it never does. */
async function shrinkDataUrl(dataUrl: string, cap: number): Promise<string | null> {
  if (dataUrl.length <= cap) return dataUrl;
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  for (const [maxW, q] of [
    [1400, 0.8],
    [1100, 0.72],
    [900, 0.65],
    [700, 0.6],
  ] as const) {
    const scale = Math.min(1, maxW / img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/jpeg', q);
    if (out.length <= cap) return out;
  }
  return null;
}

async function uploadShot(id: string, dataUrl: string): Promise<string> {
  const res = await fetch(`/api/blob/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: await dataUrlToBlob(dataUrl),
  });
  if (!res.ok) throw new Error(`blob ${res.status}`);
  let url = `/api/blob/${encodeURIComponent(id)}`;
  try {
    const j = (await res.json()) as { url?: unknown };
    if (typeof j.url === 'string' && j.url) url = j.url;
  } catch {
    throw new Error('blob: bad response');
  }
  return url;
}

const shotSrc = (s: Shot): string => s.dataUrl ?? s.url ?? `/api/blob/${encodeURIComponent(s.id)}`;

// ───────────────────────────── CSV ─────────────────────────────

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tradesCsv(trades: readonly JournalTrade[], notes: Record<string, TradeNote>): string {
  const head = [
    'key', 'symbol', 'side', 'status', 'open_time_utc', 'close_time_utc', 'avg_entry', 'avg_exit', 'max_qty',
    'realized_pnl', 'return_pct', 'duration_min', 'fills', 'planned_risk', 'r_multiple', 'tags', 'grade', 'emotion',
    'note', 'screenshot',
  ];
  const rows = trades.map((t) => {
    const n = notes[t.key];
    const r = rMultiple(t, n);
    const shot = n?.shot ? (n.shot.dataUrl ? '(inline)' : new URL(shotSrc(n.shot), location.href).href) : '';
    return [
      t.key, t.symbol, t.side, t.open ? 'open' : 'closed', isoUtc(t.openTime), isoUtc(t.closeTime), t.entry,
      t.exit ?? '', t.maxQty, t.open ? '' : t.pnl.toFixed(2), t.open ? '' : returnPct(t).toFixed(3),
      t.closeTime != null ? ((t.closeTime - t.openTime) / 60_000).toFixed(1) : '', t.fills, n?.risk ?? '',
      r != null ? r.toFixed(2) : '', (n?.tags ?? []).join('; '), n?.grade ?? '', n?.emotion ?? '', n?.note ?? '', shot,
    ].map(csvCell).join(',');
  });
  return [head.join(','), ...rows].join('\r\n');
}

// ───────────────────────────── panel ─────────────────────────────

export function registerJournalPanel(getWs: () => VelaWorkspace | null): void {
  registerSidePanel({
    id: 'desk.journal',
    title: 'Journal',
    icon: 'desk-journal',
    order: 9,
    width: 420,
    resizable: true,
    minWidth: 340,
    maxWidth: 760,
    placement: 'column',
    maximizable: true,
    mount: (ctx, body) => {
      let doc = loadDoc();
      const ui = loadUi();
      let trades: JournalTrade[] = [];
      let sig = '';
      let expanded: string | null = null;
      let editTags = false;
      let pending = false;
      let busyShot: string | null = null;
      let saveTimer: ReturnType<typeof setTimeout> | null = null;

      const toast = (m: string, k: 'info' | 'success' | 'error' = 'info'): void => {
        try {
          ctx.toast(m, k);
        } catch {
          /* no toaster */
        }
      };

      body.className = 'desk-panel desk-jr';
      body.innerHTML = `
        <div class="desk-jr__tabs" role="tablist">
          <button type="button" role="tab" data-tab="overview">Overview</button>
          <button type="button" role="tab" data-tab="trades">Trades <span class="desk-jr__count" data-count></span></button>
          <span class="desk-jr__spacer"></span>
          <span class="desk-jr__badge" data-mode hidden>Practice (replay)</span>
          <button type="button" class="desk-jr__btn" data-act="csv" title="Export the filtered trades with notes as CSV">Export CSV</button>
        </div>
        <div class="desk-jr__filters" data-filters></div>
        <div class="desk-jr__scroll" data-scroll></div>`;
      const filtersEl = body.querySelector<HTMLElement>('[data-filters]')!;
      const scrollEl = body.querySelector<HTMLElement>('[data-scroll]')!;
      const modeEl = body.querySelector<HTMLElement>('[data-mode]')!;
      const countEl = body.querySelector<HTMLElement>('[data-count]')!;

      const noteFor = (key: string): TradeNote | undefined => doc.notes[key];
      const ensureNote = (key: string): TradeNote => {
        let n = doc.notes[key];
        if (!n) {
          n = { note: '', tags: [], updatedAt: Date.now() };
          doc.notes[key] = n;
        }
        return n;
      };
      const persist = (now = false): void => {
        if (saveTimer) clearTimeout(saveTimer);
        const run = (): void => {
          saveTimer = null;
          // Drop empty notes so the synced doc stays small.
          for (const [k, n] of Object.entries(doc.notes)) {
            if (!n.note.trim() && !n.tags.length && !n.grade && !n.emotion && n.risk == null && !n.shot) delete doc.notes[k];
          }
          if (!saveDoc(doc)) toast('Journal could not be saved (browser storage full?)', 'error');
        };
        if (now) run();
        else saveTimer = setTimeout(run, 400);
      };

      function recompute(): boolean {
        const acc = paper.getAccount();
        const mode = getMode();
        const h = acc.history;
        const next = `${mode}|${h.length}|${h[0]?.id ?? ''}|${h[h.length - 1]?.id ?? ''}|${acc.startBalance}`;
        if (next === sig) return false;
        sig = next;
        trades = buildTrades(h, mode === 'replay' ? 'replay|' : '');
        return true;
      }

      function filtered(): JournalTrade[] {
        const since = ui.range === 'All' ? -Infinity : Date.now() - RANGE_MS[ui.range];
        return trades.filter((t) => {
          if ((t.closeTime ?? t.openTime) < since) return false;
          if (ui.symbol && t.symbol !== ui.symbol) return false;
          if (ui.side && t.side !== ui.side) return false;
          if (ui.tag && !(noteFor(t.key)?.tags ?? []).includes(ui.tag)) return false;
          return true;
        });
      }

      const chip = (attr: string, value: string, label: string, on: boolean, extra = ''): string =>
        `<button type="button" class="desk-jr__chip${on ? ' is-active' : ''}" data-${attr}="${esc(value)}" aria-pressed="${on}"${extra}>${esc(label)}</button>`;

      function renderFilters(): void {
        const symbols = [...new Set(trades.map((t) => t.symbol))];
        if (ui.symbol && !symbols.includes(ui.symbol)) symbols.push(ui.symbol);
        const tags = [...new Set([...doc.tags, ...(ui.tag ? [ui.tag] : [])])];
        const opt = (v: string, l: string, sel: string): string => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`;
        filtersEl.innerHTML = `
          <div class="desk-jr__seg">${RANGES.map((r) => chip('range', r, r, ui.range === r)).join('')}</div>
          <select data-f="symbol" aria-label="Symbol">${opt('', 'All symbols', ui.symbol)}${symbols.map((s) => opt(s, shortSym(s), ui.symbol)).join('')}</select>
          <select data-f="side" aria-label="Side">${opt('', 'Long & short', ui.side)}${opt('long', 'Long', ui.side)}${opt('short', 'Short', ui.side)}</select>
          <select data-f="tag" aria-label="Setup tag">${opt('', 'All setups', ui.tag)}${tags.map((t) => opt(t, t, ui.tag)).join('')}</select>`;
      }

      function tile(label: string, value: string, c = '', sub = ''): string {
        return `<div class="desk-jr__tile"><span>${label}</span><b class="${c}">${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
      }

      function renderOverview(rows: JournalTrade[]): string {
        const closed = rows.filter((t) => !t.open);
        const start = paper.getAccount().startBalance;
        const s = computeStats(closed, start, doc.notes);
        const openN = rows.length - closed.length;
        const pf = s.n ? (Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞') : '—';
        const ratio = s.avgLoss > 0 ? (s.avgWin / s.avgLoss).toFixed(2) : '—';
        const tiles = [
          tile('Net P&amp;L', s.n ? paper.fmtSigned(s.net) : '—', cls(s.net), s.n && start > 0 ? `${((s.net / start) * 100).toFixed(2)}% of start` : ''),
          tile('Trades', String(s.n), '', `${s.wins}W · ${s.losses}L${openN ? ` · ${openN} open` : ''}`),
          tile('Win rate', s.n ? `${s.winRate.toFixed(1)}%` : '—', s.n ? (s.winRate >= 50 ? 'is-up' : 'is-down') : ''),
          tile('Profit factor', pf, s.n ? (s.profitFactor >= 1 ? 'is-up' : 'is-down') : ''),
          tile('Expectancy', s.n ? paper.fmtSigned(s.expectancy) : '—', cls(s.expectancy), 'per trade'),
          tile('Avg win / loss', s.n ? `${paper.fmtMoney(s.avgWin)} / ${paper.fmtMoney(s.avgLoss)}` : '—', '', `ratio ${ratio}`),
          tile('Largest win', s.wins ? paper.fmtSigned(s.largestWin) : '—', s.wins ? 'is-up' : ''),
          tile('Largest loss', s.losses ? paper.fmtSigned(s.largestLoss) : '—', s.losses ? 'is-down' : ''),
          tile('Max drawdown', s.n ? paper.fmtMoney(s.maxDd) : '—', s.maxDd > 0 ? 'is-down' : '', s.n ? `${s.maxDdPct.toFixed(2)}% from peak` : ''),
          tile('Avg duration', s.n ? fmtDuration(s.avgDur) : '—'),
          tile('Avg R', s.avgR != null ? `${s.avgR >= 0 ? '+' : '−'}${Math.abs(s.avgR).toFixed(2)}R` : '—', s.avgR != null ? cls(s.avgR) : '', s.rCount ? `${s.rCount} with planned risk` : 'enter risk in notes'),
        ].join('');

        let bd = '';
        if (ui.breakdown === 'symbol') {
          bd = bucketTable(bucketize(closed, (t) => shortSym(t.symbol)).sort((a, b) => b.net - a.net), 'Symbol');
        } else if (ui.breakdown === 'hour') {
          bd = hourChart(closed);
        } else {
          bd = bucketTable(bucketize(closed, (t) => WEEKDAYS[(new Date(t.openTime).getUTCDay() + 6) % 7]!, WEEKDAYS), 'Day (UTC)');
        }

        const partial = trades.some((t) => t.partial);
        return `<div class="desk-jr__overview">
          <div class="desk-jr__tiles">${tiles}</div>
          <section class="desk-jr__card"><h4>Equity (realized)</h4>${equitySvg(closed, start)}</section>
          <section class="desk-jr__card"><h4>Breakdown <span class="desk-jr__seg is-small">${chip('bd', 'symbol', 'Symbol', ui.breakdown === 'symbol')}${chip('bd', 'hour', 'Hour', ui.breakdown === 'hour')}${chip('bd', 'weekday', 'Weekday', ui.breakdown === 'weekday')}</span></h4>${bd}</section>
          ${partial ? '<div class="desk-jr__hint">The paper history keeps the last 500 fills, so the oldest trade per symbol may be incomplete (marked ≈).</div>' : ''}
        </div>`;
      }

      function noteForm(t: JournalTrade): string {
        const n = noteFor(t.key);
        const tags = n?.tags ?? [];
        const r = rMultiple(t, n);
        const shot = n?.shot;
        const tagChips = doc.tags
          .map((tag) =>
            editTags
              ? `<span class="desk-jr__chip is-edit">${esc(tag)}<button type="button" data-deltag="${esc(tag)}" aria-label="Remove tag ${esc(tag)}">×</button></span>`
              : chip('tag', tag, tag, tags.includes(tag)),
          )
          .join('');
        const orphanTags = tags.filter((x) => !doc.tags.includes(x)).map((x) => chip('tag', x, x, true)).join('');
        return `<div class="desk-jr__form" data-form="${esc(t.key)}">
          <div class="desk-jr__facts">
            <span>Entry <b>${paper.fmtPrice(t.entry)}</b></span>
            <span>Exit <b>${t.exit != null ? paper.fmtPrice(t.exit) : '—'}</b></span>
            <span>Max qty <b>${t.maxQty.toLocaleString('en-US', { maximumFractionDigits: 6 })}</b></span>
            <span>Fills <b>${t.fills}</b></span>
            <span>Return <b class="${cls(t.pnl)}">${t.open ? '—' : `${returnPct(t).toFixed(2)}%`}</b></span>
          </div>
          <label class="desk-jr__lab">Note</label>
          <textarea data-note rows="3" placeholder="Why did you take it? What did you see? What would you do differently?">${esc(n?.note ?? '')}</textarea>
          <div class="desk-jr__lab">Setup <button type="button" class="desk-jr__link" data-act="edittags">${editTags ? 'Done' : 'Edit list'}</button></div>
          <div class="desk-jr__chips">${tagChips}${editTags ? '' : orphanTags}${editTags ? '<input data-newtag placeholder="New tag ↵" maxlength="24">' : ''}</div>
          <div class="desk-jr__grid2">
            <div><div class="desk-jr__lab">Grade</div><div class="desk-jr__chips">${GRADES.map((g) => chip('grade', g, g, n?.grade === g)).join('')}</div></div>
            <div><div class="desk-jr__lab">Planned risk ($)</div>
              <div class="desk-jr__risk"><input data-risk type="number" min="0" step="any" inputmode="decimal" placeholder="e.g. 100" value="${n?.risk != null ? n.risk : ''}">
              <span class="${r != null ? cls(r) : ''}" data-rout>${r != null ? `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R` : ''}</span></div></div>
          </div>
          <div class="desk-jr__lab">Emotion</div>
          <div class="desk-jr__chips">${EMOTIONS.map((e) => chip('emotion', e, e, n?.emotion === e)).join('')}</div>
          <div class="desk-jr__lab">Chart</div>
          <div class="desk-jr__shot">
            ${shot ? `<button type="button" class="desk-jr__thumb" data-act="openshot" title="Open full size"><img alt="Chart screenshot for this trade" src="${esc(shotSrc(shot))}" loading="lazy"></button>` : ''}
            <div class="desk-jr__shotbtns">
              <button type="button" class="desk-jr__btn" data-act="frame">Show on chart</button>
              <button type="button" class="desk-jr__btn is-primary" data-act="shot"${busyShot === t.key ? ' disabled' : ''}>${busyShot === t.key ? 'Saving…' : shot ? 'Replace screenshot' : 'Attach chart screenshot'}</button>
              ${shot ? `<button type="button" class="desk-jr__btn" data-act="delshot">Remove</button>${shot.dataUrl ? '<span class="desk-jr__warn" title="The server blob store was unavailable; the image is kept in this browser only">local only</span>' : ''}` : ''}
            </div>
          </div>
        </div>`;
      }

      function renderTrades(rows: JournalTrade[]): string {
        if (!rows.length) {
          return `<div class="desk-jr__empty">${trades.length ? 'No trades match these filters.' : 'No paper trades yet. Fills from the paper account show up here as round trips.'}</div>`;
        }
        const sorted = [...rows].sort((a, b) => {
          if (a.open !== b.open) return a.open ? -1 : 1;
          return (b.closeTime ?? b.openTime) - (a.closeTime ?? a.openTime);
        });
        return `<div class="desk-jr__list">${sorted
          .map((t) => {
            const n = noteFor(t.key);
            const r = rMultiple(t, n);
            const open = expanded === t.key;
            const dur = (t.closeTime ?? Date.now()) - t.openTime;
            const marks = [
              n?.grade ? `<span class="desk-jr__grade is-${n.grade.toLowerCase()}">${n.grade}</span>` : '',
              ...(n?.tags ?? []).slice(0, 2).map((x) => `<span class="desk-jr__tag">${esc(x)}</span>`),
              n?.note?.trim() ? '<span class="desk-jr__ico" title="Has a note">✎</span>' : '',
              n?.shot ? '<span class="desk-jr__ico" title="Has a screenshot">▣</span>' : '',
            ].join('');
            return `<div class="desk-jr__trade${open ? ' is-open' : ''}" data-key="${esc(t.key)}">
              <div class="desk-jr__row" data-row role="button" tabindex="0" aria-expanded="${open}" title="${esc(`${t.symbol} · click to frame on the chart and open notes`)}">
                <span class="desk-jr__caret" data-act="toggle" aria-hidden="true">${open ? '▾' : '▸'}</span>
                <div class="desk-jr__c1">
                  <div><b>${esc(shortSym(t.symbol))}</b><span class="desk-jr__side is-${t.side}">${t.side === 'long' ? 'Long' : 'Short'}</span>${t.open ? '<span class="desk-jr__live">Open</span>' : ''}${t.partial ? '<span class="desk-jr__warn" title="Earlier fills fell off the 500-fill history">≈</span>' : ''}</div>
                  <div class="desk-jr__sub">${fmtTime(t.openTime)} · ${fmtDuration(dur)}${marks ? ` <span class="desk-jr__marks">${marks}</span>` : ''}</div>
                </div>
                <div class="desk-jr__c2">
                  <div class="${cls(t.pnl)}"${t.open && t.pnl ? ' title="Realized so far on partial closes"' : ''}>${t.open ? (t.pnl ? paper.fmtSigned(t.pnl) : '—') : paper.fmtSigned(t.pnl)}</div>
                  <div class="desk-jr__sub">${t.open ? `${paper.fmtPrice(t.entry)}` : `${returnPct(t) >= 0 ? '+' : ''}${returnPct(t).toFixed(2)}%`}${r != null ? ` · <span class="${cls(r)}">${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R</span>` : ''}</div>
                </div>
              </div>
              ${open ? noteForm(t) : ''}
            </div>`;
          })
          .join('')}</div>`;
      }

      function render(): void {
        const active = document.activeElement;
        if (active instanceof HTMLElement && body.contains(active) && (active.matches('textarea, input'))) {
          // Don't yank the field out from under the cursor; render on blur.
          pending = true;
          return;
        }
        pending = false;
        const top = scrollEl.scrollTop;
        for (const b of body.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
          const on = b.dataset.tab === ui.tab;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', String(on));
        }
        modeEl.hidden = getMode() !== 'replay';
        const rows = filtered();
        countEl.textContent = String(rows.length);
        renderFilters();
        scrollEl.innerHTML = ui.tab === 'overview' ? renderOverview(rows) : renderTrades(rows);
        scrollEl.scrollTop = top;
      }

      function refresh(force = false): void {
        if (recompute() || force) render();
      }

      // ───── chart framing ─────
      async function frame(t: JournalTrade): Promise<void> {
        const ws = getWs();
        if (!ws) return;
        if (!paper.sameSymbol(ws.chart.market.symbol, t.symbol)) {
          await new Promise<void>((resolve) => {
            let done = false;
            let off: (() => void) | null = null;
            const finish = (): void => {
              if (done) return;
              done = true;
              off?.();
              resolve();
            };
            try {
              off = ws.chart.on('market:changed', () => finish());
            } catch {
              /* no events */
            }
            setTimeout(finish, 1500);
            try {
              ws.context().setSymbol(t.symbol);
            } catch {
              finish();
            }
          });
          // Viewport memory restores its saved range on load: frame after it.
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        }
        const chart = ws.chart;
        const bar = tfMs(chart.market.timeframe);
        const end = t.closeTime ?? Date.now();
        const pad = Math.max((end - t.openTime) * 0.6, bar * 25);
        const want = { from: t.openTime - pad, to: end + pad };
        const apply = (): boolean => {
          try {
            chart.setVisibleRange(want);
            return true;
          } catch {
            return false;
          }
        };
        if (!apply()) {
          toast('Could not frame the trade on this chart', 'error');
          return;
        }
        // A load still in flight (or viewport memory restoring after it) can override the
        // range: check, and re-apply once after the load lands.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const got = chart.getVisibleRange();
        const off = (a: number, b: number): boolean => Math.abs(a - b) > bar * 3;
        if (!got || got.to - got.from < bar * 2 || off(got.from, want.from) || off(got.to, want.to)) {
          await new Promise<void>((resolve) => {
            let off2: (() => void) | null = null;
            const timer = setTimeout(() => {
              off2?.();
              resolve();
            }, 1200);
            try {
              off2 = chart.on('load:end', () => {
                clearTimeout(timer);
                off2?.();
                requestAnimationFrame(() => resolve());
              });
            } catch {
              /* no events */
            }
          });
          apply();
        }
      }

      // ───── screenshot ─────
      async function attachShot(key: string): Promise<void> {
        const ws = getWs();
        const t = trades.find((x) => x.key === key);
        if (!ws || !t) return;
        if (busyShot) return;
        busyShot = key;
        render();
        try {
          const shot = ws.screenshot();
          if (!shot) {
            toast('Screenshot unavailable (chart not ready)', 'error');
            return;
          }
          const id = `journal-${key.replace(/[^A-Za-z0-9_-]+/g, '_')}-${Date.now().toString(36)}`;
          const n = ensureNote(key);
          try {
            const url = await uploadShot(id, shot);
            n.shot = { id, url, at: Date.now() };
            toast('Screenshot attached', 'success');
          } catch {
            const small = await shrinkDataUrl(shot, INLINE_SHOT_CAP).catch(() => null);
            if (!small) {
              toast('Screenshot upload failed and the image is too large to keep locally', 'error');
              return;
            }
            n.shot = { id, dataUrl: small, at: Date.now() };
            toast('Blob store unavailable: screenshot kept in this browser only', 'error');
          }
          n.updatedAt = Date.now();
          persist(true);
        } finally {
          busyShot = null;
          render();
        }
      }

      function openShot(s: Shot): void {
        if (s.dataUrl) {
          // Chrome blocks top-level data: navigation, so open it as a blob URL.
          void dataUrlToBlob(s.dataUrl).then((b) => {
            const u = URL.createObjectURL(b);
            window.open(u, '_blank', 'noopener');
            setTimeout(() => URL.revokeObjectURL(u), 60_000);
          });
        } else {
          window.open(shotSrc(s), '_blank', 'noopener');
        }
      }

      function exportCsv(): void {
        const rows = filtered().sort((a, b) => a.openTime - b.openTime);
        if (!rows.length) {
          toast('No trades to export', 'info');
          return;
        }
        const blob = new Blob([`﻿${tradesCsv(rows, doc.notes)}`], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `chart-desk-journal-${getMode() === 'replay' ? 'practice-' : ''}${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        toast(`Exported ${rows.length} trade${rows.length === 1 ? '' : 's'}`, 'success');
      }

      // ───── events ─────
      const keyOf = (el: Element): string | undefined => el.closest<HTMLElement>('[data-key]')?.dataset.key;

      body.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement;
        const tab = t.closest<HTMLElement>('[data-tab]')?.dataset.tab;
        if (tab === 'overview' || tab === 'trades') {
          ui.tab = tab;
          saveUi(ui);
          render();
          return;
        }
        const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'csv') return exportCsv();
        const range = t.closest<HTMLElement>('[data-range]')?.dataset.range as Range | undefined;
        if (range) {
          ui.range = range;
          saveUi(ui);
          return render();
        }
        const bd = t.closest<HTMLElement>('[data-bd]')?.dataset.bd as Breakdown | undefined;
        if (bd) {
          ui.breakdown = bd;
          saveUi(ui);
          return render();
        }

        const key = keyOf(t);
        if (!key) return;
        const trade = trades.find((x) => x.key === key);
        if (!trade) return;

        if (act === 'toggle') {
          expanded = expanded === key ? null : key;
          editTags = false;
          return render();
        }
        if (t.closest('[data-row]')) {
          const wasOpen = expanded === key;
          expanded = wasOpen ? null : key;
          editTags = false;
          render();
          if (!wasOpen) void frame(trade);
          return;
        }
        if (act === 'frame') return void frame(trade);
        if (act === 'shot') return void attachShot(key);
        if (act === 'openshot') {
          const s = noteFor(key)?.shot;
          if (s) openShot(s);
          return;
        }
        if (act === 'delshot') {
          const n = noteFor(key);
          if (n) {
            delete n.shot;
            n.updatedAt = Date.now();
            persist(true);
          }
          return render();
        }
        if (act === 'edittags') {
          editTags = !editTags;
          render();
          if (editTags) body.querySelector<HTMLInputElement>('[data-newtag]')?.focus();
          return;
        }
        const del = t.closest<HTMLElement>('[data-deltag]')?.dataset.deltag;
        if (del) {
          doc.tags = doc.tags.filter((x) => x !== del);
          if (ui.tag === del) ui.tag = '';
          persist(true);
          return render();
        }
        const tag = t.closest<HTMLElement>('[data-tag]')?.dataset.tag;
        if (tag) {
          const n = ensureNote(key);
          n.tags = n.tags.includes(tag) ? n.tags.filter((x) => x !== tag) : [...n.tags, tag];
          n.updatedAt = Date.now();
          persist(true);
          return render();
        }
        const grade = t.closest<HTMLElement>('[data-grade]')?.dataset.grade as Grade | undefined;
        if (grade) {
          const n = ensureNote(key);
          n.grade = n.grade === grade ? undefined : grade;
          n.updatedAt = Date.now();
          persist(true);
          return render();
        }
        const emo = t.closest<HTMLElement>('[data-emotion]')?.dataset.emotion;
        if (emo) {
          const n = ensureNote(key);
          n.emotion = n.emotion === emo ? undefined : emo;
          n.updatedAt = Date.now();
          persist(true);
          return render();
        }
      });

      body.addEventListener('keydown', (ev) => {
        const t = ev.target as HTMLElement;
        if (t.matches('[data-row]') && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          t.click();
          return;
        }
        if (t.matches('[data-newtag]') && ev.key === 'Enter') {
          ev.preventDefault();
          const v = (t as HTMLInputElement).value.trim().slice(0, 24);
          if (v && !doc.tags.some((x) => x.toLowerCase() === v.toLowerCase())) {
            doc.tags.push(v);
            persist(true);
          }
          (t as HTMLInputElement).value = '';
          (t as HTMLInputElement).blur();
          render();
          body.querySelector<HTMLInputElement>('[data-newtag]')?.focus();
        }
      });

      body.addEventListener('input', (ev) => {
        const t = ev.target as HTMLElement;
        const key = keyOf(t);
        if (!key) return;
        if (t.matches('[data-note]')) {
          const n = ensureNote(key);
          n.note = (t as HTMLTextAreaElement).value;
          n.updatedAt = Date.now();
          persist();
        } else if (t.matches('[data-risk]')) {
          const n = ensureNote(key);
          const v = Number((t as HTMLInputElement).value);
          n.risk = (t as HTMLInputElement).value.trim() !== '' && Number.isFinite(v) && v > 0 ? v : undefined;
          n.updatedAt = Date.now();
          persist();
          const trade = trades.find((x) => x.key === key);
          const out = body.querySelector<HTMLElement>(`[data-form="${CSS.escape(key)}"] [data-rout]`);
          if (trade && out) {
            const r = rMultiple(trade, n);
            out.textContent = r != null ? `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R` : '';
            out.className = r != null ? cls(r) : '';
          }
        }
      });

      body.addEventListener('change', (ev) => {
        const t = ev.target as HTMLElement;
        const f = (t as HTMLSelectElement).dataset?.f;
        if (f === 'symbol' || f === 'tag') {
          ui[f] = (t as HTMLSelectElement).value;
          saveUi(ui);
          (t as HTMLSelectElement).blur();
          render();
        } else if (f === 'side') {
          const v = (t as HTMLSelectElement).value;
          ui.side = v === 'long' || v === 'short' ? v : '';
          saveUi(ui);
          (t as HTMLSelectElement).blur();
          render();
        }
      });

      body.addEventListener('focusout', () => {
        // Let focus land first, then catch up on renders deferred while typing.
        setTimeout(() => {
          if (saveTimer) persist(true);
          if (pending) render();
        }, 0);
      });

      // Ticks call onPaperChange constantly while a position is open: only rebuild when
      // the fill history (or the account mode) actually changed.
      const offPaper = paper.onPaperChange(() => {
        if (recompute() && body.offsetParent !== null) render();
      });

      recompute();
      render();

      return {
        onOpen: () => {
          // Another tab or the server sync may have rewritten the notes.
          if (!saveTimer) doc = loadDoc();
          refresh(true);
        },
        destroy: () => {
          offPaper();
          if (saveTimer) persist(true);
        },
      };
    },
  });
}
