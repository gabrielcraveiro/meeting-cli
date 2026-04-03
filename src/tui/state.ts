// ── State Management (Model + Update) ──
// Pure functions only — no I/O, no side effects.

import type { TUIState, Action, TUIOptions } from './types';

const DEFAULTS: Required<TUIOptions> = {
  transcriptLines: 3,
  maxScrollBuffer: 500,
};

export function createInitialState(opts?: TUIOptions): TUIState {
  const o = { ...DEFAULTS, ...opts };
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,

    recording: {
      active: false,
      elapsed: 0,
      segments: 0,
      cost: 0,
      extra: '',
      templateLabel: '',
      topicLabel: '',
    },

    transcript: {
      lines: [],
      maxVisible: o.transcriptLines,
    },

    scroll: {
      lines: [],
    },

    input: {
      text: '',
      cursorPos: 0,
      mode: 'normal',
      hint: null,
      history: [],
      historyIndex: -1,
    },

    overlays: [],

    dirty: new Set(['header', 'transcript', 'scroll', 'footer']),
  };
}

// ── Reducer ──
// Returns a new state object with dirty flags indicating what changed.
// Never mutates the input state.

export function update(state: TUIState, action: Action, opts?: TUIOptions): TUIState {
  const maxScroll = opts?.maxScrollBuffer ?? DEFAULTS.maxScrollBuffer;

  switch (action.type) {

    // ── Terminal ──

    case 'RESIZE': {
      return {
        ...state,
        rows: action.rows,
        cols: action.cols,
        dirty: new Set(['header', 'transcript', 'scroll', 'footer', 'overlay']),
      };
    }

    // ── Recording header ──

    case 'TICK': {
      return {
        ...state,
        recording: {
          ...state.recording,
          active: true,
          elapsed: action.elapsed,
          segments: action.segments,
          cost: action.cost,
        },
        dirty: new Set([...state.dirty, 'header']),
      };
    }

    case 'SET_LABELS': {
      return {
        ...state,
        recording: {
          ...state.recording,
          templateLabel: action.template,
          topicLabel: action.topic,
        },
        dirty: new Set([...state.dirty, 'header']),
      };
    }

    case 'SET_EXTRA': {
      return {
        ...state,
        recording: {
          ...state.recording,
          extra: action.extra,
        },
        dirty: new Set([...state.dirty, 'header']),
      };
    }

    // ── Transcript zone ──

    case 'TRANSCRIPT_LINE': {
      const lines = [...state.transcript.lines, action.text];
      return {
        ...state,
        transcript: { ...state.transcript, lines },
        dirty: new Set([...state.dirty, 'transcript']),
      };
    }

    // ── Scroll region ──

    case 'SCROLL_APPEND': {
      const scrollLines = [...state.scroll.lines, action.line];
      // Priority trim: discard insight/system lines first, then fall back to FIFO
      if (scrollLines.length > maxScroll) {
        const toRemove = scrollLines.length - maxScroll;
        let removed = 0;
        for (let i = 0; i < scrollLines.length && removed < toRemove; i++) {
          const cat = scrollLines[i].category;
          if (cat === 'insight' || cat === 'system') {
            scrollLines.splice(i, 1);
            i--;
            removed++;
          }
        }
        if (scrollLines.length > maxScroll) {
          scrollLines.splice(0, scrollLines.length - maxScroll);
        }
      }
      return {
        ...state,
        scroll: { lines: scrollLines },
        dirty: new Set([...state.dirty, 'scroll']),
      };
    }

    case 'SCROLL_CLEAR': {
      return {
        ...state,
        scroll: { lines: [] },
        dirty: new Set([...state.dirty, 'scroll']),
      };
    }

    // ── Input ──

    case 'INPUT_CHAR': {
      const { text, cursorPos } = state.input;
      const newText = text.slice(0, cursorPos) + action.char + text.slice(cursorPos);
      return {
        ...state,
        input: {
          ...state.input,
          text: newText,
          cursorPos: cursorPos + action.char.length,
          historyIndex: -1,
        },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_BACKSPACE': {
      const { text, cursorPos } = state.input;
      if (cursorPos === 0) return state;
      const newText = text.slice(0, cursorPos - 1) + text.slice(cursorPos);
      return {
        ...state,
        input: {
          ...state.input,
          text: newText,
          cursorPos: cursorPos - 1,
        },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_DELETE': {
      const { text, cursorPos } = state.input;
      if (cursorPos >= text.length) return state;
      const newText = text.slice(0, cursorPos) + text.slice(cursorPos + 1);
      return {
        ...state,
        input: { ...state.input, text: newText },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_SUBMIT': {
      const submittedText = state.input.text;
      const newHistory = submittedText.trim()
        ? [...state.input.history, submittedText]
        : state.input.history;
      // Keep last 50 entries
      if (newHistory.length > 50) newHistory.splice(0, newHistory.length - 50);
      return {
        ...state,
        input: {
          ...state.input,
          text: '',
          cursorPos: 0,
          history: newHistory,
          historyIndex: -1,
        },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_CURSOR_LEFT': {
      const pos = state.input.cursorPos;
      if (pos === 0) return state;
      return {
        ...state,
        input: { ...state.input, cursorPos: pos - 1 },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_CURSOR_RIGHT': {
      const { text, cursorPos } = state.input;
      if (cursorPos >= text.length) return state;
      return {
        ...state,
        input: { ...state.input, cursorPos: cursorPos + 1 },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_CURSOR_HOME': {
      return {
        ...state,
        input: { ...state.input, cursorPos: 0 },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_CURSOR_END': {
      return {
        ...state,
        input: { ...state.input, cursorPos: state.input.text.length },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_HISTORY_PREV': {
      const { history, historyIndex } = state.input;
      if (history.length === 0) return state;
      const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
      const historyText = history[history.length - 1 - newIndex];
      return {
        ...state,
        input: {
          ...state.input,
          text: historyText,
          cursorPos: historyText.length,
          historyIndex: newIndex,
        },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_HISTORY_NEXT': {
      const { history, historyIndex } = state.input;
      if (historyIndex <= 0) {
        // Back to current (empty) input
        return {
          ...state,
          input: {
            ...state.input,
            text: '',
            cursorPos: 0,
            historyIndex: -1,
          },
          dirty: new Set([...state.dirty, 'footer']),
        };
      }
      const newIndex = historyIndex - 1;
      const historyText = history[history.length - 1 - newIndex];
      return {
        ...state,
        input: {
          ...state.input,
          text: historyText,
          cursorPos: historyText.length,
          historyIndex: newIndex,
        },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_SET_MODE': {
      return {
        ...state,
        input: { ...state.input, mode: action.mode },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    case 'INPUT_SET_HINT': {
      return {
        ...state,
        input: { ...state.input, hint: action.hint },
        dirty: new Set([...state.dirty, 'footer']),
      };
    }

    // ── Overlays ──

    case 'OVERLAY_PUSH': {
      return {
        ...state,
        overlays: [...state.overlays, action.overlay],
        dirty: new Set([...state.dirty, 'overlay']),
      };
    }

    case 'OVERLAY_POP': {
      if (state.overlays.length === 0) return state;
      const overlays = action.id
        ? state.overlays.filter(o => o.id !== action.id)
        : state.overlays.slice(0, -1);
      return {
        ...state,
        overlays,
        // When overlay is removed, redraw scroll underneath
        dirty: new Set([...state.dirty, 'overlay', 'scroll']),
      };
    }

    case 'OVERLAY_CLEAR': {
      if (state.overlays.length === 0) return state;
      return {
        ...state,
        overlays: [],
        dirty: new Set([...state.dirty, 'overlay', 'scroll']),
      };
    }

    default:
      return state;
  }
}
