/**
 * TradingView-style symbol search:
 *  - a "sources" chip row under the category tabs (All sources / Hyperliquid / LBank /
 *    Coinbase), remembered between opens, driving Vela's venue filter (`lbank btc`)
 *  - ranking that groups the same coin across venues: watchlist first, then majors,
 *    USD/USDT quotes before other quotes, perps before spot, lookalikes (BTCDEFI, WBTC) last
 */
import type { SymbolDescriptor } from '@luxalgo/vela';
import { registerSymbolRanking } from '@luxalgo/vela/plugin';
import { getWatchlist } from './watchlist-store';

export const SOURCES: Array<{ id: string; label: string }> = [
  { id: '', label: 'All sources' },
  { id: 'hyperliquid', label: 'Hyperliquid' },
  { id: 'lbank', label: 'LBank' },
  { id: 'coinbase', label: 'Coinbase' },
];

const LS_KEY = 'chart-desk-search-source';
const MAJORS = ['BTC', 'ETH', 'SOL', 'XLM', 'GOLD', 'XAUT', 'PAXG', 'SILVER', 'XRP', 'DOGE', 'BNB', 'ADA', 'AVAX', 'LINK', 'INJ', 'SUI', 'HYPE'];
const GOOD_QUOTES = new Set(['USD', 'USDT', 'USDC', 'USDH', 'USDE']);
const PROVIDER_ORDER = ['hyperliquid', 'lbank', 'coinbase'];

let source = '';
try {
  source = localStorage.getItem(LS_KEY) ?? '';
} catch {
  /* ignore */
}

/** Base / quote / perp-ness of any descriptor, from its description when it has one. */
export function parseSymbol(s: SymbolDescriptor): { base: string; quote: string; perp: boolean } {
  const desc = s.description ?? '';
  const perp = /perp/i.test(desc) || /\.P$/i.test(s.ticker);
  const m = desc.match(/^([A-Za-z0-9.]+)\s*\/\s*([A-Za-z]+)/);
  if (m) return { base: m[1]!.toUpperCase(), quote: m[2]!.toUpperCase(), perp };
  const t = s.ticker.split(':').pop()!.toUpperCase().replace(/\.P$/, '');
  if (t.includes('-')) {
    const [b, q] = t.split('-');
    return { base: b!, quote: q ?? '', perp };
  }
  const q = t.match(/(USDT|USDC|USD)$/)?.[1] ?? '';
  return { base: q ? t.slice(0, -q.length) : t, quote: q, perp };
}

function installRanking(): void {
  registerSymbolRanking((pool) => {
    const watch = getWatchlist().map((w) => w.symbol.toLowerCase());
    const keyed = pool.map((s, i) => {
      const provider = (s.provider ?? 'hyperliquid').toLowerCase();
      const qualified = `${provider}:${s.ticker}`.toLowerCase();
      const { base, quote, perp } = parseSymbol(s);
      const w = watch.indexOf(qualified);
      const major = MAJORS.indexOf(base);
      const p = PROVIDER_ORDER.indexOf(provider);
      return {
        s,
        k: [
          w < 0 ? 1_000 : w,
          major < 0 ? MAJORS.length : major,
          GOOD_QUOTES.has(quote) ? 0 : 1,
          perp ? 0 : 1,
          p < 0 ? PROVIDER_ORDER.length : p,
          base.length,
          i,
        ],
      };
    });
    keyed.sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i]! - b.k[i]!;
      return 0;
    });
    return keyed.map((x) => x.s);
  });
}

/** Strip a leading `provider ` venue word from a query. */
function stripSource(q: string): string {
  const lower = q.toLowerCase();
  for (const s of SOURCES) if (s.id && lower.startsWith(`${s.id} `)) return q.slice(s.id.length + 1);
  return q;
}

function applySource(input: HTMLInputElement): void {
  const q = stripSource(input.value).trimStart();
  const next = source ? `${source} ${q}` : q;
  if (input.value === next) return;
  input.value = next;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function decorate(dialog: HTMLElement): void {
  const input = dialog.querySelector<HTMLInputElement>('.vela-sp-input');
  const tabs = dialog.querySelector<HTMLElement>('.vela-sp-tabs');
  if (!input || !tabs || dialog.querySelector('.desk-sp-sources')) return;

  const row = document.createElement('div');
  row.className = 'desk-sp-sources';
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', 'Source');
  row.innerHTML = SOURCES.map(
    (s) => `<button type="button" role="radio" data-src="${s.id}">${s.label}</button>`,
  ).join('');
  tabs.insertAdjacentElement('afterend', row);

  const paint = (): void => {
    for (const b of row.querySelectorAll<HTMLButtonElement>('[data-src]')) {
      const on = b.dataset.src === source;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    }
  };

  row.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  row.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-src]');
    if (!b) return;
    source = b.dataset.src ?? '';
    try {
      localStorage.setItem(LS_KEY, source);
    } catch {
      /* ignore */
    }
    paint();
    applySource(input);
    input.focus();
  });

  // Typing a venue word by hand moves the chip with it.
  input.addEventListener('input', () => {
    const lower = input.value.toLowerCase();
    const typed = SOURCES.find((s) => s.id && lower.startsWith(`${s.id} `))?.id ?? '';
    if (typed !== source) {
      source = typed;
      paint();
    }
  });

  paint();
  // The dialog may open seeded with the key that opened it: apply after that lands.
  requestAnimationFrame(() => applySource(input));
}

export function installSymbolSearch(): void {
  installRanking();
  const onOpen = (e: Event): void => {
    const el = e.target as HTMLElement | null;
    if (!el?.classList?.contains('vela-dialog')) return;
    if (el.querySelector('.vela-sp-input')) decorate(el);
  };
  document.addEventListener('vela:surface-open', onOpen, true);
}
