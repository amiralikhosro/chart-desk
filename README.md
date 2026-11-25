# Chart Desk

A TradingView-style chart terminal on [Vela](https://vela.dev/) — free live crypto data, Pine Script®, watchlist, and bar replay.

## Feel

- **TradingView dark theme** (`#131722` canvas, `#2962FF` accent, teal/red candles)
- **Watchlist** (right rail) — gold, BTC, ETH, SOL across LBank / Binance / Coinbase / Hyperliquid
- **Pine Editor** — paste scripts, add to chart; edit any study from its legend ✎
- **Bar Replay** — topbar button rewinds ~30 days and plays forward
- Multi-chart layouts, drawings, indicators, alerts, data window
- Defaults: EMA 20 / 50 + RSI 14 (MACD, Bollinger, Stoch, VWAP, EMA 200 in the picker)

## Gold on LBank

| Symbol | What it is | History | Live |
|--------|------------|---------|------|
| `lbank:GOLDUSDT.P` | GOLDUSDT USDT-M perpetual | OKX XAU-USDT-SWAP | LBank lastPrice 1s |
| `lbank:XAUTUSDT` | Spot Tether Gold | LBank public klines | LBank WebSocket |

## Develop

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Run on another machine

**Option A — full source** (Node 18+):

```bash
npm install
npm run build
npm start
```

Open http://127.0.0.1:4173/

**Option B — portable tarball** (built here, run elsewhere):

```bash
npm run pack
# copies → release/  and  chart-desk-*.tar.gz
```

On the other system:

```bash
tar -xzf chart-desk-0.1.0.tar.gz
cd release
npm install --omit=dev
npm start
```

Optional: `HOST=0.0.0.0 PORT=8080 npm start` to listen on all interfaces.

The production server serves `dist/` and proxies LBank REST/WebSocket (needed because LBank has no CORS).

## Shortcuts

| Key | Action |
|-----|--------|
| `?` | Keyboard help |
| `/` | Indicators |
| letter / `0` | Symbol search |
| `1`–`9` | Timeframe entry |
| Layout menu | Multi-chart grids (`2h`, `2v`, `4`, …) |

Pine Script® is a trademark of TradingView, Inc. Vela PineTS is AGPL-3.0.
