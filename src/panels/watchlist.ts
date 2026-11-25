import { registerIcon, registerSidePanel, registerWidgetAttachment } from '@luxalgo/vela/plugin';
import {
  deskAgeLabel,
  deskStatusFor,
  isDeskStale,
  loadDeskLatest,
  marketForSymbol,
  type DeskLatest,
} from '../desk/approvals';
import { onHlQuotes, startHlQuotes } from '../lib/hl-quotes';
import { fetchLbankQuote } from '../providers/lbank';
import {
  addSection,
  addWatchItem,
  clearActiveList,
  createList,
  deleteList,
  exportActiveListTxt,
  getActiveList,
  getActiveListId,
  getActiveListName,
  getLists,
  getSort,
  getWatchlist,
  importActiveListTxt,
  isSection,
  isSymbol,
  onWatchlistChange,
  removeSection,
  removeWatchItem,
  renameList,
  renameSection,
  reorderEntries,
  resetWatchlist,
  setActiveList,
  setSort,
  updateWatchItem,
  type WatchEntry,
  type WatchItem,
  type WatchSort,
} from '../lib/watchlist-store';

export type { WatchItem };
/** @deprecated use getWatchlist() — kept for any stale imports */
export const WATCHLIST = getWatchlist();

registerIcon(
  'desk-watch',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3.5h10M3 8h10M3 12.5h7"/><circle cx="13" cy="12.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
);

type Quote = { price: number; changePct: number };

const quoteCache = new Map<string, Quote>();

function formatPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function syncHlQuotes(): void {
  startHlQuotes(
    getWatchlist()
      .filter((w) => w.quote !== 'lbank' && w.hlCoin)
      .map((w) => ({
        symbol: w.symbol,
        midKey: w.hlCoin!,
        dex: w.hlDex,
      })),
  );
}

function sortedEntries(
  entries: WatchEntry[],
  sort: WatchSort,
): { entry: WatchEntry; index: number }[] {
  const indexed = entries.map((entry, index) => ({ entry, index }));
  if (sort === 'manual') return indexed;

  // Sort symbols within each section block (TV-like)
  const blocks: { entry: WatchEntry; index: number }[][] = [];
  let cur: { entry: WatchEntry; index: number }[] = [];
  for (const row of indexed) {
    if (isSection(row.entry)) {
      if (cur.length) blocks.push(cur);
      blocks.push([row]);
      cur = [];
    } else {
      cur.push(row);
    }
  }
  if (cur.length) blocks.push(cur);

  const cmp = (a: WatchItem, b: WatchItem): number => {
    const qa = quoteCache.get(a.symbol);
    const qb = quoteCache.get(b.symbol);
    if (sort === 'last' || sort === 'last-desc') {
      const pa = qa?.price ?? Number.NEGATIVE_INFINITY;
      const pb = qb?.price ?? Number.NEGATIVE_INFINITY;
      return sort === 'last' ? pa - pb : pb - pa;
    }
    const ca = qa?.changePct ?? Number.NEGATIVE_INFINITY;
    const cb = qb?.changePct ?? Number.NEGATIVE_INFINITY;
    return sort === 'chg' ? ca - cb : cb - ca;
  };

  const out: { entry: WatchEntry; index: number }[] = [];
  for (const block of blocks) {
    if (block.length === 1 && isSection(block[0]!.entry)) {
      out.push(block[0]!);
      continue;
    }
    const syms = block.filter((b) => isSymbol(b.entry));
    syms.sort((a, b) => cmp(a.entry as WatchItem, b.entry as WatchItem));
    out.push(...syms);
  }
  return out;
}

type CtxToast = (message: string, kind?: 'info' | 'success' | 'error') => void;

