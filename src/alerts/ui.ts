/**
 * Alerts UI, TradingView style: the "Create alert" dialog (Alt+A, top-bar Alert button,
 * right-click "Add alert at …" on the chart or price scale), alert lines on the chart,
 * and the Alerts side panel with the alert list and the log.
 */
import type { NativeIndicator, NativeIndicatorContext, PriceLine, DrawingLabel } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { registerIcon, registerNativeIndicator, registerSidePanel, registerWidgetAction } from '@luxalgo/vela/plugin';
import './alerts.css';
import { fmtPrice } from '../trading/paper-store';
import { getWatchlist } from '../lib/watchlist-store';
import {
  CONDITION_LABEL,
  TRIGGER_LABEL,
  alertsFor,
  askDesktopPermission,
  clearAlertLog,
  defaultMessage,
  displaySymbol,
  getAlertLog,
  getAlerts,
  logScriptAlert,
  lastSeenPrice,
  onAlertsChange,
  removeAlert,
  removeAllAlerts,
  setAlertActive,
  setAlertChartOpener,
  startAlertEngine,
  upsertAlert,
  type AlertCondition,
  type AlertTrigger,
  type PriceAlert,
} from './engine';

export const ALERTS_INDICATOR_TYPE = 'desk.alerts';
const LINE = '#f7c548';

registerIcon(
  'desk-alert',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1.2 1.3H2.8z"/><path d="M6.6 14a1.5 1.5 0 0 0 2.8 0"/></svg>',
);

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let wsRef: VelaWorkspace | null = null;

/** Round a cursor price to something readable for the symbol's magnitude. */
function roundPrice(p: number): number {
  const d = p >= 1000 ? 2 : p >= 1 ? 4 : 6;
  return Number(p.toFixed(d));
}

// ── Chart lines ───────────────────────────────────────────────────────────

class AlertLines implements NativeIndicator {
  private ctx: NativeIndicatorContext | null = null;
  private off: (() => void) | null = null;
  private key = '';

  start(ctx: NativeIndicatorContext): void {
    this.ctx = ctx;
    this.off = onAlertsChange(() => this.paint());
    this.paint();
  }
  onBars(): void {
    this.paint();
  }
  onViewport(): void {}
  setInputs(): void {
    this.paint();
  }
  suspend(): void {
    this.off?.();
    this.off = null;
  }
  resume(): void {
    this.off ??= onAlertsChange(() => this.paint());
    this.paint();
  }
  stop(): void {
    this.off?.();
    this.off = null;
    this.ctx = null;
  }

  private paint(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const list = alertsFor(ctx.symbol).filter((a) => a.active);
    const bars = ctx.bars();
    const last = bars[bars.length - 1]?.time;
    const key = JSON.stringify(list.map((a) => [a.id, a.price, a.condition])) + last;
    if (key === this.key) return;
    this.key = key;
    const priceLines: PriceLine[] = list.map((a) => ({
      id: `alert-${a.id}`,
      paneId: '',
      price: a.price,
      color: LINE,
      lineStyle: 'dashed',
      width: 1,
      title: '',
    }));
    const labels: DrawingLabel[] =
      last == null
        ? []
        : list.map((a) => ({
            id: `alert-tag-${a.id}`,
            paneId: '',
            xloc: 'bar_time',
            x: last,
            y: a.price,
            yloc: 'price',
            text: `🔔 ${CONDITION_LABEL[a.condition]} ${fmtPrice(a.price)}`,
            style: 'label_right',
            color: LINE,
            textColor: '#131722',
            size: 'small',
            textAlign: 'right',
            fontFamily: 'default',
            bold: false,
          }));
    ctx.emit({ priceLines, labels });
    ctx.setStatus('live');
  }
}

export function ensureAlertLines(ws: VelaWorkspace): void {
  try {
    if (!ws.chart.presentNativeIndicators().includes(ALERTS_INDICATOR_TYPE)) ws.chart.addNativeIndicator(ALERTS_INDICATOR_TYPE);
  } catch (err) {
    console.warn('[alerts]', err);
  }
}

// ── Dialog ────────────────────────────────────────────────────────────────

const EXPIRY: Array<[string, number | null]> = [
  ['Open-ended', null],
  ['1 hour', 3600_000],
  ['1 day', 86400_000],
  ['1 week', 7 * 86400_000],
  ['1 month', 30 * 86400_000],
];

