/**
 * TradingView-style "Crypto Screener / Hotlists" side panel: every LBank USDT perpetual
 * and every Hyperliquid perp (plus the commodities on Hyperliquid's HIP-3 `xyz` dex) in
 * one sortable table. Presets: All, Top gainers, Top losers, Most active (24h quote volume).
 *
 * Data: one request per source per refresh (Hyperliquid rate-limits), every 10 s while
 * the panel is visible.
 *   LBank        GET  /lbank-perp/cfd/openApi/v1/pub/marketData?productGroup=SwapU (app proxy)
 *   Hyperliquid  POST https://api.hyperliquid.xyz/info {type:'metaAndAssetCtxs'[, dex:'xyz']}
 *
 * Funding: Hyperliquid ctx `funding` (per 1 h), LBank `fundingRate` (per `positionFeeTime`
 * seconds, 8 h). Shown per the venue's own period, sorted by the annualized rate so 1 h
 * and 8 h venues compare fairly. OI (USD): Hyperliquid `openInterest` (coins) × `markPx`;
 * LBank's public market data carries no open interest ("—").
 */
import type { Vela } from '@luxalgo/vela';
import { registerIcon, registerSidePanel } from '@luxalgo/vela/plugin';
import { addWatchItem } from '../lib/watchlist-store';
import './screener.css';

registerIcon(
  'desk-screener',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 3h11l-4.2 5v4.5l-2.6 1.2V8z"/></svg>',
);

type Venue = 'lbank' | 'hyperliquid';
type Row = {
  symbol: string;
  base: string;
  venue: Venue;
  hint: string;
  price: number;
  chg: number;
  vol: number;
  high: number | null;
  low: number | null;
  /** Current funding rate per period (fraction), null when the venue doesn't say. */
  funding: number | null;
  /** Hours per funding period (HL 1, LBank 8). */
  fundingHours: number;
  /** Open interest in USD notional. */
  oi: number | null;
};

type Preset = 'all' | 'gainers' | 'losers' | 'active';
type SourceFilter = 'all' | Venue;
type SortKey = 'base' | 'price' | 'chg' | 'vol' | 'funding' | 'oi' | 'high' | 'low';
type Prefs = { preset: Preset; source: SourceFilter; sort: SortKey | null; dir: 1 | -1; query: string };

const LS_KEY = 'chart-desk-screener-v1';
const DEFAULT_PREFS: Prefs = { preset: 'all', source: 'all', sort: null, dir: -1, query: '' };
const REFRESH_MS = 10_000;
const MAX_ROWS = 200;
const HL_INFO = 'https://api.hyperliquid.xyz/info';
const LBANK_MARKET = '/lbank-perp/cfd/openApi/v1/pub/marketData?productGroup=SwapU';

/** Hyperliquid `xyz` dex lists stocks, indices and FX too; keep the commodities only. */
const XYZ_COMMODITIES = new Set([
  'GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM', 'COPPER', 'ALUMINIUM', 'URANIUM',
  'CL', 'BRENTOIL', 'NATGAS', 'HO', 'TTF', 'CORN', 'WHEAT',
]);
const GOLD_LIKE = new Set(['GOLD', 'XAU', 'XAUT', 'PAXG']);

const PRESETS: Array<[Preset, string]> = [
  ['all', 'All'],
  ['gainers', 'Top gainers'],
  ['losers', 'Top losers'],
  ['active', 'Most active'],
];
const SOURCES: Array<[SourceFilter, string]> = [
  ['all', 'All sources'],
  ['lbank', 'LBank'],
  ['hyperliquid', 'Hyperliquid'],
];
const COLS: Array<[SortKey, string]> = [
  ['base', 'Symbol'],
  ['price', 'Price'],
  ['chg', 'Chg %'],
  ['vol', 'Vol 24h'],
  ['funding', 'Funding'],
  ['oi', 'OI'],
  ['high', 'High'],
  ['low', 'Low'],
];

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_PREFS };
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export function fmtPrice(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  const digits = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : a >= 0.0001 ? 7 : 10;
  return p.toLocaleString('en-US', { minimumFractionDigits: a >= 1000 ? 2 : 0, maximumFractionDigits: digits });
}

export function fmtCompact(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return v.toFixed(0);
}

/**
 * US stock / ETF tokens (crypto and gold are the focus). Learned from the stock names on
 * Hyperliquid's xyz dex, plus common ETFs it doesn't list; LBank perps on these bases
 * are hidden.
 */
