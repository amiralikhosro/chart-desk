import type { VelaWorkspace } from '@luxalgo/vela/workspace';

export type DeskPlan = {
  entry: number;
  stop: number;
  target: number;
  replay: number;
};

export type DeskMarket = {
  coin: string;
  chartSymbol: string;
  verdict: string;
  close: number;
  high_24h: number;
  low_24h: number;
  plans: { long: DeskPlan; short: DeskPlan };
};

export type DeskLatest = {
  at: string;
  note?: string;
  markets: DeskMarket[];
};

export type DeskStatus = {
  badge: string;
  kind: 'wait' | 'long' | 'short';
  hint: string;
};

const STALE_MS = 30 * 60_000;

let cached: DeskLatest | null = null;

export async function loadDeskLatest(force = false): Promise<DeskLatest | null> {
  if (cached && !force) return cached;
  const res = await fetch(`/desk-latest.json?t=${Date.now()}`);
  if (!res.ok) return null;
  cached = (await res.json()) as DeskLatest;
  return cached;
}

export function getCachedDesk(): DeskLatest | null {
  return cached;
}

/** `hyperliquid:xyz:GOLD` → `GOLD`, `hyperliquid:BTC` → `BTC`. */
export function displaySymbol(symbol: string | undefined): string {
  if (!symbol) return 'CHART';
  const parts = symbol.split(':');
  return parts[parts.length - 1] || symbol;
}

export function deskAgeMs(at: string): number {
  const t = Date.parse(at);
  return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
}

