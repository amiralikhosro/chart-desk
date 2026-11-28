/**
 * Named chart layouts, TradingView style: the top-bar button shows the current
 * layout's name; its menu saves (Ctrl+S), saves as new, renames, loads, deletes,
 * exports and imports. A layout is a full `ws.getState()` snapshot: grid, symbols,
 * timeframes, indicators (compare lines included), drawings and chart settings.
 * Autosave keeps the current layout in step with the chart.
 */
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { registerIcon, registerWidgetAction } from '@luxalgo/vela/plugin';

registerIcon(
  'desk-layouts',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M7 6.5v7"/></svg>',
);

export type SavedLayout = { id: string; name: string; savedAt: number; state: unknown };
type Store = { v: 1; current: string | null; autosave: boolean; items: SavedLayout[] };

const LS_KEY = 'chart-desk-layouts-v1';
const ACTION_ID = 'desk.layouts';

function load(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Store>;
      if (Array.isArray(s.items)) {
        return { v: 1, current: s.current ?? null, autosave: s.autosave !== false, items: s.items };
      }
    }
  } catch {
    /* ignore */
  }
  return { v: 1, current: null, autosave: true, items: [] };
}

let store = load();
let wsRef: VelaWorkspace | null = null;

// Saved on another device: pick it up.
window.addEventListener('storage', (e) => {
  if (e.key !== LS_KEY) return;
  store = load();
  refreshButton();
});

function persist(): boolean {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
    return true;
  } catch {
    wsRef?.toast('Could not save layouts: browser storage is full', 'error');
    return false;
  }
}

const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function currentLayout(): SavedLayout | undefined {
  return store.items.find((l) => l.id === store.current);
}

export function listLayouts(): readonly SavedLayout[] {
  return store.items;
}

/** Overwrite the current layout (or create one named `name`). */
export function saveLayout(name?: string): SavedLayout | null {
  const ws = wsRef;
  if (!ws) return null;
  const state = ws.getState();
  let item = name ? undefined : currentLayout();
  if (!item) {
    item = { id: uid(), name: (name || 'My layout').trim().slice(0, 60), savedAt: Date.now(), state };
    store.items.push(item);
  } else {
    item.state = state;
    item.savedAt = Date.now();
  }
  store.current = item.id;
  if (!persist()) return null;
  refreshButton();
  return item;
}

export function loadLayout(id: string): void {
  const ws = wsRef;
  const item = store.items.find((l) => l.id === id);
  if (!ws || !item) return;
  store.current = id;
  persist();
  ws.applyState(item.state);
  refreshButton();
  ws.toast(`Loaded "${item.name}"`, 'success');
}

export function renameLayout(id: string, name: string): void {
  const item = store.items.find((l) => l.id === id);
  if (!item || !name.trim()) return;
  item.name = name.trim().slice(0, 60);
  persist();
  refreshButton();
}

export function deleteLayout(id: string): void {
  store.items = store.items.filter((l) => l.id !== id);
  if (store.current === id) store.current = null;
  persist();
  refreshButton();
}

function registerButton(): void {
  const name = currentLayout()?.name ?? 'Unsaved';
  registerWidgetAction({
    id: ACTION_ID,
    target: 'topbar',
    label: name,
    icon: 'desk-layouts',
    order: -10,
    mobile: 'menu',
    run: () => toggleMenu(),
  });
}

function refreshButton(): void {
  registerButton();
  wsRef?.refreshActions();
}

function anchorRect(): DOMRect | null {
  const btns = [...document.querySelectorAll<HTMLElement>(`[data-action-id="${ACTION_ID}"]`)];
  const visible = btns.find((b) => b.offsetParent !== null);
  return visible?.getBoundingClientRect() ?? null;
}

