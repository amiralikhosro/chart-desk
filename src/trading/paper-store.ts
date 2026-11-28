/**
 * Paper trading engine — TradingView "Paper Trading" style netting account.
 * One position per symbol, market / limit / stop orders with optional bracket
 * (take profit / stop loss), fills driven by live prices. localStorage only:
 * nothing ever reaches a broker.
 */

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';

export type PaperOrder = {
  id: string;
  symbol: string;
  side: Side;
  type: Exclude<OrderType, 'market'>;
  qty: number;
  price: number;
  tp?: number;
  sl?: number;
  createdAt: number;
};

export type PaperPosition = {
  symbol: string;
  /** Signed: positive long, negative short. */
  qty: number;
  avgPrice: number;
  tp?: number;
  sl?: number;
  openedAt: number;
};

export type PaperFill = {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  time: number;
  /** Realized P&L booked by this fill (closing part only). */
  realized: number;
  reason: string;
};

export type PaperAccount = {
  startBalance: number;
  balance: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
  history: PaperFill[];
};

export type OrderRequest = {
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  /** Limit / stop price (ignored for market). */
  price?: number;
  tp?: number;
  sl?: number;
};

const LS_KEY = 'chart-desk-paper-v1';
const DEFAULT_BALANCE = 100_000;
const HISTORY_CAP = 500;

type Listener = () => void;

const listeners = new Set<Listener>();
const priceListeners = new Set<(symbol: string, price: number) => void>();

/** Every live price the app sees (chart ticks, quotes): alerts hang off this feed. */
export function onAnyPrice(fn: (symbol: string, price: number) => void): () => void {
  priceListeners.add(fn);
  return () => priceListeners.delete(fn);
}
const lastPrices = new Map<string, number>();
let account: PaperAccount = load();

function fresh(balance = DEFAULT_BALANCE): PaperAccount {
  return { startBalance: balance, balance, positions: [], orders: [], history: [] };
}

function load(): PaperAccount {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fresh();
    const doc = JSON.parse(raw) as PaperAccount;
    if (!Number.isFinite(doc.balance) || !Array.isArray(doc.positions)) return fresh();
    return {
      startBalance: doc.startBalance ?? DEFAULT_BALANCE,
      balance: doc.balance,
      positions: doc.positions ?? [],
      orders: doc.orders ?? [],
      history: doc.history ?? [],
    };
  } catch {
    return fresh();
  }
}

function save(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(account));
  } catch {
    /* quota / private mode */
  }
}

function changed(): void {
  save();
  for (const fn of listeners) fn();
}

const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Symbols are compared loosely: `hyperliquid:xyz:GOLD` matches `xyz:GOLD`. */
export function sameSymbol(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.endsWith(`:${y}`) || y.endsWith(`:${x}`);
}

export function onPaperChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAccount(): Readonly<PaperAccount> {
  return account;
}

export function lastPrice(symbol: string): number | undefined {
  const direct = lastPrices.get(symbol);
  if (direct != null) return direct;
  for (const [k, v] of lastPrices) if (sameSymbol(k, symbol)) return v;
  return undefined;
}

export function positionFor(symbol: string): PaperPosition | undefined {
  return account.positions.find((p) => sameSymbol(p.symbol, symbol));
}

export function unrealized(p: PaperPosition): number | undefined {
  const px = lastPrice(p.symbol);
  if (px == null) return undefined;
  return (px - p.avgPrice) * p.qty;
}

export function totals(): {
  balance: number;
  equity: number;
  realized: number;
  unrealized: number;
} {
  let u = 0;
  for (const p of account.positions) u += unrealized(p) ?? 0;
  return {
    balance: account.balance,
    equity: account.balance + u,
    realized: account.balance - account.startBalance,
    unrealized: u,
  };
}

/** Apply a fill to the netting position; returns realized P&L. */
function applyFill(
  symbol: string,
  side: Side,
  qty: number,
  price: number,
  reason: string,
  bracket?: { tp?: number; sl?: number },
): number {
  const d = side === 'buy' ? qty : -qty;
  let pos = positionFor(symbol);
  let realized = 0;

  if (!pos) {
    pos = { symbol, qty: d, avgPrice: price, openedAt: Date.now(), ...bracket };
    account.positions.push(pos);
  } else if (Math.sign(pos.qty) === Math.sign(d)) {
    const total = Math.abs(pos.qty) + qty;
    pos.avgPrice = (pos.avgPrice * Math.abs(pos.qty) + price * qty) / total;
    pos.qty += d;
    if (bracket?.tp != null) pos.tp = bracket.tp;
    if (bracket?.sl != null) pos.sl = bracket.sl;
  } else {
    const closing = Math.min(Math.abs(pos.qty), qty);
    realized = closing * (price - pos.avgPrice) * Math.sign(pos.qty);
    account.balance += realized;
    const next = pos.qty + d;
    if (Math.abs(next) < 1e-12) {
      account.positions = account.positions.filter((p) => p !== pos);
    } else if (Math.sign(next) !== Math.sign(pos.qty)) {
      // Reversal: the remainder opens fresh at this price.
      pos.qty = next;
      pos.avgPrice = price;
      pos.openedAt = Date.now();
      pos.tp = bracket?.tp;
      pos.sl = bracket?.sl;
    } else {
      pos.qty = next;
    }
  }

  account.history.unshift({ id: uid(), symbol, side, qty, price, time: Date.now(), realized, reason });
  if (account.history.length > HISTORY_CAP) account.history.length = HISTORY_CAP;
  return realized;
}