export function openAlertDialog(opts: { symbol?: string; price?: number; edit?: PriceAlert } = {}): void {
  document.querySelector('.desk-adlg')?.remove();
  const edit = opts.edit;
  const symbol = edit?.symbol ?? opts.symbol ?? wsRef?.chart.market.symbol ?? '';
  if (!symbol) return;
  const last = lastSeenPrice(symbol);
  const price = edit?.price ?? (opts.price != null ? roundPrice(opts.price) : last != null ? roundPrice(last) : undefined);
  // TradingView defaults to "Crossing"; at-cursor alerts read better as up/down.
  const condition: AlertCondition = edit?.condition ?? 'crossing';
  const symbols = [...new Set([symbol, ...getWatchlist().map((w) => w.symbol)])];

  const wrap = document.createElement('div');
  wrap.className = 'desk-adlg';
  wrap.innerHTML = `
    <form class="desk-adlg__dialog" role="dialog" aria-label="${edit ? 'Edit alert' : 'Create alert'}">
      <div class="desk-adlg__head"><b>${edit ? 'Edit alert' : 'Create alert'} on ${esc(displaySymbol(symbol))}</b><button type="button" data-x aria-label="Close">✕</button></div>
      <div class="desk-adlg__body">
        <label>Symbol<select name="symbol">${symbols.map((s) => `<option value="${esc(s)}"${s === symbol ? ' selected' : ''}>${esc(displaySymbol(s))} · ${esc(s.split(':')[0] ?? '')}</option>`).join('')}</select></label>
        <label>Condition<select name="condition">${(Object.keys(CONDITION_LABEL) as AlertCondition[])
          .map((c) => `<option value="${c}"${c === condition ? ' selected' : ''}>${CONDITION_LABEL[c]}</option>`)
          .join('')}</select></label>
        <label>Value<input name="price" type="number" step="any" min="0" required value="${price ?? ''}"><small data-last>${last != null ? `Last ${esc(fmtPrice(last))}` : ''}</small></label>
        <label>Trigger<select name="trigger">${(Object.keys(TRIGGER_LABEL) as AlertTrigger[])
          .map((t) => `<option value="${t}"${t === (edit?.trigger ?? 'once') ? ' selected' : ''}>${TRIGGER_LABEL[t]}</option>`)
          .join('')}</select></label>
        <label>Expiration<select name="expiry">${EXPIRY.map(([l], i) => `<option value="${i}"${(edit ? (edit.expiresAt == null ? 0 : -1) : 0) === i ? ' selected' : ''}>${l}</option>`).join('')}${
          edit?.expiresAt != null ? `<option value="keep" selected>${new Date(edit.expiresAt).toLocaleString([], { hourCycle: 'h23' })}</option>` : ''
        }</select></label>
        <label>Message<textarea name="message" rows="2"></textarea></label>
        <div class="desk-adlg__checks">
          <label><input type="checkbox" name="sound"${edit ? (edit.sound ? ' checked' : '') : ' checked'}> Play sound</label>
          <label><input type="checkbox" name="desktop"${edit?.desktop ? ' checked' : ''}> Desktop notification</label>
        </div>
      </div>
      <div class="desk-adlg__foot"><button type="button" data-x>Cancel</button><button type="submit" class="is-primary">${edit ? 'Save' : 'Create'}</button></div>
    </form>`;
  document.body.appendChild(wrap);
  const form = wrap.querySelector<HTMLFormElement>('form')!;
  const msg = form.elements.namedItem('message') as HTMLTextAreaElement;
  const field = <T extends HTMLElement>(n: string): T => form.elements.namedItem(n) as T;
  let msgTouched = !!edit && edit.message !== defaultMessage(edit);
  const syncMsg = (): void => {
    if (msgTouched) return;
    const p = Number(field<HTMLInputElement>('price').value);
    msg.value = defaultMessage({
      symbol: field<HTMLSelectElement>('symbol').value,
      condition: field<HTMLSelectElement>('condition').value as AlertCondition,
      price: p > 0 ? p : 0,
    });
  };
  msg.value = edit?.message ?? '';
  if (!msgTouched) syncMsg();
  msg.addEventListener('input', () => (msgTouched = true));
  form.addEventListener('input', (e) => {
    if (e.target !== msg) syncMsg();
    if ((e.target as HTMLElement).getAttribute('name') === 'symbol') {
      const l = lastSeenPrice(field<HTMLSelectElement>('symbol').value);
      form.querySelector('[data-last]')!.textContent = l != null ? `Last ${fmtPrice(l)}` : '';
    }
  });
  field<HTMLInputElement>('desktop').addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).checked) void askDesktopPermission();
  });

  const close = (): void => {
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
    // Keep chart shortcuts (letters open symbol search) out of the form.
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) close();
  });
  form.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-x]')) close();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = Number(field<HTMLInputElement>('price').value);
    if (!(p > 0)) return;
    const exp = field<HTMLSelectElement>('expiry').value;
    const expiresAt = exp === 'keep' ? (edit?.expiresAt ?? null) : EXPIRY[Number(exp)]?.[1] != null ? Date.now() + EXPIRY[Number(exp)]![1]! : null;
    const saved = upsertAlert({
      id: edit?.id,
      symbol: field<HTMLSelectElement>('symbol').value,
      condition: field<HTMLSelectElement>('condition').value as AlertCondition,
      price: p,
      trigger: field<HTMLSelectElement>('trigger').value as AlertTrigger,
      expiresAt,
      message: msg.value.trim() || defaultMessage({ symbol, condition, price: p }),
      sound: field<HTMLInputElement>('sound').checked,
      desktop: field<HTMLInputElement>('desktop').checked,
    });
    close();
    if (wsRef) {
      ensureAlertLines(wsRef);
      wsRef.toast(`Alert ${edit ? 'saved' : 'created'}: ${saved.message}`, 'success');
    }
  });
  field<HTMLInputElement>('price').focus();
  field<HTMLInputElement>('price').select();
}

