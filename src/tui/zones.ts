// ── Zone Layout Calculator ──
// Pure function — computes row positions for each TUI zone.

import type { Layout } from './types';

const HEADER_ROWS = 3;
const FOOTER_ROWS = 1;    // input line
const SEPARATOR_ROWS = 2;  // one after transcript, one before footer

export function computeLayout(rows: number, transcriptLines: number): Layout {
  // Header: rows 1..3
  const headerTop = 1;
  const headerBottom = HEADER_ROWS;

  // Transcript: rows 4..4+transcriptLines-1
  const transcriptTop = headerBottom + 1;
  const transcriptBottom = transcriptTop + transcriptLines - 1;

  // Separator after transcript
  const separator1 = transcriptBottom + 1;

  // Footer and its separator sit at the bottom
  const footer = rows;
  const separator2 = rows - FOOTER_ROWS;

  // Scroll region: everything between separator1 and separator2
  const scrollTop = separator1 + 1;
  const scrollBottom = separator2 - 1;

  return {
    header:     { top: headerTop, bottom: headerBottom },
    transcript: { top: transcriptTop, bottom: transcriptBottom },
    separator1,
    scroll:     { top: scrollTop, bottom: Math.max(scrollTop, scrollBottom) },
    separator2,
    footer,
  };
}

// Minimum terminal rows needed for a functional layout
export function minRows(transcriptLines: number): number {
  return HEADER_ROWS + transcriptLines + SEPARATOR_ROWS + FOOTER_ROWS + 3; // +3 for at least 3 scroll rows
}

// Strip ANSI escape codes to get visible character count
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x07/g, '');
}

// Truncate a string (with ANSI) to fit within maxWidth visible characters.
// Naive approach: strips ANSI, truncates, then returns plain truncated text.
// For styled truncation, the caller should apply chalk after truncation.
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

export function truncateVisible(s: string, maxWidth: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= maxWidth) return s;
  // Walk through original string, counting only visible chars
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < maxWidth - 1) {
    if (s[i] === '\x1b') {
      // Skip ANSI sequence
      const bracket = s.indexOf('m', i);
      if (bracket > i) {
        i = bracket + 1;
        continue;
      }
    }
    visible++;
    i++;
  }
  return s.slice(0, i) + '…';
}
