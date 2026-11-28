/**
 * TradingView-style Paper Trading UI:
 *  - bottom Trading Panel (account summary, Positions / Orders / History tabs)
 *  - Buy / Sell buttons floating on the chart with live price
 *  - order ticket (market / limit / stop, qty, take profit, stop loss, risk readout)
 *  - right-click "Buy / Sell at this price" on the chart body
 */
import type { Vela } from '@luxalgo/vela';
import { registerIcon, registerWidgetAction, registerWidgetAttachment } from '@luxalgo/vela/plugin';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { onHlQuotes } from '../lib/hl-quotes';
import { displaySymbol } from '../desk/approvals';
import {
  cancelAllOrders,
  cancelOrder,
  closePosition,
  fmtMoney,
  fmtPrice,
  fmtSigned,
  getAccount,
  lastPrice,
  onPaperChange,
  onPrice,
  placeOrder,
  positionFor,
  resetAccount,
  reversePosition,
  setBracket,
  totals,
  unrealized,
  type OrderType,
  type Side,
} from './paper-store';

const UI_KEY = 'chart-desk-paper-ui-v1';

type UiState = { open: boolean; tab: 'positions' | 'orders' | 'history'; qty: Record<string, number> };

function loadUi(): UiState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) return { open: true, tab: 'positions', qty: {}, ...(JSON.parse(raw) as Partial<UiState>) };
  } catch {
    /* ignore */
  }
  return { open: false, tab: 'positions', qty: {} };
}

const ui = loadUi();
const saveUi = (): void => {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    /* ignore */
  }
};

let toast: (msg: string, kind?: 'info' | 'success' | 'error') => void = (m) => console.info('[paper]', m);
let activeChart: (() => Vela) | null = null;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const pnlClass = (n: number | undefined): string => (n == null ? '' : n >= 0 ? 'is-up' : 'is-down');

