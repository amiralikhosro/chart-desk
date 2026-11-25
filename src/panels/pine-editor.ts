import {
  registerIcon,
  registerLegendAction,
  registerSidePanel,
  registerWidgetAction,
} from '@luxalgo/vela/plugin';

registerIcon(
  'desk-pine',
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 3h8v10H4z"/><path d="M6 6h4M6 8.5h4M6 11h2.5"/></svg>',
);

const SAMPLE = `//@version=5
indicator("My Script", overlay=true)
plot(ta.sma(close, 20), "SMA 20", color=color.blue, linewidth=2)`;

let editorRef: {
  setSource: (src: string) => void;
  focus: () => void;
} | null = null;

export function registerPineEditor(): void {
  registerSidePanel({
    id: 'desk.pine',
    title: 'Pine Editor',
    icon: 'desk-pine',
    order: 8,
    width: 420,
    resizable: true,
    minWidth: 320,
    maxWidth: 720,
    overlay: true,
    maximizable: true,
    placement: 'column',
    mount: (ctx, body) => {
      body.className = 'desk-panel desk-pine';
      body.innerHTML = `
        <div class="desk-pine__toolbar">
          <span class="desk-pine__label">Pine Script®</span>
          <div class="desk-pine__actions">
            <button type="button" class="desk-pine__btn" data-act="sample">Sample</button>
            <button type="button" class="desk-pine__btn desk-pine__btn--primary" data-act="add">Add to chart</button>
          </div>
        </div>
        <textarea class="desk-pine__code" spellcheck="false" aria-label="Pine Script source"></textarea>
        <div class="desk-pine__status" role="status"></div>
      `;

      const ta = body.querySelector('.desk-pine__code') as HTMLTextAreaElement;
      const status = body.querySelector('.desk-pine__status') as HTMLDivElement;
      ta.value = SAMPLE;
      ta.placeholder = SAMPLE;

      editorRef = {
        setSource: (src) => {
          ta.value = src;
        },
        focus: () => ta.focus(),
      };

      const setStatus = (msg: string, kind: 'ok' | 'err' | '') => {
        status.textContent = msg;
        status.dataset.kind = kind;
      };

      body.querySelector('[data-act="sample"]')!.addEventListener('click', () => {
        ta.value = SAMPLE;
        setStatus('Loaded sample SMA 20', 'ok');
      });

      body.querySelector('[data-act="add"]')!.addEventListener('click', () => {
        const source = ta.value.trim();
        if (!source) {
          setStatus('Paste a script first', 'err');
          return;
        }
        try {
          const handle = ctx.chart.addIndicator(source, { language: 'pine' });
          setStatus('Added — computing…', 'ok');
          handle.on('ready', () => setStatus('Running on chart', 'ok'));
          handle.on('error', ({ error }) => setStatus(error.message, 'err'));
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err), 'err');
        }
      });

      return {
        onOpen: () => ta.focus(),
        destroy: () => {
          editorRef = null;
        },
      };
    },
  });

  registerWidgetAction({
    id: 'desk.pine-open',
    target: 'topbar',
    label: 'Pine Editor',
    icon: 'desk-pine',
    iconOnly: true,
    align: 'right',
    order: 25,
    run: (ctx) => ctx.togglePanel('desk.pine', true),
  });

  registerLegendAction({
    id: 'desk.pine-edit',
    icon: 'pen',
    tooltip: 'Edit in Pine Editor',
    when: (ind) => ind.language === 'pine' && !!ind.source,
    run: (ctx, ind) => {
      if (ind.source) editorRef?.setSource(ind.source);
      ctx.togglePanel('desk.pine', true);
      requestAnimationFrame(() => editorRef?.focus());
    },
  });
}
