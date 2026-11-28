/**
 * TradingView-style "News" side panel: headlines from crypto + macro feeds and the
 * week's economic calendar (ForexFactory), both through the cached `/feeds/*` proxy
 * (see `feeds.mjs`). Headlines can be narrowed to the symbol on the chart.
 */
import type { Vela } from '@luxalgo/vela';
import { registerIcon, registerSidePanel } from '@luxalgo/vela/plugin';

registerIcon(
  'desk-news',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4"/></svg>',
);

type FeedInfo = { id: string; label: string; group: 'crypto' | 'macro' };
type Headline = {
  id: string;
  title: string;
  link: string;
  time: number;
  source: string;
  group: FeedInfo['group'];
  summary: string;
  tags: string[];
};
type CalEvent = {
  title: string;
  country: string;
  time: number;
  impact: 'High' | 'Medium' | 'Low' | 'Holiday' | string;
  forecast: string;
  previous: string;
  actual?: string;
  allDay: boolean;
  url: string;
};

type NewsFilter = 'all' | 'crypto' | 'macro' | 'symbol';
type Prefs = { tab: 'news' | 'calendar'; filter: NewsFilter; impacts: string[]; currencies: string[] };

const LS_KEY = 'chart-desk-news-v1';
const SEEN_KEY = 'chart-desk-news-seen';
const DEFAULT_PREFS: Prefs = { tab: 'news', filter: 'all', impacts: ['High', 'Medium'], currencies: ['USD'] };
const NEWS_REFRESH = 2 * 60_000;
const CAL_REFRESH = 15 * 60_000;
const MAX_ITEMS = 120;

/** Keyword → tag. Tags drive the chips on each headline and the "chart symbol" filter. */
const TAGS: Array<[string, RegExp]> = [
  ['BTC', /\b(bitcoin|btc)\b/i],
  ['ETH', /\b(ethereum|ether|eth)\b/i],
  ['SOL', /\b(solana|sol)\b/i],
  ['XLM', /\b(stellar|xlm)\b/i],
  ['XRP', /\b(xrp|ripple)\b/i],
  ['DOGE', /\b(dogecoin|doge)\b/i],
  ['INJ', /\b(injective|inj)\b/i],
  ['BNB', /\b(bnb|binance coin)\b/i],
  ['ADA', /\b(cardano|ada)\b/i],
  ['AVAX', /\b(avalanche|avax)\b/i],
  ['LINK', /\b(chainlink)\b/i],
  ['SUI', /\bsui\b/i],
  ['HYPE', /\b(hyperliquid|hype)\b/i],
  ['GOLD', /\b(gold|bullion|xau|precious metals?)\b/i],
  ['SILVER', /\b(silver|xag)\b/i],
  ['FED', /\b(fed|fomc|powell|federal reserve|rate cut|rate hike|interest rates?)\b/i],
  ['CPI', /\b(cpi|inflation|pce)\b/i],
  ['JOBS', /\b(payrolls|nfp|jobless|unemployment|jobs report)\b/i],
  ['ETF', /\betfs?\b/i],
];

/** Chart symbol base → the tag(s) that count as "about this market". */
const SYMBOL_TAGS: Record<string, string[]> = {
  XAUT: ['GOLD'],
  PAXG: ['GOLD'],
  XAU: ['GOLD'],
  GOLD: ['GOLD'],
  XAG: ['SILVER'],
  SILVER: ['SILVER'],
};

const FLAGS: Record<string, string> = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', CNY: '🇨🇳', CAD: '🇨🇦', AUD: '🇦🇺', NZD: '🇳🇿', CHF: '🇨🇭',
};
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'NZD', 'CHF'];
const IMPACTS = ['High', 'Medium', 'Low', 'Holiday'];

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