function fmtTime(t: number): string {
  const d = new Date(t);
  const today = d.toDateString() === new Date().toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function closeMenu(): void {
  document.querySelector('.desk-lay')?.remove();
}

function toggleMenu(focus?: 'save-as'): void {
  if (document.querySelector('.desk-lay') && !focus) return closeMenu();
  closeMenu();
  const ws = wsRef;
  if (!ws) return;
  const menu = document.createElement('div');
  menu.className = 'desk-lay';
  menu.setAttribute('role', 'menu');
  const r = anchorRect();
  menu.style.top = `${(r?.bottom ?? 40) + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - (r?.right ?? window.innerWidth - 8))}px`;
  document.body.appendChild(menu);

  let editing: { mode: 'save-as' | 'rename'; id?: string } | null = focus ? { mode: 'save-as' } : null;
  let confirmDelete: string | null = null;

  const render = (): void => {
    const cur = currentLayout();
    const items = [...store.items].sort((a, b) => b.savedAt - a.savedAt);
    const editor = (value: string, label: string): string =>
      `<form class="desk-lay__edit" data-form><input type="text" maxlength="60" value="${esc(value)}" aria-label="${label}" placeholder="Layout name"><button type="submit">${label}</button></form>`;
    menu.innerHTML = `
      <div class="desk-lay__title">${cur ? esc(cur.name) : 'Unsaved layout'}${cur ? `<span>saved ${fmtTime(cur.savedAt)}</span>` : ''}</div>
      <button type="button" class="desk-lay__item" data-act="save">Save layout<kbd>Ctrl+S</kbd></button>
      ${editing?.mode === 'save-as' ? editor(cur ? `${cur.name} copy` : 'My layout', 'Save') : '<button type="button" class="desk-lay__item" data-act="save-as">Save as new layout…</button>'}
      ${cur ? (editing?.mode === 'rename' ? editor(cur.name, 'Rename') : '<button type="button" class="desk-lay__item" data-act="rename">Rename…</button>') : ''}
      <label class="desk-lay__item desk-lay__check"><input type="checkbox" data-act="autosave" ${store.autosave ? 'checked' : ''}> Autosave</label>
      <div class="desk-lay__sep"></div>
      <div class="desk-lay__label">Saved layouts</div>
      <div class="desk-lay__list">
        ${
          items.length
            ? items
                .map(
                  (l) => `<div class="desk-lay__row${l.id === store.current ? ' is-current' : ''}">
                    <button type="button" class="desk-lay__load" data-load="${l.id}"><span>${esc(l.name)}</span><small>${fmtTime(l.savedAt)}</small></button>
                    <button type="button" class="desk-lay__del${confirmDelete === l.id ? ' is-confirm' : ''}" data-del="${l.id}" aria-label="Delete ${esc(l.name)}">${confirmDelete === l.id ? 'Delete?' : '✕'}</button>
                  </div>`,
                )
                .join('')
            : '<div class="desk-lay__empty">No saved layouts yet</div>'
        }
      </div>
      <div class="desk-lay__sep"></div>
      <button type="button" class="desk-lay__item" data-act="export">Export layout to file</button>
      <button type="button" class="desk-lay__item" data-act="import">Import layout from file…</button>`;
    const inp = menu.querySelector<HTMLInputElement>('[data-form] input');
    if (inp) {
      inp.focus();
      inp.select();
    }
  };

  menu.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = menu.querySelector<HTMLInputElement>('[data-form] input')?.value.trim() ?? '';
    if (!value || !editing) return;
    if (editing.mode === 'save-as') {
      const item = saveLayout(value);
      if (item) ws.toast(`Saved "${item.name}"`, 'success');
    } else if (editing.id) {
      renameLayout(editing.id, value);
    }
    editing = null;
    render();
  });

  menu.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.act === 'autosave') {
      store.autosave = t.checked;
      persist();
    }
  });

  menu.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'save') {
      if (!currentLayout()) {
        editing = { mode: 'save-as' };
        render();
        return;
      }
      const item = saveLayout();
      if (item) ws.toast(`Saved "${item.name}"`, 'success');
      closeMenu();
      return;
    }
    if (act === 'save-as' || act === 'rename') {
      editing = act === 'rename' ? { mode: 'rename', id: store.current ?? undefined } : { mode: 'save-as' };
      render();
      return;
    }
    if (act === 'export') {
      const cur = currentLayout();
      const doc = { app: 'chart-desk', kind: 'layout', name: cur?.name ?? 'Layout', state: ws.getState() };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
      a.download = `${(cur?.name ?? 'layout').replace(/[^\w.-]+/g, '_')}.chart-desk.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
      closeMenu();
      return;
    }
    if (act === 'import') {
      const file = document.createElement('input');
      file.type = 'file';
      file.accept = '.json,application/json';
      file.onchange = async () => {
        const f = file.files?.[0];
        if (!f) return;
        try {
          const doc = JSON.parse(await f.text()) as { name?: string; state?: unknown };
          if (!doc.state || typeof doc.state !== 'object') throw new Error('not a layout file');
          const item: SavedLayout = { id: uid(), name: String(doc.name || f.name).slice(0, 60), savedAt: Date.now(), state: doc.state };
          store.items.push(item);
          persist();
          loadLayout(item.id);
        } catch (err) {
          ws.toast(`Import failed: ${err instanceof Error ? err.message : err}`, 'error');
        }
      };
      file.click();
      closeMenu();
      return;
    }
    const loadId = t.closest<HTMLElement>('[data-load]')?.dataset.load;
    if (loadId) {
      closeMenu();
      loadLayout(loadId);
      return;
    }
    const delId = t.closest<HTMLElement>('[data-del]')?.dataset.del;
    if (delId) {
      if (confirmDelete === delId) {
        const name = store.items.find((l) => l.id === delId)?.name;
        deleteLayout(delId);
        confirmDelete = null;
        ws.toast(`Deleted "${name}"`, 'info');
      } else {
        confirmDelete = delId;
      }
      render();
    }
  });

  render();
  const outside = (e: MouseEvent): void => {
    const t = e.target as HTMLElement;
    if (menu.contains(t) || t.closest(`[data-action-id="${ACTION_ID}"]`)) return;
    closeMenu();
    document.removeEventListener('mousedown', outside, true);
  };
  document.addEventListener('mousedown', outside, true);
}

export function registerLayoutsAction(): void {
  registerButton();
}

/** Wire autosave and Ctrl+S once the workspace exists. */
export function installLayouts(ws: VelaWorkspace): void {
  wsRef = ws;
  refreshButton();
  let timer: ReturnType<typeof setTimeout> | null = null;
  ws.on('state:changed', () => {
    if (!store.autosave || !currentLayout()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveLayout();
    }, 1_500);
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!currentLayout()) {
        toggleMenu('save-as');
        return;
      }
      const item = saveLayout();
      if (item) ws.toast(`Saved "${item.name}"`, 'success');
    }
  });
}