const STOCK_BASES = new Set(['SPY', 'QQQ', 'SOXL', 'TQQQ', 'SQQQ', 'IWM', 'DIA', 'ARKK', 'TSLL', 'NVDL', 'MSTU', 'CONL']);

async function fetchLbank(): Promise<Row[]> {
  const res = await fetch(LBANK_MARKET);
  if (!res.ok) throw new Error(`LBank ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{
      symbol?: string;
      lastPrice?: string;
      openPrice?: string;
      highestPrice?: string;
      lowestPrice?: string;
      turnover?: string;
      instrumentStatus?: string;
      fundingRate?: string;
      positionFeeTime?: number;
    }>;
  };
  const out: Row[] = [];
  for (const r of json.data ?? []) {
    if (!r.symbol || !r.symbol.endsWith('USDT')) continue;
    if (r.instrumentStatus != null && r.instrumentStatus !== '2') continue;
    const price = num(r.lastPrice);
    if (!(price > 0)) continue;
    const open = num(r.openPrice);
    const high = num(r.highestPrice);
    const low = num(r.lowestPrice);
    const funding = num(r.fundingRate);
    const feeSecs = num(r.positionFeeTime);
    out.push({
      symbol: `lbank:${r.symbol}.P`,
      base: r.symbol.replace(/USDT$/, ''),
      venue: 'lbank',
      hint: 'LBank · Perp',
      price,
      chg: open > 0 ? ((price - open) / open) * 100 : 0,
      vol: num(r.turnover) || 0,
      high: high > 0 ? high : null,
      low: low > 0 ? low : null,
      funding: Number.isFinite(funding) ? funding : null,
      fundingHours: feeSecs > 0 ? feeSecs / 3600 : 8,
      oi: null,
    });
  }
  return out;
}

type HlMeta = { universe: Array<{ name: string; isDelisted?: boolean }> };
type HlCtx = { markPx?: string; midPx?: string; prevDayPx?: string; dayNtlVlm?: string; funding?: string; openInterest?: string };

async function fetchHl(dex?: string): Promise<Row[]> {
  const body: Record<string, string> = { type: 'metaAndAssetCtxs' };
  if (dex) body.dex = dex;
  const res = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid${dex ? ` ${dex}` : ''} ${res.status}`);
  const [meta, ctxs] = (await res.json()) as [HlMeta, HlCtx[]];
  const out: Row[] = [];
  (meta?.universe ?? []).forEach((u, i) => {
    if (!u?.name || u.isDelisted) return;
    const c = ctxs?.[i];
    const price = num(c?.markPx ?? c?.midPx);
    if (!(price > 0)) return;
    const base = dex ? u.name.replace(`${dex}:`, '') : u.name;
    if (dex === 'xyz' && !XYZ_COMMODITIES.has(base)) {
      STOCK_BASES.add(base);
      return;
    }
    const prev = num(c?.prevDayPx);
    const funding = num(c?.funding);
    const oi = num(c?.openInterest) * price;
    out.push({
      symbol: `hyperliquid:${u.name}`,
      base,
      venue: 'hyperliquid',
      hint: dex ? `Hyperliquid ${dex.toUpperCase()} · Perp` : 'Hyperliquid · Perp',
      price,
      chg: prev > 0 ? ((price - prev) / prev) * 100 : 0,
      vol: num(c?.dayNtlVlm) || 0,
      high: null,
      low: null,
      funding: Number.isFinite(funding) ? funding : null,
      fundingHours: 1,
      oi: oi > 0 ? oi : null,
    });
  });
  return out;
}

/** Annualized funding (fraction), the fair sort key across 1 h and 8 h venues. */
const fundingApr = (r: Row): number | null => (r.funding == null ? null : (r.funding / r.fundingHours) * 24 * 365);

function fundingCell(r: Row): string {
  if (r.funding == null) return '<span class="desk-scr__num desk-scr__fund" data-dir="flat">—</span>';
  const pct = r.funding * 100;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const apr = (fundingApr(r) ?? 0) * 100;
  const tip = `${pct > 0 ? '+' : ''}${pct.toFixed(4)}% per ${r.fundingHours}h · ${apr > 0 ? '+' : ''}${apr.toFixed(1)}% APR`;
  return `<span class="desk-scr__num desk-scr__fund" data-dir="${dir}" title="${esc(tip)}">${pct > 0 ? '+' : ''}${pct.toFixed(4)}%</span>`;
}

