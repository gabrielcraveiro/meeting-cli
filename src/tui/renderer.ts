// ── Renderer (View) ──
// Reads TUIState, produces ANSI output. No state mutation.
// All writes are batched into a single stdout.write() per render cycle.
// Color scheme: One Dark Pro

import chalk from 'chalk';
import type { TUIState, Layout, Overlay, ScrollLine } from './types';
import { computeLayout, stripAnsi, visibleWidth } from './zones';

// ── One Dark Pro palette ──
const C = {
  red:       chalk.hex('#e06c75'),
  redBold:   chalk.hex('#e06c75').bold,
  green:     chalk.hex('#98c379'),
  greenBold: chalk.hex('#98c379').bold,
  yellow:    chalk.hex('#e5c07b'),
  blue:      chalk.hex('#61afef'),
  blueBold:  chalk.hex('#61afef').bold,
  magenta:   chalk.hex('#c678dd'),
  cyan:      chalk.hex('#56b6c2'),
  cyanBold:  chalk.hex('#56b6c2').bold,
  orange:    chalk.hex('#d19a66'),
  fg:        chalk.hex('#abb2bf'),
  fgBold:    chalk.hex('#abb2bf').bold,
  dim:       chalk.hex('#5c6370'),
  white:     chalk.hex('#ffffff'),
  whiteBold: chalk.hex('#ffffff').bold,
  separator: chalk.hex('#3e4451'),
  // Accent for recording dot
  recDot:    chalk.hex('#e06c75').bold,
  // Overlay border
  border:    chalk.hex('#5c6370'),
  borderTitle: chalk.hex('#61afef').bold,
};

// ANSI escape helpers
const ESC = '\x1b[';
const SAVE    = '\x1b7';
const RESTORE = '\x1b8';
const RESET_SCROLL = `${ESC}r`;

function moveTo(row: number, col: number): string {
  return `${ESC}${row};${col}H`;
}

function clearLine(): string {
  return `${ESC}2K`;
}

function setScrollRegion(top: number, bottom: number): string {
  return `${ESC}${top};${bottom}r`;
}

function padRight(s: string, width: number): string {
  const vis = visibleWidth(s);
  if (vis >= width) return s;
  return s + ' '.repeat(width - vis);
}

function truncate(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const plain = stripAnsi(s);
  if (plain.length <= maxWidth) return s;

  let visible = 0;
  let i = 0;
  while (i < s.length && visible < maxWidth - 1) {
    if (s[i] === '\x1b') {
      while (i < s.length && s[i] !== 'm') i++;
      i++;
      continue;
    }
    visible++;
    i++;
  }
  return s.slice(0, i) + '…';
}

export class Renderer {
  private layout!: Layout;
  private transcriptLines: number;
  private lastScrollCount = 0;
  // Track the exact visible prefix length for cursor positioning
  private footerPrefixLen = 0;

  constructor(transcriptLines: number) {
    this.transcriptLines = transcriptLines;
  }

  // ── Main render entry point ──

  render(state: TUIState): void {
    this.layout = computeLayout(state.rows, this.transcriptLines);
    const buf: string[] = [];
    const { dirty } = state;

    const needsFixedZone = dirty.has('header') || dirty.has('transcript') || dirty.has('footer') || dirty.has('overlay');

    if (needsFixedZone) {
      buf.push(SAVE);
      buf.push(RESET_SCROLL);
    }

    if (dirty.has('header'))     this._renderHeader(state, buf);
    if (dirty.has('transcript')) this._renderTranscript(state, buf);
    if (dirty.has('footer'))     this._renderFooter(state, buf);

    if (dirty.has('transcript') || dirty.has('header')) {
      this._renderSeparator(this.layout.separator1, state.cols, buf);
    }
    if (dirty.has('footer')) {
      this._renderSeparator(this.layout.separator2, state.cols, buf);
    }

    if (needsFixedZone) {
      buf.push(setScrollRegion(this.layout.scroll.top, this.layout.scroll.bottom));
      buf.push(RESTORE);
    }

    if (dirty.has('scroll')) {
      this._renderScroll(state, buf);
    }

    if (dirty.has('overlay')) {
      this._renderOverlays(state, buf);
    }

    this._positionCursor(state, buf);

    if (buf.length > 0) {
      process.stdout.write(buf.join(''));
    }
  }

  renderFull(state: TUIState): void {
    this.layout = computeLayout(state.rows, this.transcriptLines);
    this.lastScrollCount = 0;
    const buf: string[] = [];

    buf.push(`${ESC}2J${ESC}H`);

    this._renderHeader(state, buf);
    this._renderTranscript(state, buf);
    this._renderSeparator(this.layout.separator1, state.cols, buf);
    this._renderSeparator(this.layout.separator2, state.cols, buf);
    this._renderFooter(state, buf);

    buf.push(setScrollRegion(this.layout.scroll.top, this.layout.scroll.bottom));

    this._renderScrollFull(state, buf);

    if (state.overlays.length > 0) {
      this._renderOverlays(state, buf);
    }

    this._positionCursor(state, buf);

    process.stdout.write(buf.join(''));
  }

