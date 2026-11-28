/**
 * TradingView's bottom-bar extras: the "Go to" button (also Alt+G) after the range
 * buttons, and the `%` / `log` / `auto` price-scale toggles at the right end.
 */
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

const TF_MS: Record<string, number> = { D: 86_400_000, W: 7 * 86_400_000, M: 30 * 86_400_000 };

/** Bar length of a Vela timeframe (`'1'`, `'60'`, `'1D'`, `'1W'`, `'1M'`). */
export function tfMs(tf: string): number {
  const m = tf.match(/^(\d*)([DWM])$/i);
  if (m) return (Number(m[1]) || 1) * TF_MS[m[2]!.toUpperCase()]!;
  return (Number(tf) || 1) * 60_000;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const localInput = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Frame [from, to] on the active chart, loading older history first when needed. */
async function frame(ws: VelaWorkspace, from: number, to: number): Promise<void> {
  const chart = ws.chart;
  const tf = tfMs(chart.market.timeframe ?? '60');
  const first = chart.replay.bounds?.first ?? chart.getVisibleRange()?.from ?? Date.now();
  if (from < first) {
    const need = Math.ceil((Date.now() - from) / tf) + 50;
    if (need > 20_000) {
      ws.toast('That date is too far back for this timeframe: pick a higher timeframe', 'error');
      return;
    }
    ws.toast('Loading history…', 'info');
    const done = new Promise<void>((resolve) => {
      const off = chart.on('history:complete', () => {
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, 20_000);
    });
    await chart.setMarket({ bars: need });
    await done;
  }
  const oldest = chart.replay.bounds?.first;
  if (oldest != null && from < oldest) {
    const span = to - from;
    ws.toast(`History on this chart starts ${new Date(oldest).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' })}`, 'info');
    from = oldest;
    to = Math.max(to, oldest + span);
  }
  chart.setVisibleRange({ from, to: Math.min(to, Date.now() + tf * 5) });
}

export function openGoTo(ws: VelaWorkspace): void {
  document.querySelector('.desk-goto')?.remove();
  const now = Date.now();
  const tf = tfMs(ws.chart.market.timeframe ?? '60');
  const vr = ws.chart.getVisibleRange();
  const wrap = document.createElement('div');
  wrap.className = 'desk-goto';
  wrap.innerHTML = `
    <form class="desk-goto__dialog" role="dialog" aria-label="Go to">
      <div class="desk-goto__head"><b>Go to</b><button type="button" data-x aria-label="Close">✕</button></div>
      <div class="desk-goto__tabs"><button type="button" data-tab="date" class="is-active">Date</button><button type="button" data-tab="range">Custom range</button></div>
      <div class="desk-goto__body" data-pane="date">
        <label>Date and time<input type="datetime-local" name="at" value="${localInput(vr ? (vr.from + vr.to) / 2 : now)}" max="${localInput(now)}"></label>
      </div>
      <div class="desk-goto__body" data-pane="range" hidden>
        <label>From<input type="datetime-local" name="from" value="${localInput(vr?.from ?? now - 100 * tf)}" max="${localInput(now)}"></label>
        <label>To<input type="datetime-local" name="to" value="${localInput(vr?.to ?? now)}" max="${localInput(now)}"></label>
      </div>
      <div class="desk-goto__foot"><button type="button" data-x>Cancel</button><button type="submit" class="is-primary">Go to</button></div>
    </form>`;
  document.body.appendChild(wrap);
  const form = wrap.querySelector('form')!;
  let mode: 'date' | 'range' = 'date';
  const close = (): void => {
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent): void => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) close();
  });
  form.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-x]')) return close();
    const tab = t.closest<HTMLElement>('[data-tab]')?.dataset.tab;
    if (tab === 'date' || tab === 'range') {
      mode = tab;
      for (const b of form.querySelectorAll<HTMLElement>('[data-tab]')) b.classList.toggle('is-active', b.dataset.tab === tab);
      for (const p of form.querySelectorAll<HTMLElement>('[data-pane]')) p.hidden = p.dataset.pane !== tab;
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = (n: string): number => Date.parse((form.elements.namedItem(n) as HTMLInputElement).value);
    let from: number;
    let to: number;
    if (mode === 'date') {
      const at = val('at');
      if (!Number.isFinite(at)) return;
      // Keep the current zoom, centred on the date.
      const span = vr ? vr.to - vr.from : 120 * tf;
      from = at - span / 2;
      to = at + span / 2;
    } else {
      from = val('from');
      to = val('to');
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    }
    close();
    void frame(ws, from, to);
  });
  (form.querySelector('input') as HTMLInputElement).focus();
}

function scaleButtons(ws: VelaWorkspace): HTMLElement {
  const g = document.createElement('span');
  g.className = 'desk-bb-scale';
  g.innerHTML = `<button type="button" data-s="percent" title="Toggle percentage scale">%</button><button type="button" data-s="log" title="Toggle logarithmic scale">log</button><button type="button" data-s="auto" title="Toggle auto (fits data to screen)">auto</button>`;
  const paint = (): void => {
    const r = ws.chart.renderer;
    const on: Record<string, boolean> = {
      percent: r.get('scaleMode') === 'percent',
      log: !!r.get('logScale'),
      auto: r.get('autoScale') !== false,
    };
    for (const b of g.querySelectorAll<HTMLElement>('[data-s]')) b.classList.toggle('is-active', !!on[b.dataset.s!]);
  };
  g.addEventListener('click', (e) => {
    const s = (e.target as HTMLElement).closest<HTMLElement>('[data-s]')?.dataset.s;
    const r = ws.chart.renderer;
    if (s === 'percent') {
      const pct = r.get('scaleMode') === 'percent';
      r.set({ scaleMode: pct ? 'price' : 'percent', ...(pct ? {} : { logScale: false }) });
    } else if (s === 'log') {
      const log = !!r.get('logScale');
      r.set({ logScale: !log, ...(log ? {} : { scaleMode: 'price' }) });
    } else if (s === 'auto') {
      r.set('autoScale', r.get('autoScale') === false);
    }
    paint();
  });
  paint();
  let off = ws.chart.renderer.onConfigChanged(paint);
  ws.on('cell:active', () => {
    off();
    off = ws.chart.renderer.onConfigChanged(paint);
    paint();
  });
  // Axis drags flip autoscale off without a config change.
  document.addEventListener('pointerup', () => setTimeout(paint, 0), true);
  return g;
}

export function installBottomBar(ws: VelaWorkspace): void {
  const scale = scaleButtons(ws);
  const goto = document.createElement('button');
  goto.type = 'button';
  goto.className = 'desk-bb-goto';
  goto.title = 'Go to… (Alt+G)';
  goto.setAttribute('aria-label', 'Go to date');
  goto.innerHTML =
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3M7 10.5h4M9.5 8.5l2 2-2 2"/></svg>';
  goto.addEventListener('click', () => openGoTo(ws));

  const place = (): void => {
    const bar = document.querySelector<HTMLElement>('.vela-widget-bottombar');
    if (!bar) return;
    if (!bar.contains(goto)) {
      const ranges = bar.querySelectorAll('.vela-bb-range');
      const lastRange = ranges[ranges.length - 1];
      if (lastRange) lastRange.after(goto);
    }
    if (!bar.contains(scale)) bar.appendChild(scale);
  };
  place();
  new MutationObserver(place).observe(document.querySelector('.vela-workspace') ?? document.body, { childList: true, subtree: true });

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyG') return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    openGoTo(ws);
  });
}
