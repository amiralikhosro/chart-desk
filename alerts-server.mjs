/**
 * Server-side price alerts: the same alerts the browser creates (state key
 * `chart-desk-alerts-v1`), evaluated here every few seconds so they fire with every
 * browser closed. A fire is written back to the shared state (alert stopped / log entry),
 * which the open browsers pick up over /api/events and show as their usual popup, and is
 * pushed to a phone through ntfy (https://ntfy.sh) when a topic is set — in the Alerts
 * panel (state key `chart-desk-notify-v1`) or with the NTFY_TOPIC env var.
 */

const ALERTS_KEY = 'chart-desk-alerts-v1';
const NOTIFY_KEY = 'chart-desk-notify-v1';
const LOOP_MS = 4_000;
const LOG_CAP = 200;
const UA = 'ChartDesk/1.0';

const CONDITION_LABEL = {
  crossing: 'Crossing',
  crossing_up: 'Crossing Up',
  crossing_down: 'Crossing Down',
  greater: 'Greater Than',
  less: 'Less Than',
};

const fmt = (n) => {
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: a >= 1 ? 2 : 0, maximumFractionDigits: d });
};

async function getJson(url, init) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

const hlMids = (dex) =>
  getJson('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dex ? { type: 'allMids', dex } : { type: 'allMids' }),
  });

