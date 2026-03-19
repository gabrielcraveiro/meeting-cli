// ── Input Handler ──
// Raw stdin handler that replaces readline entirely.
// Parses key sequences and dispatches Actions.
// No rendering — that's the Renderer's job.

import type { Action } from './types';

type Dispatch = (action: Action) => void;
type SubmitHandler = (text: string) => void;
type SignalHandler = (signal: 'stop' | 'interrupt') => void;

// Common ANSI escape sequences from terminals
const KEYS = {
  ENTER:      '\r',
  NEWLINE:    '\n',
  BACKSPACE1: '\x7f',   // most terminals
  BACKSPACE2: '\x08',   // some terminals (Ctrl+H)
  CTRL_C:     '\x03',
  CTRL_D:     '\x04',
  ESCAPE:     '\x1b',
  TAB:        '\t',

  // Arrow keys + navigation (CSI sequences)
  UP:         '\x1b[A',
  DOWN:       '\x1b[B',
  RIGHT:      '\x1b[C',
  LEFT:       '\x1b[D',
  HOME1:      '\x1b[H',
  HOME2:      '\x1b[1~',
  END1:       '\x1b[F',
  END2:       '\x1b[4~',
  DELETE:     '\x1b[3~',

  // Windows Terminal sometimes sends these
  HOME3:      '\x1bOH',
  END3:       '\x1bOF',
} as const;

export class InputHandler {
  private dispatch: Dispatch;
  private submitHandlers: SubmitHandler[] = [];
  private signalHandlers: SignalHandler[] = [];
  private currentText = '';  // mirror of state.input.text for submit callback
  private active = false;
  private wasRawMode = false;

  constructor(dispatch: Dispatch) {
    this.dispatch = dispatch;
  }

  onSubmit(handler: SubmitHandler): void {
    this.submitHandlers.push(handler);
  }

  onSignal(handler: SignalHandler): void {
    this.signalHandlers.push(handler);
  }

  // Sync input text from state (called by TUI dispatch loop after update)
  syncText(text: string): void {
    this.currentText = text;
  }

