/**
 * TradingView-style watchlists: multiple named lists, sections, drag order,
 * persisted in localStorage.
 */
export type WatchItem = {
  kind?: 'symbol';
  symbol: string;
  label: string;
  hint: string;
  hlCoin?: string;
  hlDex?: string;
  quote?: 'hl' | 'lbank';
};

export type WatchSection = {
  kind: 'section';
  id: string;
  title: string;
};

export type WatchEntry = WatchItem | WatchSection;

export type WatchListDoc = {
  id: string;
  name: string;
  /** Manual order (used when sort is 'manual'). */
  entries: WatchEntry[];
};

export type WatchSort = 'manual' | 'last' | 'last-desc' | 'chg' | 'chg-desc';

type StoreV2 = {
  version: 2;
  activeId: string;
  lists: WatchListDoc[];
  sort: WatchSort;
};

const LS_KEY = 'chart-desk-watchlist-v2';
const LS_KEY_V1 = 'chart-desk-watchlist-v1';

export const DEFAULT_SYMBOLS: WatchItem[] = [
  {
    symbol: 'hyperliquid:xyz:GOLD',
    label: 'GOLD',
    hint: 'Gold perp · Hyperliquid XYZ',
    hlCoin: 'xyz:GOLD',
    hlDex: 'xyz',
    quote: 'hl',
  },
  {
    symbol: 'lbank:GOLDUSDT.P',
    label: 'GOLD.P',
    hint: 'LBank last · OKX/HL history',
    quote: 'lbank',
  },
  {
    symbol: 'hyperliquid:BTC',
    label: 'BTC',
    hint: 'BTC perp · Hyperliquid',
    hlCoin: 'BTC',
    quote: 'hl',
  },
  {
    symbol: 'hyperliquid:SOL',
    label: 'SOL',
    hint: 'SOL perp · Hyperliquid',
    hlCoin: 'SOL',
    quote: 'hl',
  },
  {
    symbol: 'hyperliquid:XLM',
    label: 'XLM',
    hint: 'XLM perp · Hyperliquid',
    hlCoin: 'XLM',
    quote: 'hl',
  },
];

function uid(prefix = 'w'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneSymbols(list: WatchItem[]): WatchItem[] {
  return list.map((i) => ({ ...i, kind: 'symbol' as const }));
}

function defaultStore(): StoreV2 {
  return {
    version: 2,
    activeId: 'default',
    sort: 'manual',
    lists: [
      {
        id: 'default',
        name: 'Watchlist',
        entries: cloneSymbols(DEFAULT_SYMBOLS),
      },
    ],
  };
}

function isSection(e: WatchEntry): e is WatchSection {
  return (e as WatchSection).kind === 'section';
}

function isSymbol(e: WatchEntry): e is WatchItem {
  return !isSection(e);
}

export { isSection, isSymbol };

function normalizeItem(partial: Partial<WatchItem> & { symbol: string }): WatchItem {
  const symbol = partial.symbol.trim();
  const inferred = inferMeta(symbol);
  return {
    kind: 'symbol',
    symbol,
    label: (partial.label?.trim() || inferred.label).slice(0, 24),
    hint: (partial.hint?.trim() || inferred.hint).slice(0, 80),
    hlCoin: partial.hlCoin ?? inferred.hlCoin,
    hlDex: partial.hlDex ?? inferred.hlDex,
    quote: partial.quote ?? inferred.quote,
  };
}

export function inferMeta(symbol: string): Omit<WatchItem, 'symbol' | 'kind'> {
  const s = symbol.trim();
  const lower = s.toLowerCase();

  if (lower.startsWith('lbank:')) {
    const ticker = s.slice(s.indexOf(':') + 1);
    const short = ticker.split(/[/:]/).pop() || ticker;
    return {
      label: short.replace(/USDT\.P$/i, '.P').replace(/USDT$/i, ''),
      hint: 'LBank',
      quote: 'lbank',
    };
  }

  if (lower.startsWith('binance:')) {
    const ticker = s.slice('binance:'.length);
    const short = ticker.split(/[/:]/).pop() || ticker;
    return {
      label: short.replace(/\.P$/i, ''),
      hint: short.toUpperCase().endsWith('.P') ? 'Binance perp' : 'Binance spot',
    };
  }

  if (lower.startsWith('coinbase:')) {
    const ticker = s.slice('coinbase:'.length);
    return {
      label: ticker,
      hint: 'Coinbase',
    };
  }

  if (lower.startsWith('hyperliquid:')) {
    const rest = s.slice('hyperliquid:'.length);
    const parts = rest.split(':');
    if (parts.length >= 2) {
      const dex = parts[0]!;
      const coin = parts.slice(1).join(':');
      return {
        label: coin.split('/').pop() || coin,
        hint: `Hyperliquid ${dex.toUpperCase()}`,
        hlCoin: `${dex}:${coin}`,
        hlDex: dex,
        quote: 'hl',
      };
    }
    return {
      label: rest.split('/').pop() || rest,
      hint: 'Hyperliquid',
      hlCoin: rest,
      quote: 'hl',
    };
  }

  const bare = s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s;
  return {
    label: bare,
    hint: s.includes(':') ? s.split(':')[0]! : 'Custom',
    hlCoin: bare.includes('/') ? undefined : bare,
    quote: bare.includes('/') ? undefined : 'hl',
  };
}

function migrateV1(): StoreV2 | null {
  try {
    const raw = localStorage.getItem(LS_KEY_V1);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const entries: WatchEntry[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (typeof r.symbol !== 'string' || !r.symbol.trim()) continue;
      entries.push(normalizeItem(r as Partial<WatchItem> & { symbol: string }));
    }
    if (!entries.length) return null;
    return {
      version: 2,
      activeId: 'default',
      sort: 'manual',
      lists: [{ id: 'default', name: 'Watchlist', entries }],
    };
  } catch {
    return null;
  }
}

function loadStore(): StoreV2 {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoreV2;
      if (parsed?.version === 2 && Array.isArray(parsed.lists) && parsed.lists.length) {
        if (!parsed.lists.some((l) => l.id === parsed.activeId)) {
          parsed.activeId = parsed.lists[0]!.id;
        }
        parsed.sort = parsed.sort || 'manual';
        return parsed;
      }
    }
  } catch {
    /* fall through */
  }
  const migrated = migrateV1();
  if (migrated) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(migrated));
    } catch {
      /* ignore */
    }
    return migrated;
  }
  return defaultStore();
}

