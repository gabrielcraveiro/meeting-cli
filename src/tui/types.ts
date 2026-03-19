// ── TUI Type Definitions ──
// Pure interfaces — no runtime code, no dependencies.

export type Zone = 'header' | 'transcript' | 'scroll' | 'footer' | 'overlay';

export type InputMode = 'normal' | 'busy' | 'finalizing';

export type ScrollCategory =
  | 'chat-user'
  | 'chat-ai'
  | 'insight'
  | 'system'
  | 'error'
  | 'separator'
  | 'formatted';  // pre-formatted with chalk — renderer just indents

export interface ScrollLine {
  text: string;
  category: ScrollCategory;
  timestamp?: number;  // elapsed seconds when line was added
}

export interface Overlay {
  id: string;
  title: string;
  lines: string[];
  position: 'center' | 'right';
  width: number;   // percentage of cols (e.g., 70 = 70%)
  height: number;  // percentage of rows
  dismissKey?: string;  // default: Escape
  autoDismissMs?: number;  // auto-close after N ms (for insights)
}

export interface TUIState {
  // Terminal dimensions
  rows: number;
  cols: number;

  // Recording header
  recording: {
    active: boolean;
    elapsed: number;
    segments: number;
    cost: number;
    extra: string;
    templateLabel: string;
    topicLabel: string;
  };

  // Transcript zone (compact, last N lines)
  transcript: {
    lines: string[];
    maxVisible: number;
  };

  // Scroll content (chat + insights + system messages)
  scroll: {
    lines: ScrollLine[];
  };

  // Input state
  input: {
    text: string;
    cursorPos: number;
    mode: InputMode;
    hint: string | null;
    history: string[];
    historyIndex: number;  // -1 = current input, 0+ = browsing history
  };

  // Overlay stack (topmost = last)
  overlays: Overlay[];

  // Dirty flags — which zones need redrawing
  dirty: Set<Zone>;
}

// ── Actions ──

export type Action =
  // Terminal
  | { type: 'RESIZE'; rows: number; cols: number }

  // Recording header
  | { type: 'TICK'; elapsed: number; segments: number; cost: number }
  | { type: 'SET_LABELS'; template: string; topic: string }
  | { type: 'SET_EXTRA'; extra: string }

  // Transcript zone
  | { type: 'TRANSCRIPT_LINE'; text: string }

  // Scroll region
  | { type: 'SCROLL_APPEND'; line: ScrollLine }
  | { type: 'SCROLL_CLEAR' }

  // Input
  | { type: 'INPUT_CHAR'; char: string }
  | { type: 'INPUT_BACKSPACE' }
  | { type: 'INPUT_DELETE' }
  | { type: 'INPUT_SUBMIT' }
  | { type: 'INPUT_CURSOR_LEFT' }
  | { type: 'INPUT_CURSOR_RIGHT' }
  | { type: 'INPUT_CURSOR_HOME' }
  | { type: 'INPUT_CURSOR_END' }
  | { type: 'INPUT_HISTORY_PREV' }
  | { type: 'INPUT_HISTORY_NEXT' }
  | { type: 'INPUT_SET_MODE'; mode: InputMode }
  | { type: 'INPUT_SET_HINT'; hint: string | null }

  // Overlays
  | { type: 'OVERLAY_PUSH'; overlay: Overlay }
  | { type: 'OVERLAY_POP'; id?: string }  // pop specific or topmost
  | { type: 'OVERLAY_CLEAR' };

// ── Layout ──

export interface ZoneLayout {
  top: number;   // 1-based row
  bottom: number;
}

export interface Layout {
  header: ZoneLayout;
  transcript: ZoneLayout;
  separator1: number;    // row number of separator between transcript and scroll
  scroll: ZoneLayout;
  separator2: number;    // row number of separator above footer
  footer: number;        // single row
}

// ── TUI Public API ──

export interface TUI {
  dispatch(action: Action): void;
  getState(): Readonly<TUIState>;
  onSubmit(handler: (text: string) => void): void;
  onSignal(handler: (signal: 'stop' | 'interrupt') => void): void;
  init(): void;
  teardown(): void;
}

export interface TUIOptions {
  transcriptLines?: number;  // default 3
  maxScrollBuffer?: number;  // default 500
}