const ago = (t: number): string => {
  const d = new Date(t);
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 19)}`;
};

function currentSymbol(): string | undefined {
  return activeChart?.().market.symbol;
}

function qtyFor(symbol: string | undefined): number {
  if (!symbol) return 1;
  return ui.qty[displaySymbol(symbol)] ?? 1;
}

function setQty(symbol: string | undefined, q: number): void {
  if (!symbol || !(q > 0)) return;
  ui.qty[displaySymbol(symbol)] = q;
  saveUi();
}

function report(r: { ok: true; message: string } | { ok: false; error: string }): void {
  if (r.ok) toast(r.message, 'success');
  else toast(r.error, 'error');
}

/* ------------------------------------------------------------------ ticket */

let ticketEl: HTMLElement | null = null;

export function openTicket(opts: { side: Side; type?: OrderType; price?: number; symbol?: string }): void {
  const symbol = opts.symbol ?? currentSymbol();
  if (!symbol) return;
  closeTicket();

  const px = lastPrice(symbol);
  let side = opts.side;
  let type: OrderType = opts.type ?? 'market';
  const el = document.createElement('div');
  el.className = 'desk-ticket';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Order ticket');
  el.innerHTML = `
    <div class="desk-ticket__head">
      <span class="desk-ticket__sym">${esc(displaySymbol(symbol))}</span>
      <span class="desk-ticket__acct">Paper Trading</span>
      <button type="button" class="desk-ticket__x" aria-label="Close">×</button>
    </div>
    <div class="desk-ticket__sides">
      <button type="button" class="desk-ticket__side is-sell" data-side="sell"><span>Sell</span><b data-bid></b></button>
      <button type="button" class="desk-ticket__side is-buy" data-side="buy"><span>Buy</span><b data-ask></b></button>
    </div>
    <div class="desk-ticket__tabs" role="tablist">
      <button type="button" data-type="market">Market</button>
      <button type="button" data-type="limit">Limit</button>
      <button type="button" data-type="stop">Stop</button>
    </div>
    <label class="desk-ticket__row" data-price-row><span>Price</span><input type="number" step="any" data-f="price" /></label>
    <label class="desk-ticket__row"><span>Quantity</span><input type="number" step="any" min="0" data-f="qty" /></label>
    <label class="desk-ticket__row desk-ticket__row--opt"><input type="checkbox" data-c="tp" /><span>Take profit</span><input type="number" step="any" data-f="tp" disabled /></label>
    <label class="desk-ticket__row desk-ticket__row--opt"><input type="checkbox" data-c="sl" /><span>Stop loss</span><input type="number" step="any" data-f="sl" disabled /></label>
    <div class="desk-ticket__info" data-info></div>
    <button type="button" class="desk-ticket__submit" data-submit></button>
  `;
  document.body.appendChild(el);
  ticketEl = el;

  const $ = <T extends HTMLElement>(sel: string): T => el.querySelector(sel) as T;
  const priceIn = $<HTMLInputElement>('[data-f=price]');
  const qtyIn = $<HTMLInputElement>('[data-f=qty]');
  const tpIn = $<HTMLInputElement>('[data-f=tp]');
  const slIn = $<HTMLInputElement>('[data-f=sl]');
  const tpC = $<HTMLInputElement>('[data-c=tp]');
  const slC = $<HTMLInputElement>('[data-c=sl]');
  const info = $<HTMLElement>('[data-info]');
  const submit = $<HTMLButtonElement>('[data-submit]');

  qtyIn.value = String(qtyFor(symbol));
  const ref0 = opts.price ?? px;
  if (ref0 != null) {
    priceIn.value = String(round(ref0));
    tpIn.value = String(round(ref0 * (side === 'buy' ? 1.01 : 0.99)));
    slIn.value = String(round(ref0 * (side === 'buy' ? 0.995 : 1.005)));
  }

  const num = (i: HTMLInputElement): number | undefined => {
    const v = Number.parseFloat(i.value);
    return Number.isFinite(v) ? v : undefined;
  };

  const refresh = (): void => {
    const live = lastPrice(symbol);
    $<HTMLElement>('[data-bid]').textContent = fmtPrice(live);
    $<HTMLElement>('[data-ask]').textContent = fmtPrice(live);
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-side]')) {
      b.classList.toggle('is-active', b.dataset.side === side);
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-type]')) {
      b.classList.toggle('is-active', b.dataset.type === type);
    }
    $<HTMLElement>('[data-price-row]').hidden = type === 'market';
    tpIn.disabled = !tpC.checked;
    slIn.disabled = !slC.checked;

    const qty = num(qtyIn) ?? 0;
    const entry = type === 'market' ? live : num(priceIn);
    const parts: string[] = [];
    if (entry != null && qty > 0) {
      parts.push(`Value <b>${fmtMoney(entry * qty)}</b>`);
      const sl = slC.checked ? num(slIn) : undefined;
      const tp = tpC.checked ? num(tpIn) : undefined;
      const risk = sl != null ? Math.abs(entry - sl) * qty : undefined;
      const reward = tp != null ? Math.abs(tp - entry) * qty : undefined;
      if (risk != null) parts.push(`Risk <b class="is-down">${fmtMoney(risk)}</b>`);
      if (reward != null) parts.push(`Reward <b class="is-up">${fmtMoney(reward)}</b>`);
      if (risk && reward) parts.push(`R:R <b>${(reward / risk).toFixed(2)}</b>`);
    }
    info.innerHTML = parts.join(' · ') || '&nbsp;';

    const label = type === 'market' ? 'MKT' : `${type === 'limit' ? 'LMT' : 'STP'} ${fmtPrice(num(priceIn))}`;
    submit.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} ${qty || ''} ${displaySymbol(symbol)} @ ${label}`;
    submit.className = `desk-ticket__submit ${side === 'buy' ? 'is-buy' : 'is-sell'}`;
  };

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.desk-ticket__x')) return closeTicket();
    const sb = t.closest<HTMLElement>('[data-side]');
    if (sb) {
      side = sb.dataset.side as Side;
      return refresh();
    }
    const tb = t.closest<HTMLElement>('[data-type]');
    if (tb) {
      type = tb.dataset.type as OrderType;
      return refresh();
    }
    if (t.closest('[data-submit]')) {
      const qty = num(qtyIn) ?? 0;
      setQty(symbol, qty);
      const r = placeOrder({
        symbol,
        side,
        type,
        qty,
        price: type === 'market' ? undefined : num(priceIn),
        tp: tpC.checked ? num(tpIn) : undefined,
        sl: slC.checked ? num(slIn) : undefined,
      });
      report(r);
      if (r.ok) closeTicket();
    }
  });
  el.addEventListener('input', refresh);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTicket();
    if (e.key === 'Enter') submit.click();
    e.stopPropagation();
  });

  const off = onPaperChange(refresh);
  (el as HTMLElement & { _off?: () => void })._off = off;
  refresh();
  qtyIn.focus();
  qtyIn.select();
}

function closeTicket(): void {
  if (!ticketEl) return;
  (ticketEl as HTMLElement & { _off?: () => void })._off?.();
  ticketEl.remove();
  ticketEl = null;
}

function round(n: number): number {
  const digits = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 4 : 6;
  return Number(n.toFixed(digits));
}