// ── Side panel ────────────────────────────────────────────────────────────

function statusOf(a: PriceAlert): { text: string; cls: string } {
  if (a.active) return { text: 'Active', cls: 'is-active' };
  if (a.stopped === 'triggered') return { text: 'Triggered', cls: 'is-triggered' };
  if (a.stopped === 'expired') return { text: 'Expired', cls: 'is-stopped' };
  return { text: 'Stopped', cls: 'is-stopped' };
}

function registerAlertsPanel(): void {
  registerSidePanel({
    id: 'desk.alerts',
    title: 'Alerts',
    icon: 'desk-alert',
    order: 6,
    width: 320,
    resizable: true,
    minWidth: 260,
    maxWidth: 520,
    placement: 'column',
    mount: (ctx, body) => {
      let tab: 'alerts' | 'log' = 'alerts';
      body.className = 'desk-panel desk-alp';
      body.innerHTML = `
        <div class="desk-alp__tabs">
          <button type="button" data-tab="alerts">Alerts</button>
          <button type="button" data-tab="log">Log</button>
          <span class="desk-alp__spacer"></span>
          <button type="button" class="desk-alp__icon" data-act="add" title="Create alert (Alt+A)" aria-label="Create alert">+</button>
          <button type="button" class="desk-alp__icon" data-act="clear" title="" aria-label="Clear"></button>
        </div>
        <div class="desk-alp__list" data-list></div>`;
      const list = body.querySelector<HTMLElement>('[data-list]')!;
      const clearBtn = body.querySelector<HTMLButtonElement>('[data-act="clear"]')!;

      const render = (): void => {
        for (const b of body.querySelectorAll<HTMLElement>('[data-tab]')) b.classList.toggle('is-active', b.dataset.tab === tab);
        if (tab === 'alerts') {
          clearBtn.textContent = '⌫';
          clearBtn.title = 'Remove stopped alerts';
          const rows = [...getAlerts()].sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt - a.createdAt);
          list.innerHTML = rows.length
            ? rows
                .map((a) => {
                  const st = statusOf(a);
                  return `<div class="desk-alp__row" data-id="${a.id}">
                    <div class="desk-alp__line1"><b>${esc(displaySymbol(a.symbol))}</b><span class="desk-alp__cond">${CONDITION_LABEL[a.condition]} ${esc(fmtPrice(a.price))}</span><span class="desk-alp__st ${st.cls}">${st.text}</span></div>
                    <div class="desk-alp__line2">${esc(a.message)}</div>
                    <div class="desk-alp__line3">${TRIGGER_LABEL[a.trigger]}${a.expiresAt ? ` · expires ${new Date(a.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}` : ''}</div>
                    <div class="desk-alp__acts">
                      <button type="button" data-toggle="${a.id}" title="${a.active ? 'Stop' : 'Restart'}">${a.active ? '⏸' : '▶'}</button>
                      <button type="button" data-edit="${a.id}" title="Edit">✎</button>
                      <button type="button" data-del="${a.id}" title="Remove">✕</button>
                    </div>
                  </div>`;
                })
                .join('')
            : `<div class="desk-alp__empty">No alerts yet.<br>Right-click the chart or press <kbd>Alt</kbd>+<kbd>A</kbd> to create one.</div>`;
        } else {
          clearBtn.textContent = '⌫';
          clearBtn.title = 'Clear log';
          const log = getAlertLog();
          list.innerHTML = log.length
            ? log
                .map(
                  (l) => `<div class="desk-alp__row is-log" data-sym="${esc(l.symbol)}">
                    <div class="desk-alp__line1"><b>${esc(displaySymbol(l.symbol))}</b><span class="desk-alp__cond">@ ${esc(fmtPrice(l.price))}</span><span class="desk-alp__time">${new Date(l.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}</span></div>
                    <div class="desk-alp__line2">${esc(l.message)}</div>
                  </div>`,
                )
                .join('')
            : '<div class="desk-alp__empty">No alerts have fired yet.</div>';
        }
      };

      body.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const tb = t.closest<HTMLElement>('[data-tab]')?.dataset.tab;
        if (tb === 'alerts' || tb === 'log') {
          tab = tb;
          render();
          return;
        }
        if (t.closest('[data-act="add"]')) return openAlertDialog({ symbol: ctx.chart.market.symbol });
        if (t.closest('[data-act="clear"]')) {
          if (tab === 'log') clearAlertLog();
          else removeAllAlerts((a) => !a.active);
          return;
        }
        const tg = t.closest<HTMLElement>('[data-toggle]')?.dataset.toggle;
        if (tg) {
          const a = getAlerts().find((x) => x.id === tg);
          if (a) setAlertActive(tg, !a.active);
          return;
        }
        const ed = t.closest<HTMLElement>('[data-edit]')?.dataset.edit;
        if (ed) {
          const a = getAlerts().find((x) => x.id === ed);
          if (a) openAlertDialog({ edit: a });
          return;
        }
        const del = t.closest<HTMLElement>('[data-del]')?.dataset.del;
        if (del) return removeAlert(del);
        const row = t.closest<HTMLElement>('[data-id], [data-sym]');
        const sym = row?.dataset.sym ?? getAlerts().find((a) => a.id === row?.dataset.id)?.symbol;
        if (sym && sym !== ctx.chart.market.symbol) ctx.setSymbol(sym);
      });

      const off = onAlertsChange(render);
      render();
      return { destroy: off };
    },
  });
}