function openPrompt(
  host: HTMLElement,
  title: string,
  fields: { name: string; label: string; value: string; max?: number }[],
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'desk-watch__dialog-bg';
    const fieldHtml = fields
      .map(
        (f) => `
      <label class="desk-watch__field">
        <span>${escapeAttr(f.label)}</span>
        <input name="${escapeAttr(f.name)}" type="text" value="${escapeAttr(f.value)}" ${
          f.max ? `maxlength="${f.max}"` : ''
        } autocomplete="off" spellcheck="false" />
      </label>`,
      )
      .join('');
    backdrop.innerHTML = `
      <form class="desk-watch__dialog" role="dialog" aria-label="${escapeAttr(title)}">
        <h3 class="desk-watch__dialog-title">${escapeAttr(title)}</h3>
        ${fieldHtml}
        <div class="desk-watch__dialog-actions">
          <button type="button" data-act="cancel" class="desk-watch__btn">Cancel</button>
          <button type="submit" class="desk-watch__btn desk-watch__btn--primary">Save</button>
        </div>
      </form>`;
    const form = backdrop.querySelector('form') as HTMLFormElement;
    const finish = (v: Record<string, string> | null) => {
      backdrop.remove();
      resolve(v);
    };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(null);
    });
    form.querySelector('[data-act="cancel"]')?.addEventListener('click', () => finish(null));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const out: Record<string, string> = {};
      for (const f of fields) out[f.name] = String(fd.get(f.name) || '').trim();
      finish(out);
    });
    host.appendChild(backdrop);
    (form.querySelector('input') as HTMLInputElement | null)?.focus();
  });
}

function closeMenus(root: HTMLElement): void {
  root.querySelectorAll('.desk-watch__menu, .desk-watch__ctx').forEach((el) => el.remove());
}