/* -------------------------------------------------------------- quick trade */

function mountQuickTrade(root: HTMLElement): () => void {
  const el = document.createElement('div');
  el.className = 'desk-qt';
  el.innerHTML = `
    <button type="button" class="desk-qt__btn is-sell" data-q="sell"><b data-p></b><span>SELL</span></button>
    <input class="desk-qt__qty" type="number" min="0" step="any" aria-label="Order quantity" title="Quantity" />
    <button type="button" class="desk-qt__btn is-buy" data-q="buy"><b data-p></b><span>BUY</span></button>
  `;
  const qtyIn = el.querySelector('.desk-qt__qty') as HTMLInputElement;
  let lastSym: string | undefined;

  const place = (): void => {
    const cell = root.querySelector<HTMLElement>('.vela-cell');
    if (cell && el.parentElement !== cell) cell.appendChild(el);
  };

  const refresh = (): void => {
    place();
    const sym = currentSymbol();
    if (sym !== lastSym) {
      lastSym = sym;
      qtyIn.value = String(qtyFor(sym));
    }
    const px = sym ? lastPrice(sym) : undefined;
    for (const b of el.querySelectorAll<HTMLElement>('[data-p]')) b.textContent = fmtPrice(px);
  };

  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-q]');
    if (!b) return;
    const side = b.dataset.q as Side;
    const sym = currentSymbol();
    const q = Number.parseFloat(qtyIn.value);
    setQty(sym, q);
    if (e.shiftKey && sym) {
      // Shift+click = one-click market order (TradingView's "one-click trading").
      report(placeOrder({ symbol: sym, side, type: 'market', qty: q }));
      return;
    }
    openTicket({ side });
  });
  qtyIn.addEventListener('change', () => setQty(currentSymbol(), Number.parseFloat(qtyIn.value)));
  qtyIn.addEventListener('keydown', (e) => e.stopPropagation());
  for (const ev of ['pointerdown', 'wheel', 'mousedown']) el.addEventListener(ev, (e) => e.stopPropagation());

  const off = onPaperChange(refresh);
  const timer = window.setInterval(refresh, 1000);
  refresh();
  return () => {
    off();
    clearInterval(timer);
    el.remove();
  };
}

/* ------------------------------------------------------------ bottom panel */

