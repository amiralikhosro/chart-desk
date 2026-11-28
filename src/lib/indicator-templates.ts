/**
 * Indicator templates, TradingView style: save the active chart's indicators
 * (natives and Pine scripts, with their inputs, props and visibility) under a
 * name, then re-apply them to any chart, either replacing what is there or adding
 * on top. Host-owned overlays (paper positions, alert lines, compare symbols) are
 * never saved or removed: compares belong to layouts.
 */
import type { IndicatorHandle, InputValue } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { registerIcon, registerWidgetAction } from '@luxalgo/vela/plugin';
import './indicator-templates.css';

registerIcon(
  'desk-templates',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><path d="M11.5 9v5M9 11.5h5"/></svg>',
);

type Inputs = Record<string, InputValue>;

export type TemplateIndicator =
  | { kind: 'native'; type: string; title: string; inputs: Inputs; visible: boolean }
  | {
      kind: 'script';
      source: string;
      language?: string;
      title: string;
      inputs: Inputs;
      props: Inputs;
      visible: boolean;
    };

export type IndicatorTemplate = {
  id: string;
  name: string;
  savedAt: number;
  indicators: TemplateIndicator[];
};

type Store = { v: 1; replace: boolean; items: IndicatorTemplate[] };

const LS_KEY = 'chart-desk-indicator-templates-v1';
const ACTION_ID = 'desk.templates';
/** Native types the host owns: never saved into, nor removed by, a template. */
const HOST_OWNED = new Set(['desk.positions', 'desk.alerts', 'desk.compare']);

function load(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Store>;
      if (Array.isArray(s.items)) return { v: 1, replace: s.replace !== false, items: s.items };
    }
  } catch {
    /* ignore */
  }
  return { v: 1, replace: true, items: [] };
}

let store = load();
let getWsRef: () => VelaWorkspace | null = () => null;

function persist(): boolean {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
    return true;
  } catch {
    getWsRef()?.toast('Could not save templates: browser storage is full', 'error');
    return false;
  }
}

const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const isHostOwned = (h: IndicatorHandle): boolean => !!h.nativeType && HOST_OWNED.has(h.nativeType);