// ── Entry points ──────────────────────────────────────────────────────────

export function registerAlerts(getWs: () => VelaWorkspace | null): void {
  registerNativeIndicator({
    type: ALERTS_INDICATOR_TYPE,
    title: 'Price alerts',
    shortTitle: 'Alerts',
    paneHint: 'price',
    overlay: true,
    legend: false,
    multiInstance: false,
    inputsSchema: () => [],
    defaultInputs: () => ({}),
    create: () => new AlertLines(),
  });
  registerAlertsPanel();

  const atPointer = (ctx: { chart: { market: { symbol?: string } }; pointer?: { price: number | null; paneKind?: string | null } | null }): void => {
    const p = ctx.pointer?.price;
    if (p == null || ctx.pointer?.paneKind === 'study') return openAlertDialog({ symbol: ctx.chart.market.symbol });
    openAlertDialog({ symbol: ctx.chart.market.symbol, price: p });
  };
  registerWidgetAction({
    id: 'desk.alert.add-here',
    target: 'context:body',
    label: 'Add alert at this price…',
    icon: 'desk-alert',
    order: -50,
    run: atPointer as never,
  });
  registerWidgetAction({
    id: 'desk.alert.add-axis',
    target: 'context:price-axis',
    label: 'Add alert at this price…',
    order: -50,
    run: atPointer as never,
  });
  registerWidgetAction({
    id: 'desk.alert.topbar',
    target: 'topbar',
    align: 'left',
    label: 'Alert',
    icon: 'desk-alert',
    order: 20,
    run: (ctx) => openAlertDialog({ symbol: ctx.chart.market.symbol }),
  });

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyA') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    openAlertDialog({ symbol: getWs()?.chart.market.symbol });
  });
}

/** After the workspace exists: engine, chart lines, chart opener. */
export function installAlerts(ws: VelaWorkspace): void {
  wsRef = ws;
  startAlertEngine();
  setAlertChartOpener((symbol) => ws.context().setSymbol(symbol));
  ensureAlertLines(ws);
  ws.chart.on('market:changed', () => ensureAlertLines(ws));
  // Pine script alerts land in the same log / popup (the built-in bell is not shown).
  const hook = (chart: VelaWorkspace['chart']): void => {
    chart.on('alert', (e) => {
      const sym = chart.market.symbol ?? '';
      logScriptAlert(sym, e.indicator ?? e.title ?? 'Script', e.message, lastSeenPrice(sym) ?? 0);
    });
  };
  for (const c of ws.cells()) hook(c.chart);
  ws.on('cell:created', ({ id }) => {
    const c = ws.cell(id)?.chart;
    if (c) hook(c);
  });
}
