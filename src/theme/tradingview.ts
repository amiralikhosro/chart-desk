import { checkTheme, createTheme, registerTheme } from '@luxalgo/vela';

/**
 * TradingView dark desk — canvas #131722, accent #2962FF, teal/red candles,
 * dense chrome tokens traders muscle-memorize.
 */
const input = {
  base: 'dark' as const,
  accent: '#2962FF',
  radius: 'sm' as const,
  font: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
  colors: {
    background: '#131722',
    text: '#d1d4dc',
    grid: '#2a2e39',
    border: '#2a2e39',
    up: '#089981',
    down: '#f23645',
    accent: '#2962FF',
  },
  tokens: {
    bg: '#131722',
    fg: '#d1d4dc',
    'fg-muted': '#787b86',
    'fg-faint': '#5d606b',
    'fg-bright': '#f0f3fa',
    surface: '#1e222d',
    'surface-elev': '#2a2e39',
    'surface-overlay': '#2a2e39',
    'surface-sunken': '#0c0e15',
    border: '#2a2e39',
    'border-strong': '#363a45',
    'border-soft': '#1e222d',
    'border-faint': '#1a1e29',
    hover: '#2a2e39',
    active: '#363a45',
    'hover-strong': '#363a45',
    accent: '#2962FF',
    'accent-bright': '#1e53e5',
    highlight: '#2962FF',
    'selected-bg': 'rgba(41, 98, 255, 0.18)',
    'selected-fg': '#f0f3fa',
    up: '#089981',
    down: '#f23645',
    profit: '#089981',
    loss: '#f23645',
    danger: '#f23645',
    focus: '#2962FF',
    'focus-soft': 'rgba(41, 98, 255, 0.35)',
  },
};

const problems = checkTheme(input);
if (problems.length) console.warn('[theme]', problems);

export const tradingViewTheme = createTheme(input);

registerTheme({
  id: 'tradingview',
  label: 'TradingView',
  theme: tradingViewTheme,
});