function iconUrl(base: string): string | null {
  const b = base.toUpperCase().replace(/^10+(?=[A-Z])/, '');
  const coin = GOLD_LIKE.has(b) ? 'PAXG' : b;
  return /^[A-Z0-9]{2,10}$/.test(coin) ? `https://crypto-icons.ledger.com/${coin}.png` : null;
}

function iconHtml(chart: Vela | null, row: Row): string {
  let url: string | null | undefined;
  try {
    url = chart?.data.symbolIcon(row.symbol);
  } catch {
    url = undefined;
  }
  if (!url) url = iconUrl(row.base);
  const initials = esc(row.base.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase());
  return url
    ? `<img class="desk-scr__icon" src="${esc(url)}" alt="" loading="lazy" data-ini="${initials}" />`
    : `<span class="desk-scr__icon desk-scr__icon--txt">${initials}</span>`;
}

export function registerScreenerPanel(): void {
  registerSidePanel({
    id: 'desk.screener',
    title: 'Screener',
    icon: 'desk-screener',
    order: 7,
    width: 380,
    resizable: true,
    minWidth: 320,
    maxWidth: 640,
    placement: 'column',
    mount: (ctx, body) => {
      const prefs = loadPrefs();
      let chart: Vela | null = null;
      let rows: Row[] = [];
      let failed: string[] = [];
      let updatedAt = 0;
      let loading = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      let offMarket: (() => void) | null = null;
      /** Last fetch result per source, so one failing source keeps its previous rows. */
      const bySource = new Map<string, Row[]>();

      body.className = 'desk-scr';
      body.innerHTML = `
        <div class="desk-scr__tabs" role="tablist">
          ${PRESETS.map(([id, label]) => `<button type="button" role="tab" data-preset="${id}">${label}</button>`).join('')}
          <span class="desk-scr__spacer"></span>
          <button type="button" class="desk-scr__refresh" data-act="refresh" title="Refresh" aria-label="Refresh">↻</button>
        </div>
        <div class="desk-scr__filters">
          <div class="desk-scr__chips" data-sources></div>
          <input class="desk-scr__search" type="search" placeholder="Search coin" spellcheck="false" autocomplete="off" data-search />
        </div>
        <div class="desk-scr__table">
          <div class="desk-scr__head" data-head></div>
          <div class="desk-scr__list" data-list role="listbox"></div>
        </div>
        <div class="desk-scr__foot" data-foot></div>`;
      const sourcesEl = body.querySelector<HTMLElement>('[data-sources]')!;
      const headEl = body.querySelector<HTMLElement>('[data-head]')!;
      const listEl = body.querySelector<HTMLElement>('[data-list]')!;
      const footEl = body.querySelector<HTMLElement>('[data-foot]')!;
      const searchEl = body.querySelector<HTMLInputElement>('[data-search]')!;
      searchEl.value = prefs.query;

      const current = (): string => (chart?.market.symbol ?? '').toLowerCase();

      /** Sort that applies: an explicit header click wins over the preset's default. */
      function effectiveSort(): { key: SortKey; dir: 1 | -1 } | null {
        if (prefs.sort) return { key: prefs.sort, dir: prefs.dir };
        if (prefs.preset === 'gainers') return { key: 'chg', dir: -1 };
        if (prefs.preset === 'losers') return { key: 'chg', dir: 1 };
        return { key: 'vol', dir: -1 };
      }

      function visibleRows(): Row[] {
        const q = prefs.query.trim().toUpperCase();
        let list = rows.filter(
          (r) => (prefs.source === 'all' || r.venue === prefs.source) && (!q || r.base.toUpperCase().includes(q)),
        );
        if (prefs.preset === 'gainers') list = list.filter((r) => r.chg > 0);
        else if (prefs.preset === 'losers') list = list.filter((r) => r.chg < 0);
        // Hotlists ignore dust markets, like TradingView's volume floor.
        if (prefs.preset === 'gainers' || prefs.preset === 'losers') list = list.filter((r) => r.vol >= 50_000);
        const s = effectiveSort();
        if (s) {
          const { key, dir } = s;
          list.sort((a, b) => {
            if (key === 'base') return a.base.localeCompare(b.base) * dir;
            const av = key === 'funding' ? fundingApr(a) : a[key];
            const bv = key === 'funding' ? fundingApr(b) : b[key];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return (av - bv) * dir;
          });
        }
        return list;
      }

      function renderControls(): void {
        for (const b of body.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
          const on = b.dataset.preset === prefs.preset;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', String(on));
        }
        sourcesEl.innerHTML = SOURCES.map(
          ([id, label]) =>
            `<button type="button" class="desk-scr__chip${prefs.source === id ? ' is-active' : ''}" data-source="${id}" aria-pressed="${prefs.source === id}">${label}</button>`,
        ).join('');
        const s = effectiveSort();
        headEl.innerHTML = COLS.map(([key, label]) => {
          const on = s?.key === key;
          const arrow = on ? (s!.dir === 1 ? '▲' : '▼') : '';
          const tip =
            key === 'funding'
              ? 'Current funding rate per period (Hyperliquid 1h, LBank 8h); sorts by the annualized rate'
              : key === 'oi'
                ? 'Open interest, USD notional (Hyperliquid only)'
                : `Sort by ${label}`;
          return `<button type="button" class="desk-scr__th desk-scr__th--${key}${on ? ' is-sorted' : ''}" data-sort="${key}" title="${tip}">${label}<i>${arrow}</i></button>`;
        }).join('');
      }

      function renderList(): void {
        const list = visibleRows();
        const cur = current();
        if (!list.length) {
          listEl.innerHTML = `<div class="desk-scr__empty">${loading && !rows.length ? 'Loading markets…' : rows.length ? 'No markets match.' : failed.length ? 'Markets unavailable right now.' : 'No markets.'}</div>`;
        } else {
          listEl.innerHTML = list
            .slice(0, MAX_ROWS)
            .map((r) => {
              const dir = r.chg > 0 ? 'up' : r.chg < 0 ? 'down' : 'flat';
              const active = r.symbol.toLowerCase() === cur;
              return `<div class="desk-scr__row${active ? ' is-active' : ''}" role="option" aria-selected="${active}" tabindex="0" data-symbol="${esc(r.symbol)}" title="${esc(`${r.symbol}`)}">
                <span class="desk-scr__sym">
                  ${iconHtml(chart, r)}
                  <span class="desk-scr__names"><b>${esc(r.base)}</b><small>${esc(r.hint)}</small></span>
                  <button type="button" class="desk-scr__add" data-add="${esc(r.symbol)}" title="Add to watchlist" aria-label="Add ${esc(r.base)} to watchlist">+</button>
                </span>
                <span class="desk-scr__num">${fmtPrice(r.price)}</span>
                <span class="desk-scr__num desk-scr__chg" data-dir="${dir}">${r.chg > 0 ? '+' : ''}${r.chg.toFixed(2)}%</span>
                <span class="desk-scr__num">${r.vol > 0 ? `$${fmtCompact(r.vol)}` : '—'}</span>
                ${fundingCell(r)}
                <span class="desk-scr__num desk-scr__oi">${r.oi != null ? `$${fmtCompact(r.oi)}` : '—'}</span>
                <span class="desk-scr__num desk-scr__hl">${fmtPrice(r.high)}</span>
                <span class="desk-scr__num desk-scr__hl">${fmtPrice(r.low)}</span>
              </div>`;
            })
            .join('');
          for (const img of listEl.querySelectorAll<HTMLImageElement>('img.desk-scr__icon')) {
            img.addEventListener(
              'error',
              () => {
                const s = document.createElement('span');
                s.className = 'desk-scr__icon desk-scr__icon--txt';
                s.textContent = img.dataset.ini ?? '';
                img.replaceWith(s);
              },
              { once: true },
            );
          }
        }
        const shown = Math.min(list.length, MAX_ROWS);
        const time = updatedAt
          ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
          : '';
        footEl.innerHTML = `<span>${shown}${list.length > shown ? ` of ${list.length}` : ''} markets</span><span>${
          failed.length ? `<em>unavailable: ${esc(failed.join(', '))}</em> · ` : ''
        }${time ? `Updated ${time}` : loading ? 'Loading…' : ''}</span>`;
      }

      function render(): void {
        renderControls();
        renderList();
      }

      /** Repaint only the highlight (market change) without rebuilding the list. */
      function markActive(): void {
        const cur = current();
        for (const el of listEl.querySelectorAll<HTMLElement>('.desk-scr__row')) {
          const on = (el.dataset.symbol ?? '').toLowerCase() === cur;
          el.classList.toggle('is-active', on);
          el.setAttribute('aria-selected', String(on));
        }
      }

      async function refresh(): Promise<void> {
        if (loading) return;
        loading = true;
        body.classList.add('is-loading');
        if (!rows.length) renderList();
        const sources: Array<[string, () => Promise<Row[]>]> = [
          ['LBank', fetchLbank],
          ['Hyperliquid', () => fetchHl()],
          ['Hyperliquid XYZ', () => fetchHl('xyz')],
        ];
        const results = await Promise.allSettled(sources.map(([, fn]) => fn()));
        failed = [];
        results.forEach((r, i) => {
          const name = sources[i]![0];
          if (r.status === 'fulfilled') bySource.set(name, r.value);
          else failed.push(name);
        });
        rows = [...bySource.values()].flat().filter((r) => !(r.venue === 'lbank' && STOCK_BASES.has(r.base)));
        if (results.some((r) => r.status === 'fulfilled')) updatedAt = Date.now();
        loading = false;
        body.classList.remove('is-loading');
        // Keep the scroll position across refreshes.
        const top = listEl.scrollTop;
        renderList();
        listEl.scrollTop = top;
      }

      const visible = (): boolean => body.isConnected && body.offsetParent !== null;

      const stopTimer = (): void => {
        if (timer) clearInterval(timer);
        timer = null;
      };

      body.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement;
        const preset = t.closest<HTMLElement>('[data-preset]')?.dataset.preset as Preset | undefined;
        if (preset) {
          prefs.preset = preset;
          prefs.sort = null;
          savePrefs(prefs);
          listEl.scrollTop = 0;
          render();
          return;
        }
        if (t.closest('[data-act="refresh"]')) {
          void refresh();
          return;
        }
        const source = t.closest<HTMLElement>('[data-source]')?.dataset.source as SourceFilter | undefined;
        if (source) {
          prefs.source = source;
          savePrefs(prefs);
          render();
          return;
        }
        const sort = t.closest<HTMLElement>('[data-sort]')?.dataset.sort as SortKey | undefined;
        if (sort) {
          const s = effectiveSort();
          if (s?.key === sort) prefs.dir = s.dir === 1 ? -1 : 1;
          else prefs.dir = sort === 'base' ? 1 : -1;
          prefs.sort = sort;
          savePrefs(prefs);
          render();
          return;
        }
        const add = t.closest<HTMLElement>('[data-add]')?.dataset.add;
        if (add) {
          ev.stopPropagation();
          const item = addWatchItem(add);
          ctx.toast(item ? `Added ${item.label} to watchlist` : 'Already in watchlist', item ? 'success' : 'info');
          return;
        }
        const sym = t.closest<HTMLElement>('[data-symbol]')?.dataset.symbol;
        if (sym) {
          ctx.setSymbol(sym);
          for (const el of listEl.querySelectorAll<HTMLElement>('.desk-scr__row')) {
            el.classList.toggle('is-active', el.dataset.symbol === sym);
          }
        }
      });

      listEl.addEventListener('keydown', (ev) => {
        const row = (ev.target as HTMLElement).closest<HTMLElement>('.desk-scr__row');
        if (!row) return;
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ctx.setSymbol(row.dataset.symbol!);
        } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          const next = (ev.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
          next?.focus();
        }
      });

      let searchTimer: ReturnType<typeof setTimeout> | null = null;
      searchEl.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          prefs.query = searchEl.value;
          savePrefs(prefs);
          listEl.scrollTop = 0;
          renderList();
        }, 120);
      });

      render();

      return {
        onChart: (c) => {
          chart = c;
          offMarket?.();
          offMarket = c.on('market:changed', () => markActive());
          markActive();
        },
        onOpen: () => {
          if (Date.now() - updatedAt > REFRESH_MS) void refresh();
          stopTimer();
          timer = setInterval(() => {
            if (!visible()) {
              // Panel closed: stop polling until it opens again.
              stopTimer();
              return;
            }
            void refresh();
          }, REFRESH_MS);
        },
        destroy: () => {
          stopTimer();
          if (searchTimer) clearTimeout(searchTimer);
          offMarket?.();
        },
      };
    },
  });
}
