import './style.css';
import { VelaWorkspace } from '@luxalgo/vela/workspace';
import { PineWorkerEngine } from '@luxalgo/vela-pinets';
import { DEFAULT_INDICATORS } from './indicators';
import { tradingViewTheme } from './theme/tradingview';
import { registerWatchlistPanel } from './panels/watchlist';
import { registerNewsPanel } from './panels/news';
import { registerPineEditor } from './panels/pine-editor';
import { registerReplayAction } from './panels/replay';
import {
  bindDeskDrawOnMarketChange,
  displaySymbol,
  loadAndDrawDesk,
} from './desk/approvals';
import {
  clearLegacySessionDrawings,
  registerSessionsIndicator,
  SESSIONS_INDICATOR_TYPE,
} from './desk/sessions';
import { CoinbaseProvider } from '@luxalgo/vela/providers/coinbase';
import {
  CachedHyperliquidProvider,
  prefetchHyperliquid,
} from './providers/cached-hyperliquid';
import { LBankProvider } from './providers/lbank';
import {
  POSITIONS_INDICATOR_TYPE,
  registerPositionsIndicator,
} from './trading/positions-indicator';
import { registerPaperTrading, startPaperPriceFeed } from './trading/trading-panel';
import * as paper from './trading/paper-store';
import { onHlQuotes, startHlQuotes } from './lib/hl-quotes';
import { installSymbolSearch } from './lib/symbol-search';
import {
  getWatchlist,
  onWatchlistChange,
} from './lib/watchlist-store';
import {
  bindViewportMemory,
  hasSavedViewports,
  registerViewportPersistence,
} from './lib/viewport-memory';

function syncWatchlistQuotes(): void {
  startHlQuotes(
    getWatchlist()
      .filter((w) => w.hlCoin)
      .map((w) => ({
        symbol: w.symbol,
        midKey: w.hlCoin!,
        dex: w.hlDex,
      })),
  );
}

// Live HL mids before first paint (watchlist + title stay in sync)
syncWatchlistQuotes();
onWatchlistChange(() => syncWatchlistQuotes());

// Plugins must register before the workspace mounts
registerWatchlistPanel();
registerNewsPanel();
registerPineEditor();
registerReplayAction();
registerViewportPersistence();
registerSessionsIndicator();
registerPositionsIndicator();
let wsRef: VelaWorkspace | null = null;
registerPaperTrading(() => wsRef);

// TradingView-style search: source chips + same-coin grouping across venues
installSymbolSearch();

const hlProvider = new CachedHyperliquidProvider();
const lbankProvider = new LBankProvider();
const coinbaseProvider = new CoinbaseProvider();
const PERSIST_KEY = 'chart-desk-tv-v2';
const NATIVES_SEEDED_KEY = `${PERSIST_KEY}-natives`;
const SESSIONS_SEEDED_KEY = `${PERSIST_KEY}-sessions`;

const ws = new VelaWorkspace('#chart', {
  layout: '1',
  symbol: 'hyperliquid:xyz:GOLD',
  timeframe: '60',
  bars: 1200,
  visibleRange: hasSavedViewports() ? undefined : '1M',
  live: true,
  volume: true,
  theme: tradingViewTheme,
  upColor: '#089981',
  downColor: '#f23645',
  currentPriceLine: true,
  freePan: 'alt',
  nativeBackend: 'auto',
  maxWebglCells: 8,
  persist: PERSIST_KEY,
  autofocus: true,
  defaultLanguage: 'pine',
  // Auto: desktop chrome on wide, mobile chrome on narrow (fixes blank 390px chart)
  layoutMode: 'auto',
  statusline: true,
  watermark: true,
  bottombar: true,
  drawingToolbar: true,
  drawings: true,
  timezone: 'Etc/UTC',
  // Single-cell desk — no crosshair sync (avoids console noise)
  sync: {
    timeframe: true,
    viewport: true,
  },
  timeframes: ['1', '5', '15', '30', '60', '120', '240', '1D', '1W', '1M'],
  topbar: {
    left: ['symbol', 'timeframes', 'style', 'indicators', 'layout', 'undo-redo'],
    right: ['desk.replay', 'actions', 'alerts', 'panels', 'screenshot', 'fullscreen'],
  },
  sidebar: {
    top: ['panels'],
    bottom: ['desk.watchlist', 'desk.news', 'desk.pine', 'objects', 'dataWindow', '|', 'actions'],
  },
  engines: {
    pine: () => new PineWorkerEngine(),
  },
  indicators: DEFAULT_INDICATORS,
  providers: {
    hyperliquid: () => hlProvider,
    lbank: () => lbankProvider,
    coinbase: () => coinbaseProvider,
  },
  animations: {
    zoom: false,
    pan: false,
    liveBar: true,
    intro: false,
  },
});

wsRef = ws;