type Listener = () => void;

let store = loadStore();
const listeners = new Set<Listener>();

function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

function activeList(): WatchListDoc {
  return store.lists.find((l) => l.id === store.activeId) ?? store.lists[0]!;
}

function mutateActive(fn: (list: WatchListDoc) => void): void {
  const list = activeList();
  fn(list);
  // Sorting by price is display-only; structural edits snap back to manual
  store.sort = 'manual';
  persist();
  emit();
}

export function onWatchlistChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSort(): WatchSort {
  return store.sort;
}

export function setSort(sort: WatchSort): void {
  store.sort = sort;
  persist();
  emit();
}

export function getLists(): WatchListDoc[] {
  return store.lists.map((l) => ({
    ...l,
    entries: l.entries.map((e) => ({ ...e })),
  }));
}

export function getActiveList(): WatchListDoc {
  const l = activeList();
  return { ...l, entries: l.entries.map((e) => ({ ...e })) };
}

export function getActiveListId(): string {
  return store.activeId;
}

export function getActiveListName(): string {
  return activeList().name;
}

/** Symbol rows only (no sections) — for quotes / ranking / prefetch. */
export function getWatchlist(): WatchItem[] {
  return activeList()
    .entries.filter(isSymbol)
    .map((e) => ({ ...e }));
}

export function setActiveList(id: string): boolean {
  if (!store.lists.some((l) => l.id === id)) return false;
  store.activeId = id;
  persist();
  emit();
  return true;
}

export function createList(name: string, copyFromActive = false): WatchListDoc {
  const id = uid('list');
  const entries = copyFromActive
    ? activeList().entries.map((e) =>
        isSection(e) ? { ...e, id: uid('sec') } : { ...e },
      )
    : [];
  const doc: WatchListDoc = { id, name: name.trim() || 'New list', entries };
  store.lists.push(doc);
  store.activeId = id;
  store.sort = 'manual';
  persist();
  emit();
  return { ...doc, entries: doc.entries.map((e) => ({ ...e })) };
}

export function renameList(id: string, name: string): boolean {
  const list = store.lists.find((l) => l.id === id);
  if (!list) return false;
  list.name = name.trim() || list.name;
  persist();
  emit();
  return true;
}

export function deleteList(id: string): boolean {
  if (store.lists.length <= 1) return false;
  const idx = store.lists.findIndex((l) => l.id === id);
  if (idx < 0) return false;
  store.lists.splice(idx, 1);
  if (store.activeId === id) store.activeId = store.lists[0]!.id;
  persist();
  emit();
  return true;
}

export function clearActiveList(): void {
  mutateActive((list) => {
    list.entries = [];
  });
}

export function resetWatchlist(): void {
  const list = activeList();
  list.entries = cloneSymbols(DEFAULT_SYMBOLS);
  store.sort = 'manual';
  persist();
  emit();
}