function renderPanel(panel: HTMLElement): void {
  const acct = getAccount();
  const t = totals();
  const sum = panel.querySelector('[data-summary]') as HTMLElement;
  sum.innerHTML = `
    <span>Balance <b>${fmtMoney(t.balance)}</b></span>
    <span>Equity <b>${fmtMoney(t.equity)}</b></span>
    <span>Realized P&amp;L <b class="${pnlClass(t.realized)}">${fmtSigned(t.realized)}</b></span>
    <span>Unrealized P&amp;L <b class="${pnlClass(t.unrealized)}">${fmtSigned(t.unrealized)}</b></span>
  `;
  for (const b of panel.querySelectorAll<HTMLElement>('[data-tab]')) {
    b.classList.toggle('is-active', b.dataset.tab === ui.tab);
    const n = b.dataset.tab === 'positions' ? acct.positions.length : b.dataset.tab === 'orders' ? acct.orders.length : 0;
    const badge = b.querySelector('i');
    if (badge) badge.textContent = n ? String(n) : '';
  }
  panel.classList.toggle('is-open', ui.open);
  if (!ui.open) return;

  const body = panel.querySelector('[data-body]') as HTMLElement;
  if (ui.tab === 'positions') {
    body.innerHTML = acct.positions.length
      ? `<table><thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg fill</th><th>Last</th><th>Unrealized P&amp;L</th><th>P&amp;L %</th><th>Take profit</th><th>Stop loss</th><th></th></tr></thead><tbody>${acct.positions
          .map((p) => {
            const u = unrealized(p);
            const pct = u != null ? (u / Math.abs(p.avgPrice * p.qty)) * 100 : undefined;
            return `<tr data-sym="${esc(p.symbol)}">
              <td><a href="#" data-goto>${esc(displaySymbol(p.symbol))}</a></td>
              <td class="${p.qty > 0 ? 'is-up' : 'is-down'}">${p.qty > 0 ? 'Long' : 'Short'}</td>
              <td>${Math.abs(p.qty)}</td>
              <td>${fmtPrice(p.avgPrice)}</td>
              <td>${fmtPrice(lastPrice(p.symbol))}</td>
              <td class="${pnlClass(u)}">${fmtSigned(u)}</td>
              <td class="${pnlClass(pct)}">${pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}</td>
              <td><input type="number" step="any" data-br="tp" value="${p.tp ?? ''}" placeholder="—" /></td>
              <td><input type="number" step="any" data-br="sl" value="${p.sl ?? ''}" placeholder="—" /></td>
              <td class="desk-tp__acts"><button type="button" data-act="reverse" title="Reverse">⇅</button><button type="button" data-act="close" title="Close position">×</button></td>
            </tr>`;
          })
          .join('')}</tbody></table>`
      : '<div class="desk-tp__empty">No open positions. Use Buy / Sell on the chart (Shift+click for instant market orders).</div>';
  } else if (ui.tab === 'orders') {
    body.innerHTML = acct.orders.length
      ? `<table><thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Last</th><th>Take profit</th><th>Stop loss</th><th>Placed</th><th><button type="button" data-act="cancel-all">Cancel all</button></th></tr></thead><tbody>${acct.orders
          .map(
            (o) => `<tr data-id="${o.id}" data-sym="${esc(o.symbol)}">
              <td><a href="#" data-goto>${esc(displaySymbol(o.symbol))}</a></td>
              <td class="${o.side === 'buy' ? 'is-up' : 'is-down'}">${o.side === 'buy' ? 'Buy' : 'Sell'}</td>
              <td>${o.type === 'limit' ? 'Limit' : 'Stop'}</td>
              <td>${o.qty}</td>
              <td>${fmtPrice(o.price)}</td>
              <td>${fmtPrice(lastPrice(o.symbol))}</td>
              <td>${fmtPrice(o.tp)}</td>
              <td>${fmtPrice(o.sl)}</td>
              <td>${ago(o.createdAt)}</td>
              <td class="desk-tp__acts"><button type="button" data-act="cancel" title="Cancel order">×</button></td>
            </tr>`,
          )
          .join('')}</tbody></table>`
      : '<div class="desk-tp__empty">No working orders. Right-click the chart to place a limit or stop at that price.</div>';
  } else {
    body.innerHTML = acct.history.length
      ? `<table><thead><tr><th>Time (UTC)</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Fill price</th><th>Realized P&amp;L</th><th>Reason</th></tr></thead><tbody>${acct.history
          .map(
            (f) => `<tr data-sym="${esc(f.symbol)}">
              <td>${ago(f.time)}</td>
              <td><a href="#" data-goto>${esc(displaySymbol(f.symbol))}</a></td>
              <td class="${f.side === 'buy' ? 'is-up' : 'is-down'}">${f.side === 'buy' ? 'Buy' : 'Sell'}</td>
              <td>${f.qty}</td>
              <td>${fmtPrice(f.price)}</td>
              <td class="${f.realized ? pnlClass(f.realized) : ''}">${f.realized ? fmtSigned(f.realized) : '—'}</td>
              <td>${esc(f.reason)}</td>
            </tr>`,
          )
          .join('')}</tbody></table>`
      : '<div class="desk-tp__empty">No fills yet.</div>';
  }
}