const titleFor = (symbol: string | undefined, close: number) => {
  const short = displaySymbol(symbol);
  return `${short} ${close.toLocaleString('en-US', { maximumFractionDigits: 2 })} · Chart Desk`;
};

ws.chart.on('bar', (bar) => {
  document.title = titleFor(ws.chart.market.symbol, bar.close);
});

// Prefer live mid for the tab title when candle tip is a few seconds behind
onHlQuotes((map) => {
  const sym = ws.chart.market.symbol;
  if (!sym) return;
  const q = map.get(sym);
  if (q) document.title = titleFor(sym, q.price);
});

await ws.chart.ready();

// Persisted sync may still enable crosshair — force off for single-cell desk
try {
  ws.sync.set('crosshair', false);
} catch {
  /* optional */
}

applyTradingViewDefaults(ws);
seedNativeDefaultsOnce(ws);
seedSessionsOnce(ws);
clearLegacySessionDrawings(ws.chart);
trimHlRangeChips(ws.root);
bindViewportMemory(ws.chart);
ensurePositionsOverlay(ws);
ws.chart.on('market:changed', () => ensurePositionsOverlay(ws));
startPaperPriceFeed(ws);

// Warm cache gently after first paint (avoid HL 429 on boot)
window.setTimeout(() => {
  prefetchHyperliquid(
    hlProvider,
    getWatchlist()
      .filter((w) => w.symbol.toLowerCase().startsWith('hyperliquid:'))
      .map((w) => w.symbol),
    ['60', '15'],
  );
}, 4_000);

const deskApi = {
  ws,
  draw: (coin = 'GOLD') => loadAndDrawDesk(ws, coin),
  paper,
};
(window as unknown as { __chartDesk: typeof deskApi }).__chartDesk = deskApi;

bindDeskDrawOnMarketChange(ws);

/** Magnet + countdown + legend. */
function applyTradingViewDefaults(workspace: VelaWorkspace): void {
  try {
    workspace.chart.drawings.setSnapMode('weak');
  } catch {
    /* optional */
  }
  try {
    workspace.chart.renderer.set('countdown', true);
    workspace.chart.renderer.set('indicatorTitles', true);
    workspace.chart.renderer.set('indicatorValues', true);
    workspace.chart.renderer.set('currentPriceLine', true);
  } catch {
    /* optional */
  }
}

/**
 * Hyperliquid only keeps ~5k candles — hide range chips that imply multi-year depth.
 * Keep 1D…6M + ALL (ALL = max available from the venue).
 */
function trimHlRangeChips(root: HTMLElement): void {
  const hide = new Set(['YTD', '1Y', '5Y']);
  for (const btn of root.querySelectorAll<HTMLButtonElement>('.vela-bb-range')) {
    const id = btn.textContent?.trim() ?? '';
    if (hide.has(id)) {
      btn.hidden = true;
      btn.disabled = true;
      continue;
    }
    if (id === 'ALL') {
      btn.title = 'Max history Hyperliquid serves (~5k candles)';
    }
  }
}

/** Seed EMA/RSI once — never re-add after the user removes them. */
function seedNativeDefaultsOnce(workspace: VelaWorkspace): void {
  try {
    if (localStorage.getItem(NATIVES_SEEDED_KEY)) return;
  } catch {
    /* ignore */
  }

  const present = new Set(workspace.chart.presentNativeIndicators());
  if (!present.has('moving-average')) {
    workspace.chart.addNativeIndicator('moving-average', {
      inputs: {
        maType: 'EMA',
        length: 20,
        showMa2: true,
        ma2Type: 'EMA',
        ma2Length: 50,
        color: '#ff9800',
        ma2Color: '#2196f3',
      },
    });
  }
  if (!present.has('rsi')) {
    workspace.chart.addNativeIndicator('rsi', {
      inputs: {
        length: 14,
        color: '#7e57c2',
      },
    });
  }

  try {
    localStorage.setItem(NATIVES_SEEDED_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** One-time seed for Sessions (was always-on overlay) — removable via legend ✕. */
function seedSessionsOnce(workspace: VelaWorkspace): void {
  try {
    if (localStorage.getItem(SESSIONS_SEEDED_KEY)) return;
  } catch {
    /* ignore */
  }
  const present = new Set(workspace.chart.presentNativeIndicators());
  if (!present.has(SESSIONS_INDICATOR_TYPE)) {
    workspace.chart.addNativeIndicator(SESSIONS_INDICATOR_TYPE);
  }
  try {
    localStorage.setItem(SESSIONS_SEEDED_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** Paper positions / orders overlay is always on (legend-less, owned by the trading panel). */
function ensurePositionsOverlay(workspace: VelaWorkspace): void {
  try {
    if (!workspace.chart.presentNativeIndicators().includes(POSITIONS_INDICATOR_TYPE)) {
      workspace.chart.addNativeIndicator(POSITIONS_INDICATOR_TYPE);
    }
  } catch (err) {
    console.warn('[positions]', err);
  }
}
