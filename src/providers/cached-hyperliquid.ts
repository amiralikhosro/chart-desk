import type {
  BarRange,
  DataProvider,
  OHLCV,
  ProviderInfo,
  SymbolDescriptor,
  SymbolInfo,
} from '@luxalgo/vela';
import { HyperliquidProvider } from '@luxalgo/vela/providers/hyperliquid';
import { loadHistory, saveHistory } from '../lib/history-cache';

type Unsubscribe = () => void;

/** Tip older than this forces a network refresh (keeps live price honest). */
const TIP_FRESH_MS = 12_000;
const mem = new Map<string, { bars: OHLCV[]; at: number }>();
const inflight = new Map<string, Promise<OHLCV[]>>();

function cacheKey(ticker: string, timeframe: string): string {
  return `hl:${ticker}:${timeframe}`;
}

function sliceRange(bars: OHLCV[], range: BarRange): OHLCV[] {
  const to = range.to ?? Number.POSITIVE_INFINITY;
  const from = range.from ?? Number.NEGATIVE_INFINITY;
  let out = bars.filter((b) => b.time >= from && b.time <= to);
  if (range.limit != null && out.length > range.limit) out = out.slice(-range.limit);
  return out;
}

function covers(bars: OHLCV[], range: BarRange, tfHintMs: number): boolean {
  if (bars.length === 0) return false;
  const tip = bars[bars.length - 1]!.time;
  const oldest = bars[0]!.time;
  const to = range.to ?? Date.now();
  if (tip < to - Math.max(tfHintMs * 3, TIP_FRESH_MS)) return false;
  if (range.from != null) return oldest <= range.from + tfHintMs * 2;
  if (range.limit != null) return bars.length >= range.limit;
  return true;
}

function tfMs(tf: string): number {
  const n = Number.parseInt(tf, 10);
  if (Number.isFinite(n) && n > 0) return n * 60_000;
  const u = tf.toUpperCase();
  if (u === 'D' || u === '1D') return 86_400_000;
  if (u === 'W' || u === '1W') return 604_800_000;
  if (u === 'M' || u === '1M') return 2_592_000_000;
  return 3_600_000;
}

/**
 * Hyperliquid provider with memory + IndexedDB cache so symbol/TF switches
 * reuse recent candles instead of waiting on candleSnapshot every time.
 */
export class CachedHyperliquidProvider implements DataProvider {
  private readonly inner = new HyperliquidProvider();

  info(): ProviderInfo {
    return this.inner.info();
  }

  listSymbols(): Promise<SymbolDescriptor[]> {
    return this.inner.listSymbols();
  }

  getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
    return this.inner.getSymbolInfo(ticker);
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): Unsubscribe {
    return this.inner.subscribe(ticker, timeframe, (bar) => {
      const key = cacheKey(ticker, timeframe);
      const hit = mem.get(key);
      if (hit) {
        const bars = hit.bars;
        const last = bars[bars.length - 1];
        if (last && last.time === bar.time) {
          bars[bars.length - 1] = bar;
        } else if (!last || bar.time > last.time) {
          bars.push(bar);
          if (bars.length > 12_000) bars.splice(0, bars.length - 12_000);
        }
        hit.at = Date.now();
      }
      onBar(bar);
    });
  }

  async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
    const key = cacheKey(ticker, timeframe);
    const ms = tfMs(timeframe);

    // In-flight dedupe (TF spam / parallel prefetch)
    const pending = inflight.get(key);
    if (pending) {
      const bars = await pending;
      return sliceRange(bars, range);
    }

    const memHit = mem.get(key);
    if (memHit && covers(memHit.bars, range, ms)) {
      // Tip still in window — paint now, but soft-refresh if aging so close stays live
      const tip = memHit.bars[memHit.bars.length - 1]?.time ?? 0;
      if (Date.now() - tip > Math.min(ms, TIP_FRESH_MS)) {
        void this.refresh(key, ticker, timeframe, range);
      }
      return sliceRange(memHit.bars, range);
    }

    // Instant paint from IndexedDB only when tip is still fresh; otherwise await network
    if (!memHit) {
      const disk = await loadHistory(key);
      if (disk?.length) {
        mem.set(key, { bars: disk, at: Date.now() });
        if (covers(disk, range, ms)) {
          void this.refresh(key, ticker, timeframe, range);
          return sliceRange(disk, range);
        }
        // Stale tip → wait for fresh candles so price doesn't lag the tape
        return this.refresh(key, ticker, timeframe, range);
      }
    }

    return this.refresh(key, ticker, timeframe, range);
  }

  private async refresh(
    key: string,
    ticker: string,
    timeframe: string,
    range: BarRange,
  ): Promise<OHLCV[]> {
    const existing = inflight.get(key);
    if (existing) {
      const bars = await existing;
      return sliceRange(bars, range);
    }

    const task = (async () => {
      // Ask for a generous recent window once; later calls slice from cache
      const limit = Math.min(Math.max(range.limit ?? 800, 400), 5_000);
      const fetchRange: BarRange = {
        limit,
        to: range.to,
        from: range.from,
      };
      const fresh = await this.inner.getBars(ticker, timeframe, fetchRange);
      const prior = mem.get(key)?.bars ?? [];
      const merged = mergeBars(prior, fresh);
      mem.set(key, { bars: merged, at: Date.now() });
      void saveHistory(key, merged);
      return merged;
    })();

    inflight.set(key, task);
    try {
      const bars = await task;
      return sliceRange(bars, range);
    } finally {
      inflight.delete(key);
    }
  }
}

function mergeBars(a: OHLCV[], b: OHLCV[]): OHLCV[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const map = new Map<number, OHLCV>();
  for (const bar of a) map.set(bar.time, bar);
  for (const bar of b) map.set(bar.time, bar);
  return [...map.values()].sort((x, y) => x.time - y.time).slice(-12_000);
}

/** Warm the cache for watchlist symbols on the common TFs. */
export function prefetchHyperliquid(
  provider: DataProvider,
  symbols: string[],
  timeframes: string[] = ['60', '15', '240'],
): void {
  for (const symbol of symbols) {
    for (const tf of timeframes) {
      void provider.getBars(symbol.replace(/^hyperliquid:/i, ''), tf, { limit: 800 }).catch(() => {
        /* ignore warm failures */
      });
    }
  }
}