function stripHtml(s: string): string {
  const doc = new DOMParser().parseFromString(s, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function tagsFor(text: string): string[] {
  return TAGS.filter(([, re]) => re.test(text)).map(([t]) => t);
}

/** `lbank:BTCUSDT.P`, `hyperliquid:xyz:GOLD`, `coinbase:BTC-USD` → `BTC` / `GOLD`. */
export function symbolBase(symbol: string | undefined): string {
  if (!symbol) return '';
  let t = symbol.split(':').pop()!.toUpperCase().replace(/\.P$/, '');
  if (t.includes('-')) t = t.split('-')[0]!;
  t = t.replace(/(USDT|USDC|USD)$/, '');
  return t || symbol.toUpperCase();
}

function symbolTags(symbol: string | undefined): string[] {
  const base = symbolBase(symbol);
  return SYMBOL_TAGS[base] ?? (base ? [base] : []);
}

export function relTime(t: number, now = Date.now()): string {
  const s = Math.round((now - t) / 1000);
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

function parseFeed(xml: string, feed: FeedInfo): Headline[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return [];
  const nodes = [...doc.querySelectorAll('item, entry')];
  const out: Headline[] = [];
  for (const n of nodes) {
    const text = (sel: string): string => n.querySelector(sel)?.textContent?.trim() ?? '';
    const title = stripHtml(text('title'));
    const linkEl = n.querySelector('link');
    const link = (linkEl?.getAttribute('href') || linkEl?.textContent || text('guid')).trim();
    const when = Date.parse(text('pubDate') || text('published') || text('updated') || n.getElementsByTagName('dc:date')[0]?.textContent || '');
    if (!title || !/^https?:/i.test(link)) continue;
    const summary = stripHtml(text('description') || text('summary')).slice(0, 280);
    out.push({
      id: link,
      title,
      link,
      time: Number.isFinite(when) ? when : 0,
      source: feed.label,
      group: feed.group,
      summary,
      tags: tagsFor(`${title} ${summary}`),
    });
  }
  return out;
}

async function fetchHeadlines(): Promise<{ items: Headline[]; failed: string[] }> {
  const feeds = (await (await fetch('/feeds/index')).json()) as FeedInfo[];
  const failed: string[] = [];
  const lists = await Promise.all(
    feeds.map(async (f) => {
      try {
        const res = await fetch(`/feeds/news/${f.id}`);
        if (!res.ok) throw new Error(String(res.status));
        return parseFeed(await res.text(), f);
      } catch {
        failed.push(f.label);
        return [];
      }
    }),
  );
  // Same story syndicated twice: keep the first by link and by normalized title.
  const seen = new Set<string>();
  const items: Headline[] = [];
  for (const h of lists.flat().sort((a, b) => b.time - a.time)) {
    const key = h.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(h.link) || seen.has(key)) continue;
    seen.add(h.link);
    seen.add(key);
    items.push(h);
  }
  return { items: items.slice(0, MAX_ITEMS), failed };
}

async function fetchCalendar(): Promise<CalEvent[]> {
  const res = await fetch('/feeds/calendar');
  if (!res.ok) throw new Error(`calendar ${res.status}`);
  const raw = (await res.json()) as Array<Record<string, string>>;
  return raw
    .map((e) => ({
      title: e.title ?? '',
      country: (e.country ?? '').toUpperCase(),
      time: Date.parse(e.date ?? ''),
      impact: e.impact ?? '',
      forecast: e.forecast ?? '',
      previous: e.previous ?? '',
      actual: e.actual,
      allDay: String(e.allDay) === 'true' || /^(all day|tentative)$/i.test(e.time ?? ''),
      url: /^https:\/\/www\.forexfactory\.com\//.test(e.url ?? '') ? e.url! : '',
    }))
    .filter((e) => e.title && Number.isFinite(e.time))
    .sort((a, b) => a.time - b.time);
}

/** Numbers like `0.3%`, `215K`, `-1.2B` for actual-vs-forecast colouring. */
function num(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const mult = /k$/i.test(s) ? 1e3 : /m$/i.test(s) ? 1e6 : /b$/i.test(s) ? 1e9 : /t$/i.test(s) ? 1e12 : 1;
  return Number(m[0]) * mult;
}

export function registerNewsPanel(): void {
  registerSidePanel({
    id: 'desk.news',
    title: 'News & Calendar',
    icon: 'desk-news',
    order: 6,
    width: 340,
    resizable: true,
    minWidth: 280,
    maxWidth: 560,
    placement: 'column',
    mount: (_ctx, body) => {
      const prefs = loadPrefs();
      let chart: Vela | null = null;
      let headlines: Headline[] = [];
      let failed: string[] = [];
      let events: CalEvent[] = [];
      let calError = '';
      let newsAt = 0;
      let calAt = 0;
      let loadingNews = false;
      let loadingCal = false;
      let open = false;
      let seenAt = Number(localStorage.getItem(SEEN_KEY) ?? 0);
      let timers: ReturnType<typeof setInterval>[] = [];
      let offMarket: (() => void) | null = null;

      body.className = 'desk-panel desk-news';
      body.innerHTML = `
        <div class="desk-news__tabs" role="tablist">
          <button type="button" role="tab" data-tab="news">Headlines</button>
          <button type="button" role="tab" data-tab="calendar">Calendar</button>
          <span class="desk-news__spacer"></span>
          <button type="button" class="desk-news__refresh" data-act="refresh" title="Refresh" aria-label="Refresh">↻</button>
        </div>
        <div class="desk-news__filters" data-filters></div>
        <div class="desk-news__next" data-next hidden></div>
        <div class="desk-news__list" data-list></div>
        <div class="desk-news__foot" data-foot></div>`;
      const filtersEl = body.querySelector<HTMLElement>('[data-filters]')!;
      const listEl = body.querySelector<HTMLElement>('[data-list]')!;
      const footEl = body.querySelector<HTMLElement>('[data-foot]')!;
      const nextEl = body.querySelector<HTMLElement>('[data-next]')!;

      const chartSymbol = (): string | undefined => chart?.market.symbol;

      const chip = (attr: string, value: string, label: string, on: boolean): string =>
        `<button type="button" class="desk-news__chip${on ? ' is-active' : ''}" data-${attr}="${esc(value)}" aria-pressed="${on}">${esc(label)}</button>`;

      function renderFilters(): void {
        if (prefs.tab === 'news') {
          const base = symbolBase(chartSymbol());
          filtersEl.innerHTML = [
            chip('filter', 'all', 'All', prefs.filter === 'all'),
            chip('filter', 'crypto', 'Crypto', prefs.filter === 'crypto'),
            chip('filter', 'macro', 'Gold & Macro', prefs.filter === 'macro'),
            base ? chip('filter', 'symbol', base, prefs.filter === 'symbol') : '',
          ].join('');
        } else {
          filtersEl.innerHTML = `
            <div class="desk-news__row">${IMPACTS.map((i) => chip('impact', i, i, prefs.impacts.includes(i))).join('')}</div>
            <div class="desk-news__row">${chip('cur', '*', 'All', prefs.currencies.length === 0)}${CURRENCIES.map((c) =>
              chip('cur', c, c, prefs.currencies.includes(c)),
            ).join('')}</div>`;
        }
      }

      function renderTabs(): void {
        for (const b of body.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
          const on = b.dataset.tab === prefs.tab;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', String(on));
        }
      }

      function visibleHeadlines(): Headline[] {
        if (prefs.filter === 'crypto') return headlines.filter((h) => h.group === 'crypto');
        if (prefs.filter === 'macro') return headlines.filter((h) => h.group === 'macro' || h.tags.some((t) => ['GOLD', 'SILVER', 'FED', 'CPI', 'JOBS'].includes(t)));
        if (prefs.filter === 'symbol') {
          const want = symbolTags(chartSymbol());
          return headlines.filter((h) => h.tags.some((t) => want.includes(t)));
        }
        return headlines;
      }

      function renderNews(): void {
        const now = Date.now();
        const rows = visibleHeadlines();
        if (!rows.length) {
          listEl.innerHTML = `<div class="desk-news__empty">${loadingNews ? 'Loading headlines…' : 'No headlines match this filter.'}</div>`;
        } else {
          listEl.innerHTML = rows
            .map((h) => {
              const fresh = h.time > seenAt && h.time > now - 6 * 3600_000;
              return `<a class="desk-news__item${fresh ? ' is-new' : ''}" href="${esc(h.link)}" target="_blank" rel="noopener noreferrer" title="${esc(h.summary)}">
                <div class="desk-news__meta"><span class="desk-news__src">${esc(h.source)}</span><span>${h.time ? relTime(h.time, now) : ''}</span></div>
                <div class="desk-news__title">${esc(h.title)}</div>
                ${h.tags.length ? `<div class="desk-news__tags">${h.tags.slice(0, 4).map((t) => `<span>${t}</span>`).join('')}</div>` : ''}
              </a>`;
            })
            .join('');
        }
        footEl.textContent = newsAt
          ? `Updated ${new Date(newsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}${failed.length ? ` · unavailable: ${failed.join(', ')}` : ''}`
          : '';
      }

      function visibleEvents(): CalEvent[] {
        return events.filter(
          (e) => prefs.impacts.includes(e.impact) && (prefs.currencies.length === 0 || prefs.currencies.includes(e.country)),
        );
      }

      function renderNext(): void {
        const now = Date.now();
        const next = events.find(
          (e) => e.impact === 'High' && e.time > now - 60_000 && (prefs.currencies.length === 0 || prefs.currencies.includes(e.country)),
        );
        if (!next) {
          nextEl.hidden = true;
          return;
        }
        nextEl.hidden = false;
        const soon = next.time - now < 30 * 60_000;
        nextEl.classList.toggle('is-soon', soon);
        nextEl.innerHTML = `<span class="desk-news__dot is-high"></span><span>Next high impact: <b>${FLAGS[next.country] ?? ''} ${esc(next.country)} ${esc(next.title)}</b></span><span class="desk-news__count">${countdown(next.time - now)}</span>`;
      }

      function renderCalendar(): void {
        const now = Date.now();
        const rows = visibleEvents();
        if (!rows.length) {
          listEl.innerHTML = `<div class="desk-news__empty">${loadingCal ? 'Loading calendar…' : calError || 'No events match these filters.'}</div>`;
        } else {
          let day = '';
          let nowMarked = false;
          const html: string[] = [];
          for (const e of rows) {
            const d = new Date(e.time);
            const dayKey = d.toDateString();
            if (dayKey !== day) {
              day = dayKey;
              const today = dayKey === new Date(now).toDateString();
              html.push(`<div class="desk-news__day${today ? ' is-today' : ''}">${today ? 'Today · ' : ''}${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</div>`);
            }
            if (!nowMarked && e.time > now) {
              nowMarked = true;
              html.push('<div class="desk-news__now"><span>Now</span></div>');
            }
            const allDay = e.allDay || (e.impact === 'Holiday' && d.getHours() === 0 && d.getMinutes() === 0);
            const a = num(e.actual);
            const f = num(e.forecast);
            const beat = a != null && f != null && a !== f ? (a > f ? 'is-up' : 'is-down') : '';
            const imp = e.impact.toLowerCase();
            html.push(`<div class="desk-news__ev${e.time < now ? ' is-past' : ''}" title="${esc(`${e.impact} impact`)}">
              <span class="desk-news__time">${allDay ? 'All day' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
              <span class="desk-news__dot is-${imp}"></span>
              <span class="desk-news__cur">${FLAGS[e.country] ?? ''} ${esc(e.country)}</span>
              <span class="desk-news__evt">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>` : esc(e.title)}</span>
              <span class="desk-news__nums">
                ${e.actual ? `<span class="${beat}" title="Actual">${esc(e.actual)}</span>` : ''}
                ${e.forecast ? `<span title="Forecast">F ${esc(e.forecast)}</span>` : ''}
                ${e.previous ? `<span title="Previous">P ${esc(e.previous)}</span>` : ''}
              </span>
            </div>`);
          }
          if (!nowMarked) {
            html.push(
              `<div class="desk-news__now"><span>Now</span></div><div class="desk-news__empty">This week's releases are done. ForexFactory publishes next week's calendar on Sunday.</div>`,
            );
          }
          listEl.innerHTML = html.join('');
        }
        footEl.textContent = calAt
          ? `ForexFactory · this week · times in your timezone · updated ${new Date(calAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
          : '';
      }

      function render(): void {
        renderTabs();
        renderFilters();
        renderNext();
        if (prefs.tab === 'news') renderNews();
        else renderCalendar();
      }

      async function refreshNews(): Promise<void> {
        if (loadingNews) return;
        loadingNews = true;
        if (!headlines.length && prefs.tab === 'news') render();
        try {
          const r = await fetchHeadlines();
          headlines = r.items;
          failed = r.failed;
          newsAt = Date.now();
        } catch {
          failed = ['all feeds'];
        } finally {
          loadingNews = false;
          render();
        }
      }

      async function refreshCalendar(): Promise<void> {
        if (loadingCal) return;
        loadingCal = true;
        if (!events.length && prefs.tab === 'calendar') render();
        try {
          events = await fetchCalendar();
          calError = '';
          calAt = Date.now();
        } catch {
          calError = 'Calendar unavailable right now (ForexFactory rate limit). Retrying shortly.';
        } finally {
          loadingCal = false;
          render();
        }
      }

      const markSeen = (): void => {
        seenAt = Date.now();
        try {
          localStorage.setItem(SEEN_KEY, String(seenAt));
        } catch {
          /* ignore */
        }
      };

      body.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement;
        const tab = t.closest<HTMLElement>('[data-tab]')?.dataset.tab;
        if (tab === 'news' || tab === 'calendar') {
          prefs.tab = tab;
          savePrefs(prefs);
          render();
          // Scroll to "now" so today's releases are in view.
          if (tab === 'calendar') listEl.querySelector('.desk-news__now')?.scrollIntoView({ block: 'center' });
          return;
        }
        if (t.closest('[data-act="refresh"]')) {
          void (prefs.tab === 'news' ? refreshNews() : refreshCalendar());
          return;
        }
        const filter = t.closest<HTMLElement>('[data-filter]')?.dataset.filter as NewsFilter | undefined;
        if (filter) {
          prefs.filter = filter;
          savePrefs(prefs);
          render();
          return;
        }
        const impact = t.closest<HTMLElement>('[data-impact]')?.dataset.impact;
        if (impact) {
          prefs.impacts = prefs.impacts.includes(impact) ? prefs.impacts.filter((i) => i !== impact) : [...prefs.impacts, impact];
          savePrefs(prefs);
          render();
          return;
        }
        const cur = t.closest<HTMLElement>('[data-cur]')?.dataset.cur;
        if (cur) {
          if (cur === '*') prefs.currencies = [];
          else prefs.currencies = prefs.currencies.includes(cur) ? prefs.currencies.filter((c) => c !== cur) : [...prefs.currencies, cur];
          savePrefs(prefs);
          render();
        }
      });

      const stopTimers = (): void => {
        for (const t of timers) clearInterval(t);
        timers = [];
      };

      render();

      return {
        onChart: (c) => {
          chart = c;
          offMarket?.();
          offMarket = c.on('market:changed', () => {
            if (prefs.tab === 'news') render();
          });
          render();
        },
        onOpen: () => {
          open = true;
          if (Date.now() - newsAt > NEWS_REFRESH) void refreshNews();
          if (Date.now() - calAt > CAL_REFRESH) void refreshCalendar();
          stopTimers();
          timers = [
            setInterval(() => {
              if (!body.isConnected || body.offsetParent === null) {
                // Panel closed: mark what was shown as seen and go quiet.
                if (open) markSeen();
                open = false;
                stopTimers();
                return;
              }
              void refreshNews();
            }, NEWS_REFRESH),
            setInterval(() => void refreshCalendar(), CAL_REFRESH),
            // Countdown and relative times.
            setInterval(() => {
              if (body.offsetParent === null) return;
              renderNext();
              if (prefs.tab === 'calendar') renderCalendar();
              else renderNews();
            }, 30_000),
          ];
        },
        destroy: () => {
          stopTimers();
          offMarket?.();
        },
      };
    },
  });
}