export function addWatchItem(
  input: string | (Partial<WatchItem> & { symbol: string }),
  afterSymbol?: string,
): WatchItem | null {
  const partial =
    typeof input === 'string'
      ? ({ symbol: input } as Partial<WatchItem> & { symbol: string })
      : input;
  const item = normalizeItem(partial);
  const list = activeList();
  if (list.entries.some((e) => isSymbol(e) && e.symbol.toLowerCase() === item.symbol.toLowerCase())) {
    return null;
  }
  mutateActive((l) => {
    if (afterSymbol) {
      const i = l.entries.findIndex(
        (e) => isSymbol(e) && e.symbol.toLowerCase() === afterSymbol.toLowerCase(),
      );
      if (i >= 0) {
        l.entries.splice(i + 1, 0, item);
        return;
      }
    }
    l.entries.push(item);
  });
  return item;
}

export function removeWatchItem(symbol: string): boolean {
  const list = activeList();
  const before = list.entries.length;
  mutateActive((l) => {
    l.entries = l.entries.filter(
      (e) => !(isSymbol(e) && e.symbol.toLowerCase() === symbol.toLowerCase()),
    );
  });
  return activeList().entries.length < before;
}

export function updateWatchItem(
  symbol: string,
  patch: Partial<Pick<WatchItem, 'label' | 'hint' | 'symbol'>>,
): WatchItem | null {
  const list = activeList();
  const idx = list.entries.findIndex(
    (e) => isSymbol(e) && e.symbol.toLowerCase() === symbol.toLowerCase(),
  );
  if (idx < 0) return null;
  const cur = list.entries[idx] as WatchItem;
  let next: WatchItem;
  if (patch.symbol && patch.symbol.trim() !== cur.symbol) {
    const renamed = normalizeItem({ ...cur, ...patch, symbol: patch.symbol.trim() });
    if (
      list.entries.some(
        (e, j) =>
          j !== idx && isSymbol(e) && e.symbol.toLowerCase() === renamed.symbol.toLowerCase(),
      )
    ) {
      return null;
    }
    next = renamed;
  } else {
    next = normalizeItem({
      ...cur,
      label: patch.label ?? cur.label,
      hint: patch.hint ?? cur.hint,
    });
  }
  mutateActive((l) => {
    l.entries[idx] = next;
  });
  return next;
}

export function moveWatchItem(symbol: string, dir: -1 | 1): void {
  mutateActive((l) => {
    const idx = l.entries.findIndex(
      (e) => isSymbol(e) && e.symbol.toLowerCase() === symbol.toLowerCase(),
    );
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= l.entries.length) return;
    const [row] = l.entries.splice(idx, 1);
    l.entries.splice(j, 0, row!);
  });
}

/** Reorder by dragging entry at `fromIndex` to `toIndex`. */
export function reorderEntries(fromIndex: number, toIndex: number): void {
  mutateActive((l) => {
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= l.entries.length ||
      toIndex >= l.entries.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const [row] = l.entries.splice(fromIndex, 1);
    l.entries.splice(toIndex, 0, row!);
  });
}

export function addSection(title = 'Section', beforeSymbol?: string): WatchSection {
  const sec: WatchSection = { kind: 'section', id: uid('sec'), title };
  mutateActive((l) => {
    if (beforeSymbol) {
      const i = l.entries.findIndex(
        (e) => isSymbol(e) && e.symbol.toLowerCase() === beforeSymbol.toLowerCase(),
      );
      if (i >= 0) {
        l.entries.splice(i, 0, sec);
        return;
      }
    }
    l.entries.push(sec);
  });
  return { ...sec };
}

export function renameSection(id: string, title: string): void {
  mutateActive((l) => {
    const e = l.entries.find((x) => isSection(x) && x.id === id) as WatchSection | undefined;
    if (e) e.title = title.trim() || e.title;
  });
}

export function removeSection(id: string): void {
  mutateActive((l) => {
    l.entries = l.entries.filter((e) => !(isSection(e) && e.id === id));
  });
}

/** Export active list as TradingView-ish text (### sections, EXCHANGE:SYMBOL lines). */
export function exportActiveListTxt(): string {
  const lines: string[] = [];
  for (const e of activeList().entries) {
    if (isSection(e)) lines.push(`###${e.title}`);
    else lines.push(e.symbol);
  }
  return `${lines.join('\n')}\n`;
}

/** Import TV-style txt into the active list (replaces contents). */
export function importActiveListTxt(text: string): number {
  const entries: WatchEntry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('###')) {
      entries.push({ kind: 'section', id: uid('sec'), title: line.slice(3).trim() || 'Section' });
      continue;
    }
    const symbol = line.split(',')[0]!.trim();
    if (!symbol || seen.has(symbol.toLowerCase())) continue;
    seen.add(symbol.toLowerCase());
    entries.push(normalizeItem({ symbol }));
  }
  mutateActive((l) => {
    l.entries = entries;
  });
  return entries.filter(isSymbol).length;
}