  // ── Zone renderers ──

  private _renderHeader(state: TUIState, buf: string[]): void {
    const { recording } = state;
    const w = state.cols;

    const mm = Math.floor(recording.elapsed / 60).toString().padStart(2, '0');
    const ss = (recording.elapsed % 60).toString().padStart(2, '0');

    // Line 1: ● REC  02:05  │  3 seg  │  $0.0231
    const rec  = recording.active ? C.recDot(' ● REC') : C.dim(' ○ IDLE');
    const time = C.whiteBold(`${mm}:${ss}`);
    const segs = C.dim(`${recording.segments} seg`);
    const cost = C.dim(`$${recording.cost.toFixed(4)}`);
    const extra = recording.extra ? C.yellow(` ${recording.extra}`) : '';

    buf.push(moveTo(1, 1) + clearLine());
    buf.push(`${rec}  ${time}  ${C.dim('│')}  ${segs}  ${C.dim('│')}  ${cost}${extra}`);

    // Line 2: labels
    buf.push(moveTo(2, 1) + clearLine());
    const parts: string[] = [];
    if (recording.templateLabel) parts.push(C.magenta(recording.templateLabel));
    if (recording.topicLabel)    parts.push(C.cyan(`⟨${recording.topicLabel}⟩`));
    parts.push(C.green('Mic ✔') + '  ' + C.green('Sys ✔'));
    buf.push(`  ${parts.join(`  ${C.dim('│')}  `)}`);

    // Line 3: separator
    this._renderSeparator(3, w, buf);
  }

  private _renderTranscript(state: TUIState, buf: string[]): void {
    const { transcript } = state;
    const { top } = this.layout.transcript;
    const visible = transcript.lines.slice(-transcript.maxVisible);
    const w = state.cols - 4;

    for (let i = 0; i < this.transcriptLines; i++) {
      const row = top + i;
      buf.push(moveTo(row, 1) + clearLine());
      if (i < visible.length) {
        const line = truncate(visible[i], w);
        buf.push(C.fg(`  ${line}`));
      }
    }
  }

  private _renderSeparator(row: number, cols: number, buf: string[]): void {
    buf.push(moveTo(row, 1) + clearLine());
    buf.push(C.separator('─'.repeat(Math.min(cols, 80))));
  }

  private _renderFooter(state: TUIState, buf: string[]): void {
    const { input } = state;
    const row = this.layout.footer;

    buf.push(moveTo(row, 1) + clearLine());

    if (input.hint) {
      const hintStr = `  ${input.hint}`;
      buf.push(hintStr);
      this.footerPrefixLen = visibleWidth(hintStr);
      return;
    }

    // Build prefix, tracking visible length precisely
    const cmdStr = '/stop /help /ctx';
    let modeStr = '';
    if (input.mode === 'busy')       modeStr = ' ⟳';
    if (input.mode === 'finalizing') modeStr = ' ■';

    const promptLabel = ' › ';

    // Compose: "  /stop /help /ctx ⟳  › inputText"
    const prefix = `  ${cmdStr}${modeStr}  ${promptLabel}`;
    this.footerPrefixLen = prefix.length; // all ASCII, no ANSI in calculation

    // Now write with colors
    buf.push(
      '  ' +
      C.dim(cmdStr) +
      (modeStr ? C.yellow(modeStr) : '') +
      '  ' +
      C.blueBold(promptLabel) +
      C.fg(input.text)
    );
  }

  // ── Scroll region ──

  private _renderScroll(state: TUIState, buf: string[]): void {
    const { lines } = state.scroll;
    const newCount = lines.length;

    if (newCount <= this.lastScrollCount) {
      this._renderScrollFull(state, buf);
      this.lastScrollCount = newCount;
      return;
    }

    const newLines = lines.slice(this.lastScrollCount);
    this.lastScrollCount = newCount;

    buf.push(SAVE);
    buf.push(moveTo(this.layout.scroll.bottom, 1));

    for (const line of newLines) {
      const styled = this._styleScrollLine(line, state.cols);
      buf.push(`${styled}\n`);
    }

    buf.push(RESTORE);
  }

