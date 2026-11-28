/**
 * Installable app: registers the service worker (`public/sw.js`) in production
 * builds only, so Vite dev / HMR is never served from a cache.
 */
export function registerPwa(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err: unknown) => {
      console.warn('[pwa] service worker registration failed', err);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