/** The declared name of a Pine script (`indicator("Name", …)`), for the menu summary. */
function scriptTitle(source: string): string {
  const m = /\b(?:indicator|study|strategy)\s*\(\s*(?:title\s*=\s*)?["']([^"']+)["']/.exec(source);
  return m?.[1] ?? '';
}

/** Snapshot the indicators a template can carry from one chart. */
export function captureIndicators(ws: VelaWorkspace): TemplateIndicator[] {
  const out: TemplateIndicator[] = [];
  for (const h of ws.chart.indicators()) {
    if (isHostOwned(h)) continue;
    if (h.nativeType) {
      out.push({ kind: 'native', type: h.nativeType, title: h.title, inputs: { ...h.inputValues() }, visible: h.visible });
    } else if (h.source) {
      out.push({
        kind: 'script',
        source: h.source,
        language: h.language,
        title: scriptTitle(h.source) || h.title,
        inputs: { ...h.inputValues() },
        props: { ...h.propValues() },
        visible: h.visible,
      });
    }
  }
  return out;
}

export function listTemplates(): readonly IndicatorTemplate[] {
  return store.items;
}

export function saveTemplate(name: string): IndicatorTemplate | null {
  const ws = getWsRef();
  if (!ws) return null;
  const indicators = captureIndicators(ws);
  if (!indicators.length) {
    ws.toast('No indicators on the chart to save', 'info');
    return null;
  }
  const clean = name.trim().slice(0, 60) || 'My template';
  // Same name ⇒ overwrite, like TradingView
  let item = store.items.find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (item) {
    item.indicators = indicators;
    item.savedAt = Date.now();
  } else {
    item = { id: uid(), name: clean, savedAt: Date.now(), indicators };
    store.items.push(item);
  }
  return persist() ? item : null;
}

export function renameTemplate(id: string, name: string): void {
  const item = store.items.find((t) => t.id === id);
  if (!item || !name.trim()) return;
  item.name = name.trim().slice(0, 60);
  persist();
}

export function deleteTemplate(id: string): void {
  store.items = store.items.filter((t) => t.id !== id);
  persist();
}

/**
 * Apply a template to the active chart. `replace` first removes every indicator
 * except host-owned ones (volume stays when the template carries it, so it is
 * updated in place instead of flickering out and back).
 */
export function applyTemplate(id: string, replace = store.replace): number {
  const ws = getWsRef();
  const tpl = store.items.find((t) => t.id === id);
  if (!ws || !tpl) return 0;
  const chart = ws.chart;
  const keepVolume = tpl.indicators.some((i) => i.kind === 'native' && i.type === 'volume');
  if (replace) {
    for (const h of chart.indicators()) {
      if (isHostOwned(h)) continue;
      if (keepVolume && h.nativeType === 'volume') continue;
      try {
        h.remove();
      } catch (err) {
        console.warn('[templates] remove', err);
      }
    }
  }
  let added = 0;
  for (const ind of tpl.indicators) {
    try {
      let h: IndicatorHandle;
      if (ind.kind === 'native') {
        // Layer-backed natives (volume, vpvr) are single-instance: add returns the live
        // handle, so the inputs are set on it explicitly.
        h = chart.addNativeIndicator(ind.type, { inputs: ind.inputs });
        if (Object.keys(ind.inputs).length) h.setInputs(ind.inputs);
      } else {
        h = chart.addIndicator(ind.source, {
          language: ind.language,
          inputs: ind.inputs,
          props: Object.keys(ind.props).length ? ind.props : undefined,
        });
      }
      if (!ind.visible) h.setVisible(false);
      added += 1;
    } catch (err) {
      console.warn('[templates] add', ind, err);
    }
  }
  return added;
}

function summary(t: IndicatorTemplate): string {
  return t.indicators.map((i) => i.title || (i.kind === 'native' ? i.type : 'Script')).join(', ');
}

function anchorRect(): DOMRect | null {
  const btns = [...document.querySelectorAll<HTMLElement>(`[data-action-id="${ACTION_ID}"]`)];
  const visible = btns.find((b) => b.offsetParent !== null);
  return visible?.getBoundingClientRect() ?? null;
}

let offOutside: (() => void) | null = null;

function closeMenu(): void {
  offOutside?.();
  offOutside = null;
  document.querySelector('.desk-tpl')?.remove();
}

function toggleMenu(): void {
  if (document.querySelector('.desk-tpl')) return closeMenu();
  const ws = getWsRef();
  if (!ws) return;
  const menu = document.createElement('div');
  menu.className = 'desk-tpl';
  menu.setAttribute('role', 'menu');
  const r = anchorRect();
  menu.style.top = `${(r?.bottom ?? 40) + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r?.left ?? 8, window.innerWidth - 308))}px`;
  document.body.appendChild(menu);

  let editing: { mode: 'save' | 'rename'; id?: string } | null = null;
  let confirmDelete: string | null = null;

  const render = (): void => {
    const count = ws.chart.indicators().filter((h) => !isHostOwned(h)).length;
    const items = [...store.items].sort((a, b) => a.name.localeCompare(b.name));
    const editor = (value: string, label: string): string =>
      `<form class="desk-tpl__edit" data-form><input type="text" maxlength="60" value="${esc(value)}" aria-label="Template name" placeholder="Template name"><button type="submit">${label}</button></form>`;
    menu.innerHTML = `
      <div class="desk-tpl__title">Indicator templates<span>${count} on chart</span></div>
      ${
        editing?.mode === 'save'
          ? editor('My template', 'Save')
          : `<button type="button" class="desk-tpl__item" data-act="save"${count ? '' : ' disabled'}>Save indicator template…</button>`
      }
      <label class="desk-tpl__item desk-tpl__check"><input type="checkbox" data-act="replace" ${store.replace ? 'checked' : ''}> Replace current indicators</label>
      <div class="desk-tpl__sep"></div>
      <div class="desk-tpl__label">Saved templates</div>
      <div class="desk-tpl__list">
        ${
          items.length
            ? items
                .map((t) =>
                  editing?.mode === 'rename' && editing.id === t.id
                    ? `<div class="desk-tpl__row">${editor(t.name, 'Rename')}</div>`
                    : `<div class="desk-tpl__row">
                    <button type="button" class="desk-tpl__load" data-apply="${t.id}" title="${esc(summary(t))}"><span>${esc(t.name)}</span><small>${esc(summary(t))}</small></button>
                    <button type="button" class="desk-tpl__icon" data-rename="${t.id}" aria-label="Rename ${esc(t.name)}" title="Rename">✎</button>
                    <button type="button" class="desk-tpl__icon desk-tpl__del${confirmDelete === t.id ? ' is-confirm' : ''}" data-del="${t.id}" aria-label="Delete ${esc(t.name)}" title="Delete">${confirmDelete === t.id ? 'Delete?' : '✕'}</button>
                  </div>`,
                )
                .join('')
            : '<div class="desk-tpl__empty">No saved templates yet</div>'
        }
      </div>`;
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
    if (editing.mode === 'save') {
      const item = saveTemplate(value);
      if (item) ws.toast(`Saved template "${item.name}" (${item.indicators.length})`, 'success');
    } else if (editing.id) {
      renameTemplate(editing.id, value);
    }
    editing = null;
    render();
  });

  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (editing) {
      editing = null;
      render();
    } else {
      closeMenu();
    }
  });

  menu.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.act === 'replace') {
      store.replace = t.checked;
      persist();
    }
  });

  menu.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest<HTMLElement>('[data-act]')?.dataset.act === 'save') {
      editing = { mode: 'save' };
      confirmDelete = null;
      render();
      return;
    }
    const renameId = t.closest<HTMLElement>('[data-rename]')?.dataset.rename;
    if (renameId) {
      editing = { mode: 'rename', id: renameId };
      render();
      return;
    }
    const delId = t.closest<HTMLElement>('[data-del]')?.dataset.del;
    if (delId) {
      if (confirmDelete === delId) {
        const name = store.items.find((x) => x.id === delId)?.name;
        deleteTemplate(delId);
        confirmDelete = null;
        ws.toast(`Deleted template "${name}"`, 'info');
      } else {
        confirmDelete = delId;
      }
      render();
      return;
    }
    const applyId = t.closest<HTMLElement>('[data-apply]')?.dataset.apply;
    if (applyId && e.detail < 2) {
      // Wait out a possible double-click (rename) before applying.
      window.setTimeout(() => {
        if (pendingDbl === applyId) return;
        if (!document.body.contains(menu)) return;
        const tpl = store.items.find((x) => x.id === applyId);
        const n = applyTemplate(applyId);
        closeMenu();
        if (tpl) ws.toast(`Applied "${tpl.name}" (${n} indicator${n === 1 ? '' : 's'})`, 'success');
      }, 250);
    }
  });

  let pendingDbl: string | null = null;
  menu.addEventListener('dblclick', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-apply]')?.dataset.apply;
    if (!id) return;
    pendingDbl = id;
    window.setTimeout(() => {
      pendingDbl = null;
    }, 300);
    editing = { mode: 'rename', id };
    render();
  });

  render();
  const outside = (e: MouseEvent): void => {
    const t = e.target as HTMLElement;
    if (menu.contains(t) || t.closest(`[data-action-id="${ACTION_ID}"]`)) return;
    closeMenu();
  };
  document.addEventListener('mousedown', outside, true);
  offOutside = () => document.removeEventListener('mousedown', outside, true);
}

/** Register the topbar "Templates" button; `getWs` resolves the workspace at click time. */
export function registerIndicatorTemplates(getWs: () => VelaWorkspace | null): void {
  getWsRef = getWs;
  registerWidgetAction({
    id: ACTION_ID,
    target: 'topbar',
    align: 'left',
    label: 'Templates',
    icon: 'desk-templates',
    iconOnly: true,
    order: 5,
    run: () => toggleMenu(),
  });
}
