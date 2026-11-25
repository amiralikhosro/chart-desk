import { registerWidgetAction } from '@luxalgo/vela/plugin';
import type { WorkspaceWidgetContext } from '@luxalgo/vela/workspace';

/** TradingView-style Bar Replay — rewinds ~30 days and plays forward. */
export function registerReplayAction(): void {
  registerWidgetAction({
    id: 'desk.replay',
    target: 'topbar',
    label: 'Bar Replay',
    icon: 'replay',
    iconOnly: true,
    align: 'right',
    order: 28,
    run: async (ctx) => {
      const wctx = ctx as WorkspaceWidgetContext;
      const replay = wctx.replay;
      if (!replay) return;

      if (replay.state.active) {
        replay.stop();
        return;
      }

      const from = Date.now() - 30 * 86_400_000;
      try {
        await replay.start({ from });
        replay.play(400);
      } catch (err) {
        console.warn('[replay]', err);
      }
    },
  });
}
