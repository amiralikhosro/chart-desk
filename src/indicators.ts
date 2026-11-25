/** Pine library (opt-in). Defaults are native studies — see seedNativeDefaults in main. */
export const DEFAULT_INDICATORS = [
  {
    name: 'EMA 20',
    language: 'pine' as const,
    enabled: false,
    script: `//@version=5
indicator("EMA 20", overlay=true)
plot(ta.ema(close, 20), "EMA 20", color=#ff9800, linewidth=2)`,
  },
  {
    name: 'EMA 50',
    language: 'pine' as const,
    enabled: false,
    script: `//@version=5
indicator("EMA 50", overlay=true)
plot(ta.ema(close, 50), "EMA 50", color=#2196f3, linewidth=2)`,
  },
  {
    name: 'EMA 200',
    language: 'pine' as const,
    enabled: false,
    script: `//@version=5
indicator("EMA 200", overlay=true)
plot(ta.ema(close, 200), "EMA 200", color=#9c27b0, linewidth=2)`,
  },
  {
    name: 'RSI 14',
    language: 'pine' as const,
    enabled: false,
    script: `//@version=5
indicator("RSI 14", overlay=false)
r = ta.rsi(close, 14)
plot(r, "RSI", color=#7e57c2, linewidth=2)
hline(70, "OB", color=#ef5350, linestyle=hline.style_dotted)
hline(30, "OS", color=#26a69a, linestyle=hline.style_dotted)
hline(50, "Mid", color=#787b86, linestyle=hline.style_dotted)`,
  },
  {
    name: 'MACD',
    language: 'pine' as const,
    enabled: false,
    script: `//@version=5
indicator("MACD", overlay=false)
[macdLine, signalLine, hist] = ta.macd(close, 12, 26, 9)
plot(macdLine, "MACD", color=#2962FF)
plot(signalLine, "Signal", color=#ff6d00)
plot(hist, "Hist", color=#26a69a, style=plot.style_histogram)`,
  },
  {
    name: 'Bollinger Bands',
    language: 'pine' as const,
    enabled: false,
    script: `//@version=5
indicator("Bollinger Bands", overlay=true)
len = 20
mult = 2.0
basis = ta.sma(close, len)
dev = mult * ta.stdev(close, len)
plot(basis, "Basis", color=#2962FF)
p1 = plot(basis + dev, "Upper", color=#2962FF)
p2 = plot(basis - dev, "Lower", color=#2962FF)
fill(p1, p2, color=color.new(#2962FF, 90))`,
  },
  {
    name: 'Stochastic',
    language: 'pine' as const,
    enabled: false,
    script: `//@version=5
indicator("Stochastic", overlay=false)
k = ta.stoch(close, high, low, 14)
d = ta.sma(k, 3)
plot(k, "%K", color=#2962FF)
plot(d, "%D", color=#ff6d00)
hline(80)
hline(20)`,
  },
  {
    name: 'VWAP',
    language: 'pine' as const,
    enabled: false,
    script: `//@version=5
indicator("VWAP", overlay=true)
plot(ta.vwap(hlc3), "VWAP", color=#ffeb3b, linewidth=2)`,
  },
];
