/**
 * Desk plan → paper order in one click. The trade-desk pipeline publishes a long and a
 * short plan per market (`desk-latest.json`: entry, stop, target, replay odds, verdict).
 * The top-bar "Desk plan" button shows the charted coin's plans and places either one
 * as a paper bracket order (entry as a stop or limit, take profit at the target, stop
 * loss at the stop), sized so a stop-out loses the chosen % of equity.
 */
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { registerIcon, registerWidgetAction } from '@luxalgo/vela/plugin';
import { deskAgeLabel, isDeskStale, loadDeskLatest, marketForSymbol, type DeskMarket, type DeskPlan } from './approvals';
import { symbolBase } from '../panels/news';
import { fmtMoney, fmtPrice, lastPrice, placeOrder, totals } from '../trading/paper-store';

registerIcon(
  'desk-plan',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/></svg>',
);

const LS_RISK = 'chart-desk-plan-risk';
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Desk market for any chart symbol: exact, then by base coin (LBank GOLDUSDT.P → GOLD). */
function marketFor(data: Awaited<ReturnType<typeof loadDeskLatest>>, symbol: string): DeskMarket | null {
  if (!data) return null;
  const direct = marketForSymbol(data, symbol);
  if (direct) return direct;
  const base = symbolBase(symbol);
  const alias = base === 'XAUT' || base === 'PAXG' ? 'GOLD' : base;
  return data.markets.find((m) => m.coin.toUpperCase() === alias) ?? null;
}

/** Quantity that loses `riskPct` of equity at the stop. */
export function sizeFor(plan: DeskPlan, riskPct: number): number {
  const perUnit = Math.abs(plan.entry - plan.stop);
  if (!(perUnit > 0)) return 0;
  const qty = (totals().equity * riskPct) / 100 / perUnit;
  const digits = plan.entry >= 1000 ? 4 : plan.entry >= 10 ? 2 : 0;
  return Math.floor(qty * 10 ** digits) / 10 ** digits;
}

function placePlan(symbol: string, side: 'long' | 'short', plan: DeskPlan, qty: number): string {
  const px = lastPrice(symbol);
  const buy = side === 'long';
  // Entry beyond the market → stop order (breakout); already through it → limit.
  const type = px == null ? 'stop' : buy ? (plan.entry > px ? 'stop' : 'limit') : plan.entry < px ? 'stop' : 'limit';
  const r = placeOrder({ symbol, side: buy ? 'buy' : 'sell', type, qty, price: plan.entry, tp: plan.target, sl: plan.stop });
  return r.ok ? r.message : `Not placed: ${r.error}`;
}