export type PlaceResult = { ok: true; message: string } | { ok: false; error: string };

export function placeOrder(req: OrderRequest): PlaceResult {
  if (!(req.qty > 0)) return { ok: false, error: 'Quantity must be above zero' };
  const px = lastPrice(req.symbol);
  const isBuy = req.side === 'buy';
  const ref = req.type === 'market' ? px : req.price;
  if (ref == null || !(ref > 0)) {
    return { ok: false, error: req.type === 'market' ? 'No live price yet for this symbol' : 'Enter a price' };
  }
  if (req.tp != null && (isBuy ? req.tp <= ref : req.tp >= ref)) {
    return { ok: false, error: `Take profit must be ${isBuy ? 'above' : 'below'} the entry` };
  }
  if (req.sl != null && (isBuy ? req.sl >= ref : req.sl <= ref)) {
    return { ok: false, error: `Stop loss must be ${isBuy ? 'below' : 'above'} the entry` };
  }

  const verb = isBuy ? 'Buy' : 'Sell';
  if (req.type === 'market') {
    applyFill(req.symbol, req.side, req.qty, ref, 'Market', { tp: req.tp, sl: req.sl });
    changed();
    return { ok: true, message: `${verb} ${req.qty} filled @ ${fmtPrice(ref)}` };
  }

  account.orders.push({
    id: uid(),
    symbol: req.symbol,
    side: req.side,
    type: req.type,
    qty: req.qty,
    price: ref,
    tp: req.tp,
    sl: req.sl,
    createdAt: Date.now(),
  });
  changed();
  // A limit already through the market fills on the next tick.
  if (px != null) onPrice(req.symbol, px);
  return { ok: true, message: `${verb} ${req.type} ${req.qty} @ ${fmtPrice(ref)} placed` };
}

export function cancelOrder(id: string): void {
  const before = account.orders.length;
  account.orders = account.orders.filter((o) => o.id !== id);
  if (account.orders.length !== before) changed();
}

export function cancelAllOrders(symbol?: string): void {
  account.orders = symbol ? account.orders.filter((o) => !sameSymbol(o.symbol, symbol)) : [];
  changed();
}

export function closePosition(symbol: string, reason = 'Close'): PlaceResult {
  const pos = positionFor(symbol);
  if (!pos) return { ok: false, error: 'No position' };
  const px = lastPrice(pos.symbol);
  if (px == null) return { ok: false, error: 'No live price yet for this symbol' };
  const realized = applyFill(pos.symbol, pos.qty > 0 ? 'sell' : 'buy', Math.abs(pos.qty), px, reason);
  changed();
  return { ok: true, message: `Closed @ ${fmtPrice(px)} · P&L ${fmtSigned(realized)}` };
}

export function reversePosition(symbol: string): PlaceResult {
  const pos = positionFor(symbol);
  if (!pos) return { ok: false, error: 'No position' };
  const px = lastPrice(pos.symbol);
  if (px == null) return { ok: false, error: 'No live price yet for this symbol' };
  applyFill(pos.symbol, pos.qty > 0 ? 'sell' : 'buy', Math.abs(pos.qty) * 2, px, 'Reverse');
  changed();
  return { ok: true, message: `Reversed @ ${fmtPrice(px)}` };
}

export function setBracket(symbol: string, patch: { tp?: number | null; sl?: number | null }): void {
  const pos = positionFor(symbol);
  if (!pos) return;
  if (patch.tp !== undefined) pos.tp = patch.tp ?? undefined;
  if (patch.sl !== undefined) pos.sl = patch.sl ?? undefined;
  changed();
}

export function resetAccount(balance = DEFAULT_BALANCE): void {
  account = fresh(balance);
  changed();
}

/** Feed a live price: updates P&L, fills working orders, triggers brackets. */
export function onPrice(symbol: string, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const prev = lastPrices.get(symbol);
  lastPrices.set(symbol, price);
  for (const fn of priceListeners) fn(symbol, price);
  let mutated = false;

  for (const o of [...account.orders]) {
    if (!sameSymbol(o.symbol, symbol)) continue;
    const buy = o.side === 'buy';
    const hit =
      o.type === 'limit' ? (buy ? price <= o.price : price >= o.price) : buy ? price >= o.price : price <= o.price;
    if (!hit) continue;
    account.orders = account.orders.filter((x) => x.id !== o.id);
    // Limits fill at their price or better (a limit already through the market takes the market).
    const fillAt = o.type === 'limit' ? (buy ? Math.min(price, o.price) : Math.max(price, o.price)) : price;
    applyFill(o.symbol, o.side, o.qty, fillAt, o.type === 'limit' ? 'Limit' : 'Stop', { tp: o.tp, sl: o.sl });
    mutated = true;
  }

  const pos = positionFor(symbol);
  if (pos) {
    const long = pos.qty > 0;
    const slHit = pos.sl != null && (long ? price <= pos.sl : price >= pos.sl);
    const tpHit = pos.tp != null && (long ? price >= pos.tp : price <= pos.tp);
    if (slHit || tpHit) {
      applyFill(pos.symbol, long ? 'sell' : 'buy', Math.abs(pos.qty), price, slHit ? 'Stop loss' : 'Take profit');
      mutated = true;
    }
  }

  if (mutated) changed();
  else if (prev !== price && (pos || account.orders.length)) for (const fn of listeners) fn();
}

export function fmtPrice(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: abs >= 1 ? 2 : 0, maximumFractionDigits: digits });
}

export function fmtMoney(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtSigned(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${fmtMoney(Math.abs(n))}`;
}
