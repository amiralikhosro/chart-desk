# Chart Desk

A TradingView-style chart terminal on [Vela](https://vela.dev/) — free live crypto data, Pine Script®, watchlist, and bar replay.

## Feel

- **TradingView dark theme** (`#131722` canvas, `#2962FF` accent, teal/red candles)
- **Watchlist** (right rail) — gold, BTC, ETH, SOL across LBank / Binance / Coinbase / Hyperliquid
- **Pine Editor** — paste scripts, add to chart; edit any study from its legend ✎
- **Bar Replay** — topbar button rewinds ~30 days and plays forward
- Multi-chart layouts, drawings, indicators, alerts, data window
- Defaults: EMA 20 / 50 + RSI 14 (MACD, Bollinger, Stoch, VWAP, EMA 200 in the picker)
- **Paper Trading** (bottom panel) — balance, equity, realized / unrealized P&L; Positions, Orders, History tabs; edit TP / SL inline, close or reverse. Stored in the browser only, never sent to a broker
- **Buy / Sell on the chart** — live price, quantity box; click opens the order ticket, **Shift+click** sends an instant market order. `Shift+B` / `Shift+S` open the ticket
- **Order ticket** — Market / Limit / Stop, take profit and stop loss, value, risk, reward and R:R before you send
- **Right-click the chart** → *Buy / Sell at this price…* (limit or stop is picked from where you clicked)
- **Position lines** — avg price with live P&L, TP, SL and working orders drawn on the chart with tags
- **Symbol details** under the watchlist — last price, change, day's range, volume, prev close, 1W / 1M / 3M / 6M / YTD / 1Y performance

## LBank sync

| | Spot (`lbank:BTCUSDT`) | Perpetual (`lbank:BTCUSDT.P`, ~840 listed) |
|---|---|---|
| History | LBank klines, paged forward 2000 bars a call | same coin's LBank spot klines, else Hyperliquid (gold: OKX XAU-USDT-SWAP → HL xyz:GOLD) |
| Live | LBank WebSocket `kbar` (true OHLCV) + `tick` between kbars; REST polling only if the socket stalls | one shared poll of LBank perp `marketData` per second; volume = growth of the 24h counter |
| Buckets | LBank's UTC+8 calendar (daily bars open 16:00 UTC) | same |

2h is built from 1h (LBank REST has no 2h klines; the socket does).

**Docker:** the container runs with `network_mode: host` so the LBank / OKX proxy uses the host's route (VPN). A bridged container times out on LBank.

## Symbol search

- Source chips under the category tabs: **All sources · Hyperliquid · LBank · Coinbase** (remembered; typing `lbank btc` does the same)
- Same coin grouped across venues: watchlist first, majors, USD/USDT quotes, perps before spot, lookalikes last

## Gold on LBank

| Symbol | What it is | History | Live |
|--------|------------|---------|------|
| `lbank:GOLDUSDT.P` | GOLDUSDT USDT-M perpetual | OKX XAU-USDT-SWAP | LBank lastPrice 1s |
| `lbank:XAUTUSDT` | Spot Tether Gold | LBank public klines | LBank WebSocket |

## News & Calendar

Right sidebar → **News & Calendar** (newspaper icon).

- **Headlines** from Cointelegraph, CoinDesk, Decrypt, The Block, CryptoSlate, Investing.com commodities, FX Empire, MarketWatch and the Federal Reserve. Filters: All / Crypto / Gold & Macro / the coin on the chart. Each headline is tagged (BTC, ETH, GOLD, FED, CPI…). Unread stories from the last 6h get a blue edge. Refreshes every 2 min.
- **Calendar**: this week's ForexFactory calendar in your timezone, with impact (High/Medium/Low/Holiday) and currency filters (default USD, High + Medium), forecast and previous values, a "Now" line and a countdown to the next high-impact release. Next week's calendar appears on Sunday.
- The browser can't read these feeds directly (no CORS), so the server proxies them at `/feeds/*` (`feeds.mjs`, used by both `server.mjs` and `vite dev`). News is cached 3 min and the calendar 60 min, in memory and in `data/feeds-cache.json`; a failed upstream serves the last good copy. ForexFactory blocks IPs that poll too often (HTTP 429), so the calendar makes one request per hour and only falls back to the XML copy when the JSON one fails.

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