/** Prices for a set of chart symbols, one request per venue. */
async function fetchPrices(symbols) {
  const out = new Map();
  const lower = symbols.map((s) => [s, s.toLowerCase()]);
  const hl = lower.filter(([, l]) => l.startsWith('hyperliquid:'));
  const lbPerp = lower.filter(([, l]) => l.startsWith('lbank:') && l.endsWith('.p'));
  const lbSpot = lower.filter(([, l]) => l.startsWith('lbank:') && !l.endsWith('.p'));
  const cb = lower.filter(([, l]) => l.startsWith('coinbase:'));
  const jobs = [];
  if (hl.length) {
    const needXyz = hl.some(([, l]) => l.startsWith('hyperliquid:xyz:'));
    const needMain = hl.some(([, l]) => !l.startsWith('hyperliquid:xyz:'));
    jobs.push(
      Promise.all([needMain ? hlMids() : {}, needXyz ? hlMids('xyz') : {}]).then(([a, b]) => {
        const mids = { ...a, ...b };
        for (const [s] of hl) {
          const coin = s.slice('hyperliquid:'.length);
          const px = Number(mids[coin] ?? mids[coin.toUpperCase()]);
          if (px > 0) out.set(s, px);
        }
      }),
    );
  }
  if (lbPerp.length) {
    jobs.push(
      getJson('https://lbkperp.lbank.com/cfd/openApi/v1/pub/marketData?productGroup=SwapU').then((j) => {
        const by = new Map((j.data ?? []).map((r) => [String(r.symbol).toUpperCase(), Number(r.lastPrice)]));
        for (const [s] of lbPerp) {
          const sym = s.slice('lbank:'.length).replace(/\.P$/i, '').toUpperCase();
          const px = by.get(sym);
          if (px > 0) out.set(s, px);
        }
      }),
    );
  }
  for (const [s] of lbSpot) {
    const t = s.slice('lbank:'.length).toUpperCase();
    const q = t.match(/(USDT|USDC|BTC|ETH)$/)?.[1] ?? 'USDT';
    const pair = `${t.slice(0, -q.length)}_${q}`.toLowerCase();
    jobs.push(
      getJson(`https://api.lbank.info/v2/ticker/24hr.do?symbol=${encodeURIComponent(pair)}`).then((j) => {
        const px = Number(j.data?.[0]?.ticker?.latest);
        if (px > 0) out.set(s, px);
      }),
    );
  }
  for (const [s] of cb) {
    const id = s.slice(s.indexOf(':') + 1).toUpperCase();
    jobs.push(
      getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(id)}/ticker`).then((j) => {
        const px = Number(j.price);
        if (px > 0) out.set(s, px);
      }),
    );
  }
  await Promise.allSettled(jobs);
  return out;
}

function hit(a, prev, price) {
  switch (a.condition) {
    case 'greater':
      return price > a.price;
    case 'less':
      return price < a.price;
    case 'crossing_up':
      return prev != null && prev < a.price && price >= a.price;
    case 'crossing_down':
      return prev != null && prev > a.price && price <= a.price;
    case 'crossing':
      return prev != null && ((prev < a.price && price >= a.price) || (prev > a.price && price <= a.price));
    default:
      return false;
  }
}

/** Trend-line alerts carry two anchors; their level moves with time. */
function levelAt(a, now) {
  if (a.line && a.line.t2 !== a.line.t1) {
    const { t1, p1, t2, p2 } = a.line;
    return p1 + ((p2 - p1) * (now - t1)) / (t2 - t1);
  }
  return a.price;
}

export function createAlertWorker({ store }) {
  const prevById = new Map();
  let lastRun = 0;
  let lastError = '';

  async function notifyPhone(alert, price) {
    let cfg = {};
    try {
      cfg = JSON.parse(store.get(NOTIFY_KEY)?.v ?? '{}');
    } catch {
      cfg = {};
    }
    const topic = process.env.NTFY_TOPIC || (cfg.enabled !== false ? cfg.topic : '');
    if (!topic) return;
    const server = (process.env.NTFY_SERVER || cfg.server || 'https://ntfy.sh').replace(/\/$/, '');
    const sym = alert.symbol.split(':').slice(1).join(':') || alert.symbol;
    try {
      await fetch(`${server}/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: {
          Title: `Alert on ${sym}`,
          Tags: 'bell',
          Priority: 'high',
          ...(process.env.DESK_PUBLIC_URL ? { Click: process.env.DESK_PUBLIC_URL } : {}),
        },
        body: `${alert.message}\nPrice ${fmt(price)}`,
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      console.warn('[alerts] ntfy:', err instanceof Error ? err.message : err);
    }
  }

  async function tick() {
    const doc = store.get(ALERTS_KEY);
    lastRun = Date.now();
    if (!doc?.v) return;
    let data;
    try {
      data = JSON.parse(doc.v);
    } catch {
      return;
    }
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    const now = Date.now();
    let changed = false;
    for (const a of alerts) {
      if (a.active && a.expiresAt != null && a.expiresAt < now) {
        a.active = false;
        a.stopped = 'expired';
        changed = true;
      }
    }
    const live = alerts.filter((a) => a.active);
    const prices = live.length ? await fetchPrices([...new Set(live.map((a) => a.symbol))]) : new Map();
    const fired = [];
    for (const a of live) {
      const price = prices.get(a.symbol);
      if (price == null) continue;
      const level = levelAt(a, now);
      const prev = prevById.get(a.id);
      prevById.set(a.id, price);
      if (!hit({ ...a, price: level }, prev, price)) continue;
      if (a.trigger === 'per_minute' && a.lastFiredAt != null && now - a.lastFiredAt < 60_000) continue;
      a.lastFiredAt = now;
      if (a.trigger === 'once') {
        a.active = false;
        a.stopped = 'triggered';
      }
      const entry = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, alertId: a.id, symbol: a.symbol, message: a.message, price, time: now, by: 'server' };
      data.log = [entry, ...(Array.isArray(data.log) ? data.log : [])].slice(0, LOG_CAP);
      fired.push([a, price]);
      changed = true;
    }
    if (!changed) return;
    // Don't clobber an edit that landed while prices were in flight.
    const latest = store.get(ALERTS_KEY);
    if (latest && latest.t !== doc.t) return;
    data.alerts = alerts;
    store.put(ALERTS_KEY, JSON.stringify(data), Math.max(Date.now(), doc.t + 1));
    for (const [a, price] of fired) {
      console.log(`[alerts] fired ${a.symbol} ${CONDITION_LABEL[a.condition] ?? a.condition} ${a.price} @ ${price}`);
      void notifyPhone(a, price);
    }
  }

  const loop = async () => {
    try {
      await tick();
      lastError = '';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      setTimeout(loop, LOOP_MS).unref?.();
    }
  };
  void loop();

  return {
    status: () => ({ serverAlerts: Date.now() - lastRun < LOOP_MS * 4, alertsError: lastError || undefined, ntfyEnv: !!process.env.NTFY_TOPIC }),
    testNotify: () => notifyPhone({ symbol: 'desk:Chart Desk', message: 'Test notification: phone alerts are working.' }, 0),
  };
}