export function deskAgeLabel(at: string): string {
  const ms = deskAgeMs(at);
  if (!Number.isFinite(ms)) return 'unknown age';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function isDeskStale(at: string): boolean {
  return deskAgeMs(at) > STALE_MS;
}

export function marketForSymbol(data: DeskLatest, symbol: string | undefined): DeskMarket | null {
  if (!symbol) return null;
  const s = symbol.toLowerCase();
  return (
    data.markets.find((m) => m.chartSymbol.toLowerCase() === s) ??
    data.markets.find((m) => {
      const coin = m.coin.toLowerCase();
      return s === coin || s.endsWith(`:${coin}`);
    }) ??
    null
  );
}

/** Watchlist / strip status for a desk market. */
export function deskStatusFor(m: DeskMarket, lastPx?: number): DeskStatus {
  const px = Number.isFinite(lastPx) ? (lastPx as number) : m.close;

  if (m.verdict.startsWith('APPROVED')) {
    const side = m.verdict.includes('SHORT') ? 'short' : 'long';
    const plan = m.plans[side];
    const dist = ((plan.entry - px) / px) * 100;
    const sign = dist >= 0 ? '+' : '';
    return {
      badge: side === 'short' ? 'SHORT' : 'LONG',
      kind: side,
      hint: `entry ${fmtPx(plan.entry)} (${sign}${dist.toFixed(2)}%)`,
    };
  }

  const toLong = ((m.high_24h - px) / px) * 100;
  const toShort = ((px - m.low_24h) / px) * 100;
  return {
    badge: 'WAIT',
    kind: 'wait',
    hint: `↑${Math.max(0, toLong).toFixed(2)}% · ↓${Math.max(0, toShort).toFixed(2)}%`,
  };
}

/** Remove prior desk lines (tagged in text). */
export function clearDeskDrawings(ws: VelaWorkspace): void {
  const chart = ws.chart;
  const ids = chart.drawings
    .all()
    .filter((d) => {
      const text = d.text?.value ?? '';
      return text.includes('DESK') || d.id.startsWith('desk-');
    })
    .map((d) => d.id);
  if (ids.length) chart.drawings.removeMany(ids);
}

function fmtPx(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(5);
}

function addHLine(
  ws: VelaWorkspace,
  price: number,
  opts: { color: string; style: 'solid' | 'dashed' | 'dotted'; text: string },
): void {
  const chart = ws.chart;
  const t = Date.now();
  const d = chart.drawings.add('hline', {
    anchors: [{ time: t, price }],
    style: {
      lineColor: opts.color,
      lineWidth: 2,
      lineStyle: opts.style,
    },
    text: { value: opts.text, size: 'small', hAlign: 'left', vAlign: 'center' },
  });
  if (d) {
    try {
      chart.drawings.lock(d.id);
    } catch {
      /* optional */
    }
  }
}

/**
 * Draw long + short approval levels for a desk market on the active chart.
 * WAIT → dashed trigger lines at 24h high/low.
 * APPROVED → solid entry / stop / target for the approved side.
 */
export function drawDeskMarket(ws: VelaWorkspace, m: DeskMarket, stale = false): void {
  clearDeskDrawings(ws);
  const staleTag = stale ? ' · STALE' : '';

  if (m.verdict.startsWith('APPROVED')) {
    const side = m.verdict.includes('SHORT') ? 'short' : 'long';
    const plan = m.plans[side];
    addHLine(ws, plan.entry, {
      color: '#2962FF',
      style: 'solid',
      text: `DESK ${side} entry ${fmtPx(plan.entry)} (paper)${staleTag}`,
    });
    addHLine(ws, plan.stop, {
      color: '#f23645',
      style: 'solid',
      text: `DESK ${side} stop ${fmtPx(plan.stop)}${staleTag}`,
    });
    addHLine(ws, plan.target, {
      color: '#089981',
      style: 'solid',
      text: `DESK ${side} target ${fmtPx(plan.target)} (2R)${staleTag}`,
    });
    return;
  }

  addHLine(ws, m.high_24h, {
    color: '#089981',
    style: 'dashed',
    text: `DESK LONG above ${fmtPx(m.high_24h)} · replay ${m.plans.long.replay.toFixed(2)}R${staleTag}`,
  });
  addHLine(ws, m.low_24h, {
    color: '#f23645',
    style: 'dashed',
    text: `DESK SHORT below ${fmtPx(m.low_24h)} · replay ${m.plans.short.replay >= 0 ? '+' : ''}${m.plans.short.replay.toFixed(2)}R${staleTag}`,
  });
}

/** Draw desk levels for whatever symbol is on the chart (watchlist coins). */
export async function drawDeskForActiveChart(ws: VelaWorkspace): Promise<DeskMarket | null> {
  const data = await loadDeskLatest();
  if (!data) return null;
  const m = marketForSymbol(data, ws.chart.market.symbol);
  if (!m) {
    clearDeskDrawings(ws);
    return null;
  }
  drawDeskMarket(ws, m, isDeskStale(data.at));
  return m;
}

export async function loadAndDrawDesk(
  ws: VelaWorkspace,
  coin = 'GOLD',
): Promise<DeskMarket | null> {
  const data = await loadDeskLatest(true);
  if (!data) return null;
  const m =
    data.markets.find((x) => x.coin.toUpperCase() === coin.toUpperCase()) ?? data.markets[0];
  if (!m) return null;

  if (ws.chart.market.symbol !== m.chartSymbol) {
    await ws.chart.setMarket({ symbol: m.chartSymbol });
    await ws.chart.ready();
  }
  drawDeskMarket(ws, m, isDeskStale(data.at));
  return m;
}

/** Keep long/short lines in sync when the user flips watchlist symbols (not on TF-only changes). */
export function bindDeskDrawOnMarketChange(ws: VelaWorkspace): () => void {
  let busy = false;
  let lastSymbol = ws.chart.market.symbol;
  const run = async (force = false) => {
    if (busy) return;
    busy = true;
    try {
      if (force) await loadDeskLatest(true);
      await drawDeskForActiveChart(ws);
    } catch (err) {
      console.warn('[desk] draw failed', err);
    } finally {
      busy = false;
    }
  };
  void run();
  const unsub = ws.chart.on('market:changed', () => {
    const symbol = ws.chart.market.symbol;
    if (symbol === lastSymbol) return;
    lastSymbol = symbol;
    void run();
  });
  // Refresh levels periodically so stale paper plans don't sit silently
  const timer = setInterval(() => void run(true), 60_000);
  return () => {
    unsub();
    clearInterval(timer);
  };
}
