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

## Your data lives on the server

Everything the app remembers (layouts, alerts, the paper and practice accounts, watchlists and flags, journal notes, indicator templates, the workspace) is mirrored to the server in `data/state/` and shared by every browser and device that opens the desk. Newest change wins per item; changes made elsewhere show up live. The server also keeps the last 20 versions of each item in `data/state/.history/<key>/` (copy one back over `data/state/<key>.json` to restore). A browser that syncs for the first time keeps the data it already has. Journal screenshots are stored in `data/blobs/`.

The dev server uses its own folder (`data/dev/`, or `DESK_DEV_DATA`), so testing never touches the real desk.

## Alerts on the server and your phone

The server evaluates the alerts itself every 4 s, so they fire with every browser closed; open browsers still show the popup and chime. For phone notifications install the free **ntfy** app, subscribe to a long random topic, and enter it under Alerts → *Phone notifications* (or set `NTFY_TOPIC`). *Send test* checks it end to end. The Alerts panel footer says whether the server is running them.

## Practice in Bar Replay

Start Bar Replay and the trading panel switches to a separate **practice account** (amber, "Practice · Bar Replay"): Buy / Sell, limits, stops and brackets trade the replayed bars at replay time, with limits and stops filling on each bar's wicks. Stopping the replay returns to the live paper account and toasts the session result. The practice account persists between sessions; *Reset* clears it.

## Desk plan → paper order

Top bar → **Desk plan** shows the trade desk's long and short plans for the charted coin (verdict, entry, stop, target, R:R, replay edge, how old the export is) and places either as a paper bracket in one click, sized so the stop loses your chosen % of equity (default 1 %). Entries beyond the market go in as stop orders.

## Login (optional)

Set `DESK_AUTH=user:password` (see `docker-compose.yml`) to require a login for the whole app, recommended if you open it from outside your own network. The desk exporter keeps pushing with `DESK_TOKEN`.

## Price alerts

**Alt+A**, the top-bar **Alert** button, or right-click the chart / price scale → *Add alert at this price…*. Conditions: Crossing, Crossing Up, Crossing Down, Greater Than, Less Than; trigger *Only once* or *Once per minute*; expiry (open-ended, 1 hour … 1 month); message; sound; desktop notification. Active alerts draw a dashed amber line with a 🔔 tag on the chart. When one fires: a popup (bottom right, with *Open chart*), a chime, and a desktop notification if allowed. The **Alerts** side panel lists alerts (stop / restart, edit, remove) and the **Log** of everything that fired. Prices come from every feed the app already runs (chart, watchlist, quotes) and a 4 s poll for symbols nothing else is pricing. Select a horizontal line, ray or trend line and use the 🔔 button on its toolbar to alert on the line itself (a trend-line alert's level moves along the line).

## Screener

Right sidebar → **Screener**: every LBank USDT perp, every Hyperliquid perp and Hyperliquid's commodities (gold, silver, oil…), with All / Top gainers / Top losers / Most active tabs, source chips, search, sortable columns, click to chart, + to add to the watchlist. US stock tokens are hidden. Refreshes every 10 s while open.

## Order book

Right sidebar → **Order Book**: the live book of the charted symbol (Hyperliquid, LBank or Coinbase; LBank perps without a public book use the same fallback as their history, shown in the header). Price grouping, cumulative depth bars, spread. Click a level to open the paper ticket with a limit at that price.

## Strategy Tester

Appears under the chart while a Pine `strategy()` runs: **Overview** (net profit, closed trades, percent profitable, profit factor, max drawdown, average trade, bars in trade, equity curve), **Performance Summary** (all / long / short, Sharpe, Sortino, buy & hold) and **List of trades** (click a trade to jump to it).

## Chart extras

- Bottom bar: **Go to** (calendar icon or **Alt+G**: a date, or a custom range; older history is loaded as needed) and the **%** / **log** / **auto** price-scale toggles.
- Time-axis events: high- and medium-impact USD releases (and high-impact EUR/GBP/JPY/CNY) from the calendar, and your paper fills (B / S). Toggle each in chart settings → Events.

## Compare symbols

Top bar → **Compare**. Search any symbol (or pick from your watchlist) and press Enter; add as many as you like, remove them from the same dialog or the legend. Each compared market is drawn over the price pane, rebased so every line starts together at the left edge of the view (TradingView's percent-compare look). The legend and the tag at the right edge show each one's % change since that point; scroll or zoom and the start point follows. Each compare is an indicator with a Symbol / Color / Line width setting, so it is saved with the chart and with layouts.

## Saved layouts

Top-right button showing the layout name ("Unsaved" until you save). **Ctrl+S** saves; the menu has Save as new, Rename, Autosave (on by default: the current layout follows every change), load, delete (click ✕ twice), and Export / Import a layout as a `.chart-desk.json` file. A layout stores the full workspace: grid, symbols, timeframes, indicators and compares, drawings and chart settings. Layouts live in the browser's localStorage (`chart-desk-layouts-v1`), so export the ones you want to keep across browsers.

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
| `Alt`+`A` | Create alert |
| `Alt`+`G` | Go to date |
| `Ctrl`+`S` | Save layout |
| `Shift`+`B` / `Shift`+`S` | Paper buy / sell ticket |
| `Alt`+`T` / `Alt`+`H` / `Alt`+`V` | Trend line / horizontal line / vertical line |
| `Alt`+`S` | Screenshot |
| `Alt`+`Enter` | Full screen |

Pine Script® is a trademark of TradingView, Inc. Vela PineTS is AGPL-3.0.