export function registerWatchlistPanel(): void {
  registerSidePanel({
    id: 'desk.watchlist',
    title: 'Watchlist',
    icon: 'desk-watch',
    order: 5,
    width: 300,
    resizable: true,
    minWidth: 240,
    maxWidth: 480,
    placement: 'column',
    mount: (ctx, body) => {
      body.className = 'desk-panel desk-watch';
      body.innerHTML = `
        <div class="desk-watch__head">
          <button type="button" class="desk-watch__list-btn" data-act="list-menu" title="Watchlist menu">
            <span class="desk-watch__list-name"></span>
            <span class="desk-watch__list-caret">▾</span>
          </button>
          <div class="desk-watch__head-actions">
            <button type="button" class="desk-watch__icon-btn" data-act="add" title="Add symbol" aria-label="Add symbol">+</button>
            <button type="button" class="desk-watch__icon-btn" data-act="search" title="Symbol search" aria-label="Symbol search">⌕</button>
          </div>
        </div>
        <div class="desk-watch__meta">
          <span class="desk-watch__fresh" data-stale="0">desk —</span>
        </div>
        <div class="desk-watch__cols" role="row">
          <button type="button" class="desk-watch__col desk-watch__col--sym" data-sort="manual" title="Reset sort">Symbol</button>
          <button type="button" class="desk-watch__col" data-sort="last" title="Sort by last">Last</button>
          <button type="button" class="desk-watch__col" data-sort="chg" title="Sort by change %">Chg %</button>
        </div>
        <ul class="desk-watch__list" role="listbox" aria-label="Watchlist symbols"></ul>
        <div class="desk-watch__add-bar">
          <input class="desk-watch__add-input" type="text" placeholder="Add symbol…" spellcheck="false" autocomplete="off" aria-label="Add symbol" />
          <ul class="desk-watch__suggest" hidden role="listbox" aria-label="Symbol suggestions"></ul>
        </div>
      `;

      const list = body.querySelector('.desk-watch__list') as HTMLUListElement;
      const listNameEl = body.querySelector('.desk-watch__list-name') as HTMLElement;
      const freshEl = body.querySelector('.desk-watch__fresh') as HTMLElement;
      const addInput = body.querySelector('.desk-watch__add-input') as HTMLInputElement;
      const suggestEl = body.querySelector('.desk-watch__suggest') as HTMLUListElement;
      const rows = new Map<string, HTMLElement>();
      let desk: DeskLatest | null = null;
      let addMode = false;
      let dragFrom = -1;
      let unsubQuotes: (() => void) | undefined;
      let deskTimer: ReturnType<typeof setInterval> | null = null;
      let lbankTimer: ReturnType<typeof setInterval> | null = null;
      let unsubMarket: (() => void) | undefined;
      let suggestIdx = -1;

      const PROVIDER_PREF = ['hyperliquid', 'lbank', 'binance', 'coinbase'];

      type SuggestHit = { qualified: string; ticker: string; provider: string; description?: string };

      const poolSymbols = (): SuggestHit[] => {
        try {
          const raw = ctx.chart.data.symbols() as Array<{
            ticker: string;
            provider?: string;
            description?: string;
          }>;
          return raw.map((s) => {
            const provider = (s.provider || 'hyperliquid').toLowerCase();
            return {
              ticker: s.ticker,
              provider,
              description: s.description,
              qualified: `${provider}:${s.ticker}`,
            };
          });
        } catch {
          return [];
        }
      };

      const resolveAddSymbol = (raw: string): string | null => {
        const symbol = raw.trim();
        if (!symbol) return null;
        if (symbol.includes(':')) return symbol;
        const q = symbol.toLowerCase();
        const pool = poolSymbols();
        const exact = pool.filter((s) => s.ticker.toLowerCase() === q);
        if (exact.length) {
          exact.sort(
            (a, b) =>
              PROVIDER_PREF.indexOf(a.provider) - PROVIDER_PREF.indexOf(b.provider),
          );
          return exact[0]!.qualified;
        }
        const starts = pool.filter((s) => s.ticker.toLowerCase().startsWith(q));
        if (starts.length === 1) return starts[0]!.qualified;
        return `hyperliquid:${symbol.toUpperCase()}`;
      };

      const hideSuggest = () => {
        suggestEl.hidden = true;
        suggestEl.replaceChildren();
        suggestIdx = -1;
      };

      const paintSuggest = (query: string) => {
        const q = query.trim().toLowerCase();
        if (q.length < 1) {
          hideSuggest();
          return;
        }
        const pool = poolSymbols();
        const scored = pool
          .map((s) => {
            const tick = s.ticker.toLowerCase();
            const desc = (s.description || '').toLowerCase();
            const qual = s.qualified.toLowerCase();
            let score = 999;
            if (tick === q || qual === q) score = 0;
            else if (tick.startsWith(q)) score = 1;
            else if (qual.includes(q)) score = 2;
            else if (desc.includes(q)) score = 3;
            else return null;
            const pref = PROVIDER_PREF.indexOf(s.provider);
            return { s, score, pref: pref < 0 ? 99 : pref };
          })
          .filter((x): x is { s: SuggestHit; score: number; pref: number } => x != null)
          .sort((a, b) => a.score - b.score || a.pref - b.pref || a.s.ticker.localeCompare(b.s.ticker))
          .slice(0, 12)
          .map((x) => x.s);

        if (!scored.length) {
          hideSuggest();
          return;
        }

        suggestEl.replaceChildren();
        scored.forEach((hit, i) => {
          const li = document.createElement('li');
          li.className = 'desk-watch__suggest-item';
          li.role = 'option';
          li.dataset.qualified = hit.qualified;
          li.dataset.idx = String(i);
          li.innerHTML = `
            <span class="desk-watch__suggest-tick">${escapeAttr(hit.ticker)}</span>
            <span class="desk-watch__suggest-ex">${escapeAttr(hit.provider)}</span>
            <span class="desk-watch__suggest-desc">${escapeAttr(hit.description || '')}</span>
          `;
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            tryAddSymbol(hit.qualified);
            hideSuggest();
          });
          suggestEl.appendChild(li);
        });
        suggestIdx = 0;
        suggestEl.querySelectorAll('.desk-watch__suggest-item').forEach((el, i) => {
          (el as HTMLElement).dataset.active = i === 0 ? 'true' : 'false';
        });
        suggestEl.hidden = false;
      };

      const toast: CtxToast = (m, k) => ctx.toast(m, k);

      const paintFresh = () => {
        if (!desk) {
          freshEl.textContent = 'desk offline';
          freshEl.dataset.stale = '1';
          return;
        }
        freshEl.textContent = `levels ${deskAgeLabel(desk.at)}`;
        freshEl.dataset.stale = isDeskStale(desk.at) ? '1' : '0';
        freshEl.title = desk.at;
      };

      const paintQuote = (symbol: string, q: Quote) => {
        quoteCache.set(symbol, q);
        const li = rows.get(symbol);
        if (!li) return;
        const item = getWatchlist().find((w) => w.symbol === symbol);
        if (!item) return;
        const priceEl = li.querySelector('.desk-watch__price') as HTMLElement;
        const chgEl = li.querySelector('.desk-watch__chg') as HTMLElement;
        priceEl.textContent = formatPrice(q.price);
        const sign = q.changePct > 0 ? '+' : '';
        chgEl.textContent = `${sign}${q.changePct.toFixed(2)}%`;
        chgEl.dataset.dir = q.changePct >= 0 ? 'up' : 'down';
        applyDeskHint(li, item, desk, q.price);
      };

      const applyDeskHint = (
        li: HTMLElement,
        item: WatchItem,
        d: DeskLatest | null,
        lastPx?: number,
      ) => {
        const badgeEl = li.querySelector('.desk-watch__badge') as HTMLElement;
        const hintEl = li.querySelector('.desk-watch__hint') as HTMLElement;
        const m = d ? marketForSymbol(d, item.symbol) : null;
        if (!m) {
          badgeEl.textContent = '—';
          badgeEl.dataset.kind = 'none';
          hintEl.textContent = item.hint;
          return;
        }
        const status = deskStatusFor(m, lastPx);
        badgeEl.textContent = status.badge;
        badgeEl.dataset.kind = status.kind;
        hintEl.textContent = status.hint;
      };

      const refreshDesk = async (force = false) => {
        desk = await loadDeskLatest(force);
        paintFresh();
        for (const item of getWatchlist()) {
          const li = rows.get(item.symbol);
          if (!li) continue;
          applyDeskHint(li, item, desk, quoteCache.get(item.symbol)?.price);
        }
      };

      const syncActive = () => {
        const active = ctx.symbol;
        for (const [sym, li] of rows) {
          li.dataset.active = sym === active ? 'true' : 'false';
        }
      };

      const paintSortHeaders = () => {
        const sort = getSort();
        body.querySelectorAll('.desk-watch__col').forEach((btn) => {
          const el = btn as HTMLElement;
          const key = el.dataset.sort;
          el.dataset.active = 'false';
          el.dataset.dir = '';
          if (key === 'manual' && sort === 'manual') el.dataset.active = 'true';
          if (key === 'last' && (sort === 'last' || sort === 'last-desc')) {
            el.dataset.active = 'true';
            el.dataset.dir = sort === 'last' ? 'asc' : 'desc';
          }
          if (key === 'chg' && (sort === 'chg' || sort === 'chg-desc')) {
            el.dataset.active = 'true';
            el.dataset.dir = sort === 'chg' ? 'asc' : 'desc';
          }
        });
      };

      const showContextMenu = (x: number, y: number, entry: WatchEntry, index: number) => {
        closeMenus(body);
        const menu = document.createElement('div');
        menu.className = 'desk-watch__ctx';
        menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
        menu.style.top = `${Math.min(y, window.innerHeight - 240)}px`;

        const items: { label: string; act: string; danger?: boolean }[] = isSection(entry)
          ? [
              { label: 'Rename section', act: 'rename-sec' },
              { label: 'Remove section', act: 'remove-sec', danger: true },
            ]
          : [
              { label: 'Add section above', act: 'section' },
              { label: 'Rename…', act: 'edit' },
              { label: 'Remove', act: 'remove', danger: true },
            ];

        menu.innerHTML = items
          .map(
            (i) =>
              `<button type="button" class="desk-watch__ctx-item${i.danger ? ' is-danger' : ''}" data-act="${i.act}">${i.label}</button>`,
          )
          .join('');

        const onDoc = (ev: MouseEvent) => {
          if (!menu.contains(ev.target as Node)) {
            menu.remove();
            document.removeEventListener('mousedown', onDoc, true);
          }
        };
        document.addEventListener('mousedown', onDoc, true);

        menu.addEventListener('click', (e) => {
          const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
          menu.remove();
          document.removeEventListener('mousedown', onDoc, true);
          if (!act) return;
          void handleCtx(act, entry, index);
        });
        document.body.appendChild(menu);
      };

      const handleCtx = async (act: string, entry: WatchEntry, _index: number) => {
        if (act === 'section' && isSymbol(entry)) {
          const title = prompt('Section name', 'Section');
          if (title == null) return;
          addSection(title || 'Section', entry.symbol);
          return;
        }
        if (act === 'rename-sec' && isSection(entry)) {
          const title = prompt('Section name', entry.title);
          if (title == null) return;
          renameSection(entry.id, title);
          return;
        }
        if (act === 'remove-sec' && isSection(entry)) {
          removeSection(entry.id);
          return;
        }
        if (act === 'remove' && isSymbol(entry)) {
          if (getWatchlist().length <= 1) {
            toast('Keep at least one symbol', 'error');
            return;
          }
          removeWatchItem(entry.symbol);
          toast(`Removed ${entry.label}`, 'info');
          return;
        }
        if (act === 'edit' && isSymbol(entry)) {
          const result = await openPrompt(ctx.host, 'Edit symbol', [
            { name: 'symbol', label: 'Symbol', value: entry.symbol },
            { name: 'label', label: 'Label', value: entry.label, max: 24 },
            { name: 'hint', label: 'Description', value: entry.hint, max: 80 },
          ]);
          if (!result) return;
          const updated = updateWatchItem(entry.symbol, result);
          if (!updated) toast('Could not save — symbol may already exist', 'error');
          else toast(`Updated ${updated.label}`, 'success');
        }
      };

      const buildSymbolRow = (item: WatchItem, index: number): HTMLLIElement => {
        const li = document.createElement('li');
        li.className = 'desk-watch__row';
        li.role = 'option';
        li.draggable = getSort() === 'manual';
        li.dataset.symbol = item.symbol;
        li.dataset.index = String(index);
        li.tabIndex = 0;
        const cached = quoteCache.get(item.symbol);
        li.innerHTML = `
          <div class="desk-watch__sym">
            <span class="desk-watch__label-row">
              <span class="desk-watch__label">${escapeAttr(item.label)}</span>
              <span class="desk-watch__badge" data-kind="none">—</span>
            </span>
            <span class="desk-watch__hint">${escapeAttr(item.hint)}</span>
          </div>
          <span class="desk-watch__price">${cached ? formatPrice(cached.price) : '—'}</span>
          <span class="desk-watch__chg">${
            cached ? `${cached.changePct > 0 ? '+' : ''}${cached.changePct.toFixed(2)}%` : '—'
          }</span>
          <button type="button" class="desk-watch__remove" title="Remove" aria-label="Remove">×</button>
        `;
        if (cached) {
          (li.querySelector('.desk-watch__chg') as HTMLElement).dataset.dir =
            cached.changePct >= 0 ? 'up' : 'down';
        }
        applyDeskHint(li, item, desk, cached?.price);

        const select = () => {
          for (const row of rows.values()) row.dataset.active = 'false';
          li.dataset.active = 'true';
          ctx.setSymbol(item.symbol);
        };
        li.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('.desk-watch__remove')) return;
          select();
        });
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select();
          }
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (getWatchlist().length > 1) removeWatchItem(item.symbol);
          }
        });
        li.querySelector('.desk-watch__remove')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (getWatchlist().length <= 1) {
            toast('Keep at least one symbol', 'error');
            return;
          }
          removeWatchItem(item.symbol);
        });
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, item, index);
        });

        li.addEventListener('dragstart', (e) => {
          dragFrom = index;
          li.classList.add('is-dragging');
          e.dataTransfer?.setData('text/plain', String(index));
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        li.addEventListener('dragend', () => {
          li.classList.remove('is-dragging');
          dragFrom = -1;
          list.querySelectorAll('.is-drop').forEach((el) => el.classList.remove('is-drop'));
        });
        li.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (getSort() !== 'manual') return;
          li.classList.add('is-drop');
        });
        li.addEventListener('dragleave', () => li.classList.remove('is-drop'));
        li.addEventListener('drop', (e) => {
          e.preventDefault();
          li.classList.remove('is-drop');
          const to = Number(li.dataset.index);
          if (dragFrom >= 0 && Number.isFinite(to)) reorderEntries(dragFrom, to);
        });

        return li;
      };

      const buildSectionRow = (sec: { id: string; title: string }, index: number): HTMLLIElement => {
        const li = document.createElement('li');
        li.className = 'desk-watch__section';
        li.draggable = getSort() === 'manual';
        li.dataset.index = String(index);
        li.dataset.section = sec.id;
        li.innerHTML = `<span class="desk-watch__section-title">${escapeAttr(sec.title)}</span>`;
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, { kind: 'section', id: sec.id, title: sec.title }, index);
        });
        li.addEventListener('dblclick', () => {
          const title = prompt('Section name', sec.title);
          if (title != null) renameSection(sec.id, title);
        });
        li.addEventListener('dragstart', (e) => {
          dragFrom = index;
          e.dataTransfer?.setData('text/plain', String(index));
        });
        li.addEventListener('dragover', (e) => e.preventDefault());
        li.addEventListener('drop', (e) => {
          e.preventDefault();
          const to = Number(li.dataset.index);
          if (dragFrom >= 0 && Number.isFinite(to)) reorderEntries(dragFrom, to);
        });
        return li;
      };

      const renderList = () => {
        listNameEl.textContent = getActiveListName();
        paintSortHeaders();
        const doc = getActiveList();
        const ordered = sortedEntries(doc.entries, getSort());
        list.replaceChildren();
        rows.clear();
        for (const { entry, index } of ordered) {
          if (isSection(entry)) {
            list.appendChild(buildSectionRow(entry, index));
          } else {
            const li = buildSymbolRow(entry, index);
            list.appendChild(li);
            rows.set(entry.symbol, li);
          }
        }
        syncActive();
        syncHlQuotes();
      };

      const refreshLbankQuote = async () => {
        const items = getWatchlist().filter((w) => w.quote === 'lbank');
        if (!items.length) return;
        await Promise.all(
          items.map(async (w) => {
            const q = await fetchLbankQuote(w.symbol);
            if (q) paintQuote(w.symbol, q);
          }),
        );
      };

      const openListMenu = () => {
        closeMenus(body);
        const btn = body.querySelector('[data-act="list-menu"]') as HTMLElement;
        const rect = btn.getBoundingClientRect();
        const menu = document.createElement('div');
        menu.className = 'desk-watch__menu';
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 4}px`;

        const lists = getLists();
        const activeId = getActiveListId();
        const listRows = lists
          .map(
            (l) => `
          <button type="button" class="desk-watch__menu-item${l.id === activeId ? ' is-active' : ''}" data-act="switch" data-id="${escapeAttr(l.id)}">
            <span>${escapeAttr(l.name)}</span>
            <span class="desk-watch__menu-count">${l.entries.filter(isSymbol).length}</span>
          </button>`,
          )
          .join('');

        menu.innerHTML = `
          <div class="desk-watch__menu-section">${listRows}</div>
          <div class="desk-watch__menu-sep"></div>
          <button type="button" class="desk-watch__menu-item" data-act="create">Create new list…</button>
          <button type="button" class="desk-watch__menu-item" data-act="rename">Rename…</button>
          <button type="button" class="desk-watch__menu-item" data-act="copy">Make a copy…</button>
          <button type="button" class="desk-watch__menu-item" data-act="section">Add section</button>
          <button type="button" class="desk-watch__menu-item" data-act="clear">Clear list</button>
          <button type="button" class="desk-watch__menu-item" data-act="reset">Reset to defaults</button>
          <div class="desk-watch__menu-sep"></div>
          <button type="button" class="desk-watch__menu-item" data-act="import">Import list…</button>
          <button type="button" class="desk-watch__menu-item" data-act="export">Export list…</button>
          <button type="button" class="desk-watch__menu-item is-danger" data-act="delete">Delete list</button>
        `;

        const onDoc = (ev: MouseEvent) => {
          if (!menu.contains(ev.target as Node) && ev.target !== btn) {
            menu.remove();
            document.removeEventListener('mousedown', onDoc, true);
          }
        };
        document.addEventListener('mousedown', onDoc, true);

        menu.addEventListener('click', (e) => {
          const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
          if (!t) return;
          const act = t.dataset.act!;
          menu.remove();
          document.removeEventListener('mousedown', onDoc, true);
          void handleListMenu(act, t.dataset.id);
        });
        document.body.appendChild(menu);
      };

      const handleListMenu = async (act: string, id?: string) => {
        if (act === 'switch' && id) {
          setActiveList(id);
          return;
        }
        if (act === 'create') {
          const name = prompt('New list name', 'Watchlist');
          if (name == null) return;
          createList(name || 'Watchlist', false);
          toast('List created', 'success');
          return;
        }
        if (act === 'rename') {
          const name = prompt('Rename list', getActiveListName());
          if (name == null) return;
          renameList(getActiveListId(), name);
          return;
        }
        if (act === 'copy') {
          const name = prompt('Copy name', `${getActiveListName()} copy`);
          if (name == null) return;
          createList(name || 'Watchlist copy', true);
          toast('List copied', 'success');
          return;
        }
        if (act === 'section') {
          const title = prompt('Section name', 'Section');
          if (title == null) return;
          addSection(title || 'Section');
          return;
        }
        if (act === 'clear') {
          if (!confirm('Clear all symbols from this list?')) return;
          clearActiveList();
          return;
        }
        if (act === 'reset') {
          if (!confirm('Replace this list with desk defaults?')) return;
          resetWatchlist();
          toast('Reset to defaults', 'success');
          return;
        }
        if (act === 'export') {
          const txt = exportActiveListTxt();
          const blob = new Blob([txt], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${getActiveListName().replace(/\s+/g, '_')}.txt`;
          a.click();
          URL.revokeObjectURL(a.href);
          toast('Exported', 'success');
          return;
        }
        if (act === 'import') {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.txt,text/plain';
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            const text = await file.text();
            const n = importActiveListTxt(text);
            toast(`Imported ${n} symbols`, 'success');
          };
          input.click();
          return;
        }
        if (act === 'delete') {
          if (getLists().length <= 1) {
            toast('Keep at least one list', 'error');
            return;
          }
          if (!confirm(`Delete “${getActiveListName()}”?`)) return;
          deleteList(getActiveListId());
          toast('List deleted', 'info');
        }
      };

      const tryAddSymbol = (raw: string) => {
        const qualified = resolveAddSymbol(raw);
        if (!qualified) return;
        const added = addWatchItem(qualified);
        if (added) {
          toast(`Added ${added.label}`, 'success');
          addInput.value = '';
          hideSuggest();
          ctx.setSymbol(added.symbol);
        } else {
          toast('Already on watchlist', 'info');
        }
      };

      body.querySelector('[data-act="list-menu"]')?.addEventListener('click', openListMenu);
      body.querySelector('[data-act="search"]')?.addEventListener('click', () => {
        addMode = false;
        ctx.openSymbolSearch();
      });
      body.querySelector('[data-act="add"]')?.addEventListener('click', () => {
        addMode = true;
        toast('Pick a symbol to add', 'info');
        ctx.openSymbolSearch();
      });

      body.querySelectorAll('.desk-watch__col').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = (btn as HTMLElement).dataset.sort;
          const cur = getSort();
          if (key === 'manual') {
            setSort('manual');
            return;
          }
          if (key === 'last') {
            setSort(cur === 'last' ? 'last-desc' : cur === 'last-desc' ? 'manual' : 'last');
            return;
          }
          if (key === 'chg') {
            setSort(cur === 'chg' ? 'chg-desc' : cur === 'chg-desc' ? 'manual' : 'chg');
          }
        });
      });

      addInput.addEventListener('input', () => paintSuggest(addInput.value));
      addInput.addEventListener('focus', () => paintSuggest(addInput.value));
      addInput.addEventListener('blur', () => {
        // Delay so mousedown on a suggestion can fire first
        window.setTimeout(() => hideSuggest(), 150);
      });
      addInput.addEventListener('keydown', (e) => {
        const items = [...suggestEl.querySelectorAll<HTMLElement>('.desk-watch__suggest-item')];
        if (e.key === 'ArrowDown' && items.length) {
          e.preventDefault();
          suggestIdx = Math.min(items.length - 1, suggestIdx + 1);
          items.forEach((el, i) => {
            el.dataset.active = i === suggestIdx ? 'true' : 'false';
          });
          return;
        }
        if (e.key === 'ArrowUp' && items.length) {
          e.preventDefault();
          suggestIdx = Math.max(0, suggestIdx - 1);
          items.forEach((el, i) => {
            el.dataset.active = i === suggestIdx ? 'true' : 'false';
          });
          return;
        }
        if (e.key === 'Escape') {
          hideSuggest();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const pick =
            suggestIdx >= 0 && items[suggestIdx]
              ? items[suggestIdx]!.dataset.qualified
              : undefined;
          tryAddSymbol(pick || addInput.value);
        }
      });

      // Alt+W — add chart symbol (TradingView shortcut)
      const onKey = (e: KeyboardEvent) => {
        if (!(e.altKey && (e.key === 'w' || e.key === 'W'))) return;
        if ((e.target as HTMLElement)?.closest('input, textarea')) return;
        e.preventDefault();
        const sym = ctx.symbol;
        if (!sym) return;
        const added = addWatchItem(sym);
        toast(added ? `Added ${added.label}` : 'Already on watchlist', added ? 'success' : 'info');
      };
      window.addEventListener('keydown', onKey);

      renderList();

      const unsubStore = onWatchlistChange(() => {
        renderList();
        void refreshDesk(false);
        void refreshLbankQuote();
      });

      return {
        onChart: (chart) => {
          unsubMarket?.();
          syncActive();
          unsubMarket = chart.on('market:changed', () => {
            syncActive();
            if (!addMode) return;
            const sym = chart.market.symbol;
            if (!sym) return;
            addMode = false;
            const added = addWatchItem(sym);
            toast(
              added ? `Added ${added.label}` : 'Already on watchlist',
              added ? 'success' : 'info',
            );
          });
        },
        onOpen: () => {
          void refreshDesk(true);
          void refreshLbankQuote();
          unsubQuotes?.();
          unsubQuotes = onHlQuotes((map) => {
            for (const [symbol, q] of map) {
              paintQuote(symbol, { price: q.price, changePct: q.changePct });
            }
            // Re-apply sort when quotes update price columns
            if (getSort() !== 'manual') renderList();
          });
          if (!deskTimer) deskTimer = setInterval(() => void refreshDesk(true), 30_000);
          if (!lbankTimer) lbankTimer = setInterval(() => void refreshLbankQuote(), 2_000);
        },
        destroy: () => {
          unsubMarket?.();
          unsubQuotes?.();
          unsubStore();
          window.removeEventListener('keydown', onKey);
          closeMenus(body);
          if (deskTimer) clearInterval(deskTimer);
          if (lbankTimer) clearInterval(lbankTimer);
        },
      };
    },
  });

  registerWidgetAttachment({
    id: 'desk.boot-watchlist',
    mount: (ctx) => {
      const mq = window.matchMedia('(max-width: 720px)');
      const apply = () => {
        const open = ctx.panels.openId();
        if (mq.matches) {
          if (open === 'desk.watchlist') ctx.togglePanel('desk.watchlist', false);
          return;
        }
        if (!open) ctx.togglePanel('desk.watchlist', true);
      };
      requestAnimationFrame(apply);
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    },
  });
}