  start(): void {
    if (this.active) return;
    this.active = true;

    // Enable raw mode (no echo, no line buffering, no SIGINT from Ctrl+C)
    if (process.stdin.isTTY) {
      this.wasRawMode = process.stdin.isRaw ?? false;
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', this._onData);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;

    process.stdin.removeListener('data', this._onData);

    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(this.wasRawMode); } catch {}
    }
    try { process.stdin.pause(); } catch {}
  }

  // ── Key parser ──
  // Arrow-function to preserve `this` binding when used as event listener

  private _onData = (data: string): void => {
    // Raw mode can deliver multiple key sequences in a single chunk.
    // Process them sequentially.
    let i = 0;
    while (i < data.length) {
      // Try to match escape sequences first (longest match)
      if (data[i] === '\x1b') {
        const seq = this._matchEscapeSequence(data, i);
        if (seq) {
          this._handleKey(seq.key);
          i += seq.consumed;
          continue;
        }
        // Bare Escape (no sequence following)
        this._handleKey(KEYS.ESCAPE);
        i++;
        continue;
      }

      // Single-byte control characters and printable chars
      this._handleKey(data[i]);
      i++;
    }
  };

  private _matchEscapeSequence(data: string, start: number): { key: string; consumed: number } | null {
    // Need at least 2 chars for any escape sequence
    if (start + 1 >= data.length) return null;

    const remaining = data.slice(start);

    // CSI sequences: ESC [ ...
    if (remaining.startsWith('\x1b[')) {
      // Arrow keys: ESC [ A/B/C/D
      if (remaining.length >= 3) {
        const third = remaining[2];
        if (third === 'A') return { key: KEYS.UP, consumed: 3 };
        if (third === 'B') return { key: KEYS.DOWN, consumed: 3 };
        if (third === 'C') return { key: KEYS.RIGHT, consumed: 3 };
        if (third === 'D') return { key: KEYS.LEFT, consumed: 3 };
        if (third === 'H') return { key: KEYS.HOME1, consumed: 3 };
        if (third === 'F') return { key: KEYS.END1, consumed: 3 };
      }

      // Extended sequences: ESC [ N ~ (Delete, Home, End, PgUp, PgDn)
      const tildeMatch = remaining.match(/^\x1b\[(\d+)~/);
      if (tildeMatch) {
        const code = tildeMatch[1];
        const consumed = tildeMatch[0].length;
        if (code === '3') return { key: KEYS.DELETE, consumed };
        if (code === '1') return { key: KEYS.HOME2, consumed };
        if (code === '4') return { key: KEYS.END2, consumed };
        // PgUp (5~), PgDn (6~) — ignore for now
        return { key: '', consumed }; // consume but ignore
      }

      // Unknown CSI — consume ESC [ and the next char
      return { key: '', consumed: 3 };
    }

    // SS3 sequences: ESC O ... (some terminals send these for Home/End)
    if (remaining.startsWith('\x1bO') && remaining.length >= 3) {
      const third = remaining[2];
      if (third === 'H') return { key: KEYS.HOME3, consumed: 3 };
      if (third === 'F') return { key: KEYS.END3, consumed: 3 };
      // Unknown SS3
      return { key: '', consumed: 3 };
    }

    return null;
  }

  private _handleKey(key: string): void {
    if (!key) return;

    switch (key) {
      // ── Submit ──
      case KEYS.ENTER:
      case KEYS.NEWLINE: {
        const text = this.currentText;
        this.dispatch({ type: 'INPUT_SUBMIT' });
        // Fire submit handlers with the text BEFORE it was cleared
        for (const h of this.submitHandlers) h(text);
        return;
      }

      // ── Backspace ──
      case KEYS.BACKSPACE1:
      case KEYS.BACKSPACE2:
        this.dispatch({ type: 'INPUT_BACKSPACE' });
        return;

      // ── Delete ──
      case KEYS.DELETE:
        this.dispatch({ type: 'INPUT_DELETE' });
        return;

      // ── Navigation ──
      case KEYS.LEFT:
        this.dispatch({ type: 'INPUT_CURSOR_LEFT' });
        return;

      case KEYS.RIGHT:
        this.dispatch({ type: 'INPUT_CURSOR_RIGHT' });
        return;

      case KEYS.HOME1:
      case KEYS.HOME2:
      case KEYS.HOME3:
        this.dispatch({ type: 'INPUT_CURSOR_HOME' });
        return;

      case KEYS.END1:
      case KEYS.END2:
      case KEYS.END3:
        this.dispatch({ type: 'INPUT_CURSOR_END' });
        return;

      // ── History ──
      case KEYS.UP:
        this.dispatch({ type: 'INPUT_HISTORY_PREV' });
        return;

      case KEYS.DOWN:
        this.dispatch({ type: 'INPUT_HISTORY_NEXT' });
        return;

      // ── Signals ──
      case KEYS.CTRL_C:
        for (const h of this.signalHandlers) h('stop');
        return;

      case KEYS.CTRL_D:
        for (const h of this.signalHandlers) h('interrupt');
        return;

      // ── Escape: dismiss overlay ──
      case KEYS.ESCAPE:
        this.dispatch({ type: 'OVERLAY_POP' });
        return;

      // ── Tab: ignore for now ──
      case KEYS.TAB:
        return;

      // ── Printable characters ──
      default: {
        // Only dispatch if it's a printable character (code >= 32)
        if (key.length === 1 && key.charCodeAt(0) >= 32) {
          this.dispatch({ type: 'INPUT_CHAR', char: key });
        }
        // Multi-byte UTF-8 chars (emoji, accents) also come through here
        if (key.length > 1 && key.charCodeAt(0) >= 32) {
          this.dispatch({ type: 'INPUT_CHAR', char: key });
        }
        return;
      }
    }
  }
}
