import type { Vela } from '@luxalgo/vela';
import { registerStatePersistence } from '@luxalgo/vela/plugin';

type Range = { from: number; to: number };
type Store = Record<string, Range>;

const LS_KEY = 'chart-desk-viewport-v1';
const EXT_KEY = 'desk.viewport';

function marketKey(symbol: string, timeframe: string): string {
  return `${symbol}|${timeframe}`;
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* private mode / quota */
  }
}

export function hasSavedViewports(): boolean {
  return Object.keys(readStore()).length > 0;
}

/** Register before the workspace mounts — folds viewports into Vela's persist document. */
export function registerViewportPersistence(): void {
  registerStatePersistence({
    key: EXT_KEY,
    scope: 'cell',
    serialize: (ctx) => {
      const range = ctx.chart.getVisibleRange();
      const { symbol, timeframe } = ctx.chart.market;
      if (!range || !symbol || !timeframe) return { all: readStore() };
      const all = { ...readStore(), [marketKey(symbol, timeframe)]: { from: range.from, to: range.to } };
      writeStore(all);
      return { all };
    },
    restore: (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const all = (payload as { all?: Store }).all;
      if (!all || typeof all !== 'object') return;
      writeStore({ ...readStore(), ...all });
    },
  });
}

/**
 * Remember zoom/pan per symbol+timeframe and restore it after every load
 * (refresh, TF change, symbol flip) so the chart does not jump away.
 */
export function bindViewportMemory(chart: Vela): () => void {
  let suppress = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const save = () => {
    if (suppress) return;
    const range = chart.getVisibleRange();
    const { symbol, timeframe } = chart.market;
    if (!range || !symbol || !timeframe) return;
    if (!(range.to > range.from)) return;
    const store = readStore();
    store[marketKey(symbol, timeframe)] = { from: range.from, to: range.to };
    writeStore(store);
  };

  const restore = () => {
    const { symbol, timeframe } = chart.market;
    if (!symbol || !timeframe) return;
    const saved = readStore()[marketKey(symbol, timeframe)];
    if (!saved || !(saved.to > saved.from)) return;
    suppress = true;
    try {
      chart.setVisibleRange({ from: saved.from, to: saved.to });
    } catch {
      /* chart not ready */
    } finally {
      requestAnimationFrame(() => {
        suppress = false;
      });
    }
  };

  const unsubVp = chart.on('viewport:changed', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 150);
  });
  const unsubLoad = chart.on('load:end', () => {
    // After bars land (TF / symbol / refresh), put the user back where they were
    restore();
  });

  // First paint may have already finished before we subscribed
  restore();

  return () => {
    unsubVp();
    unsubLoad();
    if (timer) clearTimeout(timer);
  };
}