function mountPanel(ws: () => VelaWorkspace | null, setSymbol: (s: string) => void): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'desk-tp';
  panel.setAttribute('aria-label', 'Paper trading');
  panel.innerHTML = `
    <header class="desk-tp__bar">
      <button type="button" class="desk-tp__title" data-act="toggle" title="Show / hide trading panel">
        <span class="desk-tp__caret">▸</span> Paper Trading
      </button>
      <nav class="desk-tp__tabs" role="tablist">
        <button type="button" data-tab="positions">Positions <i></i></button>
        <button type="button" data-tab="orders">Orders <i></i></button>
        <button type="button" data-tab="history">History</button>
      </nav>
      <div class="desk-tp__summary" data-summary></div>
      <button type="button" class="desk-tp__reset" data-act="reset" title="Reset paper account to 100,000">Reset</button>
    </header>
    <div class="desk-tp__body" data-body></div>
  `;
  void ws;

  let raf = 0;
  let editing = false;
  const rerender = (): void => {
    if (raf || editing) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderPanel(panel);
    });
  };

  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>('[data-tab]');
    if (tab) {
      ui.tab = tab.dataset.tab as UiState['tab'];
      ui.open = true;
      saveUi();
      return renderPanel(panel);
    }
    const goto = t.closest('[data-goto]');
    if (goto) {
      e.preventDefault();
      const sym = goto.closest<HTMLElement>('tr')?.dataset.sym;
      if (sym) setSymbol(sym);
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    const row = t.closest<HTMLElement>('tr');
    if (act === 'toggle') {
      ui.open = !ui.open;
      saveUi();
      renderPanel(panel);
      window.dispatchEvent(new Event('resize'));
    } else if (act === 'close' && row?.dataset.sym) report(closePosition(row.dataset.sym));
    else if (act === 'reverse' && row?.dataset.sym) report(reversePosition(row.dataset.sym));
    else if (act === 'cancel' && row?.dataset.id) cancelOrder(row.dataset.id);
    else if (act === 'cancel-all') cancelAllOrders();
    else if (act === 'reset') {
      resetAccount();
      toast('Paper account reset to 100,000.00', 'info');
    }
  });
  panel.addEventListener('focusin', (e) => {
    if ((e.target as HTMLElement).matches('input')) editing = true;
  });
  panel.addEventListener('focusout', () => {
    editing = false;
    rerender();
  });
  panel.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const key = input.dataset.br as 'tp' | 'sl' | undefined;
    const sym = input.closest<HTMLElement>('tr')?.dataset.sym;
    if (!key || !sym) return;
    const v = Number.parseFloat(input.value);
    const pos = positionFor(sym);
    if (pos && Number.isFinite(v)) {
      const long = pos.qty > 0;
      const px = lastPrice(sym) ?? pos.avgPrice;
      const wrong = key === 'tp' ? (long ? v <= px : v >= px) : long ? v >= px : v <= px;
      if (wrong) {
        toast(`${key === 'tp' ? 'Take profit' : 'Stop loss'} is on the wrong side of the price`, 'error');
        input.value = String(pos[key] ?? '');
        return;
      }
    }
    setBracket(sym, { [key]: Number.isFinite(v) ? v : null });
  });
  panel.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).matches('input') && e.key === 'Enter') (e.target as HTMLInputElement).blur();
    e.stopPropagation();
  });

  onPaperChange(rerender);
  renderPanel(panel);
  return panel;
}

/* ---------------------------------------------------------------- wiring */

registerIcon(
  'desk-buy',
  '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 14V4M5 8l4-4 4 4"/></svg>',
);
registerIcon(
  'desk-sell',
  '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 4v10M5 10l4 4 4-4"/></svg>',
);

/** Register before the workspace mounts. */
export function registerPaperTrading(getWs: () => VelaWorkspace | null): void {
  registerWidgetAttachment({
    id: 'desk.paper-trading',
    mount: (ctx) => {
      toast = (m, kind) => ctx.toast(m, kind as never);
      activeChart = () => ctx.chart;
      const panel = mountPanel(getWs, (s) => ctx.setSymbol(s));
      const dock = ctx.dockStrip(panel, { position: 'below-bottombar' });
      const offQt = mountQuickTrade(ctx.host.closest<HTMLElement>('.vela-workspace') ?? ctx.host);
      const onKey = (e: KeyboardEvent): void => {
        // TradingView: Shift+B / Shift+S open the ticket.
        if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if ((e.target as HTMLElement).matches('input, textarea, [contenteditable]')) return;
        if (e.code === 'KeyB') openTicket({ side: 'buy' });
        else if (e.code === 'KeyS') openTicket({ side: 'sell' });
        else return;
        e.preventDefault();
        e.stopPropagation();
      };
      window.addEventListener('keydown', onKey, true);
      return () => {
        window.removeEventListener('keydown', onKey, true);
        offQt();
        dock();
        panel.remove();
      };
    },
  });

  const atCursor = (side: Side) => (ctx: { pointer?: { price?: number } | null }) => {
    const price = ctx.pointer?.price;
    const sym = currentSymbol();
    if (price == null || !sym) return;
    const px = lastPrice(sym);
    const type: OrderType =
      px == null ? 'limit' : side === 'buy' ? (price < px ? 'limit' : 'stop') : price > px ? 'limit' : 'stop';
    openTicket({ side, type, price: round(price) });
  };

  registerWidgetAction({
    id: 'desk.paper.buy-here',
    target: 'context:body',
    label: 'Buy at this price…',
    icon: 'desk-buy',
    order: 1,
    run: atCursor('buy') as never,
  });
  registerWidgetAction({
    id: 'desk.paper.sell-here',
    target: 'context:body',
    label: 'Sell at this price…',
    icon: 'desk-sell',
    order: 2,
    run: atCursor('sell') as never,
  });
}

/** Feed live prices into the paper engine: the chart's own bars + every HL mid. */
export function startPaperPriceFeed(ws: VelaWorkspace): void {
  ws.chart.on('bar', (bar) => {
    const sym = ws.chart.market.symbol;
    if (sym) onPrice(sym, bar.close);
  });
  onHlQuotes((map) => {
    for (const [sym, q] of map) onPrice(sym, q.price);
  });
}
