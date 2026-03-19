// ── TUI Module — Public API ──
// createTUI() wires state + renderer + input into a dispatch loop.

export type {
  TUIState,
  Action,
  ScrollLine,
  ScrollCategory,
  Overlay,
  Zone,
  InputMode,
  Layout,
  ZoneLayout,
  TUI,
  TUIOptions,
} from './types';

export { createInitialState, update } from './state';
export { computeLayout, minRows, stripAnsi, visibleWidth, truncateVisible } from './zones';
export { Renderer } from './renderer';
export { InputHandler } from './input';

import type { TUI, TUIOptions, TUIState, Action } from './types';
import { createInitialState, update } from './state';
import { Renderer } from './renderer';
import { InputHandler } from './input';

export function createTUI(opts?: TUIOptions): TUI {
  const transcriptLines = opts?.transcriptLines ?? 3;

  let state: TUIState = createInitialState(opts);
  const renderer = new Renderer(transcriptLines);
  const input = new InputHandler(dispatch);

  // Microtask batching: accumulate rapid actions, render once per tick
  let renderScheduled = false;
  let initialized = false;

  function dispatch(action: Action): void {
    state = update(state, action, opts);

    // After input actions, sync text to input handler (for submit callback)
    if (action.type.startsWith('INPUT_')) {
      input.syncText(state.input.text);
    }

    // Schedule a render on the next microtask (batches rapid actions)
    if (!renderScheduled && initialized) {
      renderScheduled = true;
      queueMicrotask(() => {
        renderScheduled = false;
        renderer.render(state);
        // Clear dirty flags after render
        state = { ...state, dirty: new Set() };
      });
    }
  }

  function init(): void {
    initialized = true;
    state = update(state, {
      type: 'RESIZE',
      rows: process.stdout.rows || 24,
      cols: process.stdout.columns || 80,
    });

    // Full render on init
    renderer.renderFull(state);
    state = { ...state, dirty: new Set() };

    // Start raw input
    input.start();

    // Listen for terminal resize
    process.stdout.on('resize', () => {
      dispatch({
        type: 'RESIZE',
        rows: process.stdout.rows || 24,
        cols: process.stdout.columns || 80,
      });
      // Resize needs a full re-render (not incremental)
      renderer.renderFull(state);
      state = { ...state, dirty: new Set() };
    });
  }

  function teardown(): void {
    initialized = false;
    input.stop();
    // Reset scroll region to full terminal
    process.stdout.write('\x1b[r');
    // Move to bottom
    process.stdout.write(`\x1b[${state.rows};1H\n`);
    // Show cursor
    process.stdout.write('\x1b[?25h');
  }

  return {
    dispatch,
    getState: () => state,
    onSubmit: (handler) => input.onSubmit(handler),
    onSignal: (handler) => input.onSignal(handler),
    init,
    teardown,
  };
}