  private _renderScrollFull(state: TUIState, buf: string[]): void {
    const { scroll: zone } = this.layout;
    const capacity = zone.bottom - zone.top + 1;
    const { lines } = state.scroll;
    const visible = lines.slice(-capacity);

    this.lastScrollCount = lines.length;

    buf.push(SAVE);
    buf.push(RESET_SCROLL);

    for (let row = zone.top; row <= zone.bottom; row++) {
      buf.push(moveTo(row, 1) + clearLine());
    }

    for (let i = 0; i < visible.length; i++) {
      const row = zone.top + i;
      buf.push(moveTo(row, 1));
      buf.push(this._styleScrollLine(visible[i], state.cols));
    }

    buf.push(setScrollRegion(zone.top, zone.bottom));
    buf.push(RESTORE);
  }

  private _styleScrollLine(line: ScrollLine, cols: number): string {
    const maxW = cols - 4;
    const text = truncate(line.text, maxW);

    switch (line.category) {
      case 'chat-user':
        return C.blueBold('  › ') + C.white(text);
      case 'chat-ai':
        return C.dim('    ') + C.fg(text);
      case 'insight':
        // Parse insight tags for coloring
        if (text.includes('[decisao]')) return '  ' + C.green(text);
        if (text.includes('[acao]'))    return '  ' + C.cyan(text);
        if (text.includes('[risco]'))   return '  ' + C.red(text);
        if (text.includes('[ponto]'))   return '  ' + C.fg(text);
        return '  ' + C.magenta(text);
      case 'system':
        return C.dim(`  ${text}`);
      case 'error':
        return C.red(`  ${text}`);
      case 'separator':
        return C.separator('  ' + '─'.repeat(Math.min(maxW, 40)));
      case 'formatted':
        return `  ${text}`;  // already styled by caller — just indent
      default:
        return `  ${text}`;
    }
  }

  // ── Overlays ──

  private _renderOverlays(state: TUIState, buf: string[]): void {
    if (state.overlays.length === 0) return;
    const overlay = state.overlays[state.overlays.length - 1];
    this._renderOverlayBox(overlay, state, buf);
  }

  private _renderOverlayBox(overlay: Overlay, state: TUIState, buf: string[]): void {
    const { rows, cols } = state;
    const boxW = Math.min(Math.floor(cols * overlay.width / 100), cols - 4);
    const boxH = Math.min(Math.floor(rows * overlay.height / 100), rows - 6);
    const innerW = boxW - 4;

    let startCol: number;
    if (overlay.position === 'center') {
      startCol = Math.floor((cols - boxW) / 2) + 1;
    } else {
      startCol = cols - boxW - 1;
    }
    const startRow = Math.floor((rows - boxH) / 2) + 1;

    buf.push(SAVE);
    buf.push(RESET_SCROLL);

    // Top border with title
    const titleText = ` ${overlay.title} `;
    const titlePad = Math.floor((boxW - 2 - titleText.length) / 2);
    const topLine = C.border('╭') +
      C.border('─'.repeat(Math.max(0, titlePad))) +
      C.borderTitle(titleText) +
      C.border('─'.repeat(Math.max(0, boxW - 2 - titlePad - titleText.length))) +
      C.border('╮');
    buf.push(moveTo(startRow, startCol) + topLine);

    // Content
    const contentLines = overlay.lines.slice(0, boxH - 3);
    for (let i = 0; i < boxH - 3; i++) {
      const row = startRow + 1 + i;
      buf.push(moveTo(row, startCol));

      if (i < contentLines.length) {
        const content = truncate(contentLines[i], innerW);
        const padded = padRight(content, innerW);
        buf.push(C.border('│ ') + C.fg(padded) + C.border(' │'));
      } else {
        buf.push(C.border('│') + ' '.repeat(boxW - 2) + C.border('│'));
      }
    }

    // Dismiss hint
    const dismissRow = startRow + boxH - 2;
    const dismissKey = overlay.dismissKey || 'Esc';
    const dismissText = `[${dismissKey}] fechar`;
    const dismissPad = innerW - dismissText.length;
    buf.push(moveTo(dismissRow, startCol));
    buf.push(C.border('│ ') + ' '.repeat(Math.max(0, dismissPad)) + C.dim(dismissText) + C.border(' │'));

    // Bottom border (rounded)
    const bottomLine = C.border('╰' + '─'.repeat(boxW - 2) + '╯');
    buf.push(moveTo(startRow + boxH - 1, startCol) + bottomLine);

    buf.push(setScrollRegion(this.layout.scroll.top, this.layout.scroll.bottom));
    buf.push(RESTORE);
  }

  // ── Cursor positioning ──

  private _positionCursor(state: TUIState, buf: string[]): void {
    const { input } = state;
    const row = this.layout.footer;

    // Use the precisely tracked prefix length from _renderFooter
    const col = this.footerPrefixLen + input.cursorPos + 1;

    buf.push(moveTo(row, Math.min(col, state.cols)));
    buf.push(`${ESC}?25h`);
  }
}