async function openPlanCard(ws: VelaWorkspace): Promise<void> {
  document.querySelector('.desk-plan')?.remove();
  const symbol = ws.chart.market.symbol ?? '';
  const data = await loadDeskLatest(true).catch(() => null);
  const m = marketFor(data, symbol);
  const risk = Number(localStorage.getItem(LS_RISK)) || 1;

  const el = document.createElement('div');
  el.className = 'desk-plan';
  const btn = document.querySelector<HTMLElement>('[data-action-id="desk.plan"]');
  const r = btn?.getBoundingClientRect();
  el.style.top = `${(r?.bottom ?? 40) + 4}px`;
  el.style.left = `${Math.min(window.innerWidth - 380, Math.max(8, r?.left ?? 200))}px`;

  if (!m || !data) {
    el.innerHTML = `<div class="desk-plan__head"><b>Desk plan</b><button type="button" data-x>✕</button></div>
      <div class="desk-plan__empty">${data ? `No desk plan for ${esc(symbol)}. The desk covers ${esc(data.markets.map((x) => x.coin).join(', '))}.` : 'No desk-latest.json yet. Run the trade desk export to publish plans.'}</div>`;
  } else {
    const stale = isDeskStale(data.at);
    const px = lastPrice(symbol) ?? m.close;
    const row = (side: 'long' | 'short'): string => {
      const p = m.plans[side];
      const rr = Math.abs(p.target - p.entry) / Math.abs(p.entry - p.stop);
      const dist = ((p.entry - px) / px) * 100;
      const qty = sizeFor(p, risk);
      const approved = m.verdict.startsWith('APPROVED') && m.verdict.includes(side.toUpperCase());
      return `<div class="desk-plan__side is-${side}${approved ? ' is-approved' : ''}">
        <div class="desk-plan__title"><b>${side === 'long' ? 'Long' : 'Short'}</b>${approved ? '<span class="desk-plan__ok">APPROVED</span>' : ''}<span>entry ${dist >= 0 ? '+' : ''}${dist.toFixed(2)}% away</span></div>
        <div class="desk-plan__grid">
          <span>Entry</span><b>${fmtPrice(p.entry)}</b>
          <span>Stop</span><b class="is-down">${fmtPrice(p.stop)}</b>
          <span>Target</span><b class="is-up">${fmtPrice(p.target)}</b>
          <span>R:R</span><b>${Number.isFinite(rr) ? rr.toFixed(2) : '—'}</b>
          <span>Replay edge</span><b class="${p.replay >= 0 ? 'is-up' : 'is-down'}">${p.replay >= 0 ? '+' : ''}${p.replay.toFixed(2)}R</b>
          <span>Size</span><b data-qty="${side}">${qty}</b>
        </div>
        <button type="button" class="desk-plan__go" data-place="${side}">Place ${side} bracket</button>
      </div>`;
    };
    el.innerHTML = `
      <div class="desk-plan__head"><b>Desk plan · ${esc(m.coin)}</b><span class="desk-plan__verdict ${m.verdict.startsWith('APPROVED') ? 'is-approved' : ''}">${esc(m.verdict)}</span><button type="button" data-x>✕</button></div>
      <div class="desk-plan__meta${stale ? ' is-stale' : ''}">Published ${esc(deskAgeLabel(data.at))}${stale ? ' · stale: rerun the desk before trading it' : ''}</div>
      <div class="desk-plan__risk">Risk per trade <input type="number" min="0.1" max="10" step="0.1" value="${risk}" data-risk>% of equity (${fmtMoney(totals().equity)})</div>
      <div class="desk-plan__sides">${row('long')}${row('short')}</div>
      <div class="desk-plan__foot">Paper only. Entries above / below the market go in as stop orders; take profit and stop loss ride as a bracket.</div>`;
  }
  document.body.appendChild(el);

  const close = (): void => {
    el.remove();
    document.removeEventListener('mousedown', outside, true);
  };
  const outside = (e: MouseEvent): void => {
    const t = e.target as HTMLElement;
    if (!el.contains(t) && !t.closest('[data-action-id="desk.plan"]')) close();
  };
  document.addEventListener('mousedown', outside, true);
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  el.addEventListener('input', (e) => {
    const inp = (e.target as HTMLElement).closest<HTMLInputElement>('[data-risk]');
    if (!inp || !m) return;
    const v = Number(inp.value);
    if (!(v > 0)) return;
    localStorage.setItem(LS_RISK, String(v));
    for (const side of ['long', 'short'] as const) {
      const q = el.querySelector(`[data-qty="${side}"]`);
      if (q) q.textContent = String(sizeFor(m.plans[side], v));
    }
  });
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-x]')) return close();
    const side = t.closest<HTMLElement>('[data-place]')?.dataset.place as 'long' | 'short' | undefined;
    if (side && m) {
      const qty = Number(el.querySelector(`[data-qty="${side}"]`)?.textContent);
      const msg = placePlan(symbol, side, m.plans[side], qty);
      ws.toast(msg, msg.startsWith('Not placed') ? 'error' : 'success');
      if (!msg.startsWith('Not placed')) close();
    }
  });
}

export function registerDeskPlan(getWs: () => VelaWorkspace | null): void {
  registerWidgetAction({
    id: 'desk.plan',
    target: 'topbar',
    align: 'left',
    label: 'Desk plan',
    icon: 'desk-plan',
    order: 30,
    run: () => {
      const ws = getWs();
      if (ws) void openPlanCard(ws);
    },
  });
}
