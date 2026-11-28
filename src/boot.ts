/**
 * Entry point: bring the server's copy of the app state into localStorage first (the
 * stores read it when they load), then start the app.
 */
import { bootstrapState } from './lib/state-sync';

void bootstrapState()
  .catch((err) => console.warn('[state-sync]', err))
  .finally(() => import('./main'));
