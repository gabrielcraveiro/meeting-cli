import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import { createSpinner } from 'nanospinner';
import boxen from 'boxen';
import { requireConfig } from '../config';
import { createTUI } from '../tui/index';
import { transcribeFile, transcribeFull } from '../services/transcriber';
import { organizeTranscript, chatWithMeetings } from '../services/organizer';
import { createMeetingNote, loadMeetingSummaries } from '../services/storage';
import { getSidecarCapturePath } from './setup';
import { getTemplate, listTemplates, getAdaptiveWrapper } from '../services/templates';
import { getUpcomingMeetings, formatEventTime } from '../services/calendar';
import { matchSpeaker, enrollSpeaker } from '../services/voice';

const DEEPGRAM_PER_MIN = 0.0077;  // nova-3 + diarization, single-pass
const SEGMENT_SECONDS = 45;
const WARN_SECONDS = 30 * 60;
const HARD_STOP_SECONDS = 60 * 60;
const INSIGHT_INTERVAL_MS = 3 * 60 * 1000;

// Silence detection: auto-stop after sustained silence
const SILENCE_THRESHOLD_DB = -35;           // dB — below this = silence
const SILENCE_TIMEOUT_SEGMENTS = 4;         // ~3 min of silence (4 × 45s)
const SILENCE_TRIM_THRESHOLD_DB = -35;      // dB — trim trailing silent segments

// WSL path conversion
function toWinPath(p: string): string {
  return p.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatTimestamp(offsetSec: number): string {
  return `[${formatTime(offsetSec)}]`;
}

function getSidecarPath(): string {
  const setupPath = getSidecarCapturePath();
  if (fs.existsSync(setupPath)) return setupPath;
  const candidates = [
    path.resolve(__dirname, '..', 'sidecar', 'capture.js'),
    path.resolve(__dirname, '..', '..', 'sidecar', 'capture.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Sidecar não encontrado. Rode: meeting setup');
}

function mergeWavSegments(segmentPaths: string[], outputPath: string): void {
  if (segmentPaths.length === 0) return;
  const firstBuf = fs.readFileSync(segmentPaths[0]);
  const channels = firstBuf.readUInt16LE(22);
  const sampleRate = firstBuf.readUInt32LE(24);
  const bitsPerSample = firstBuf.readUInt16LE(34);
  const pcmChunks: Buffer[] = [];
  let totalPcmSize = 0;
  for (const segPath of segmentPaths) {
    const buf = fs.readFileSync(segPath);
    const pcm = buf.subarray(44);
    pcmChunks.push(pcm);
    totalPcmSize += pcm.length;
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + totalPcmSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(totalPcmSize, 40);
  fs.writeFileSync(outputPath, Buffer.concat([header, ...pcmChunks]));
}

// ── Terminal UI with fixed header/footer and scroll region ───────
// Uses ANSI escape codes (VT100) for persistent status display.
// Header: recording status, timer, segments, cost
// Footer: input bar with commands hint
// Middle: scroll region for transcript, insights, chat

// ── TUI Adapter ──
// Wraps the new MVU-based TUI with the legacy API so existing call sites stay unchanged.
// Phase 5: all rendering, input handling, and overlays are delegated to src/tui/.

class TerminalUI {
  private tui = createTUI({ transcriptLines: 3 });
  private active = false;
  private currentCost = 0;
  private currentSegments = 0;
  private elapsedSec = 0;

  init() {
    this.active = true;
    this.tui.init();
  }

  setLabels(template: string, topic: string) {
    this.tui.dispatch({ type: 'SET_LABELS', template, topic });
  }

  setPaused(paused: boolean) {
    this.tui.dispatch({ type: 'SET_EXTRA', extra: paused ? '⏸ PAUSED' : '' });
  }

  drawStatusBar(time: string, segments: number, extra?: string) {
    this.currentSegments = segments;
    if (extra !== undefined) {
      this.tui.dispatch({ type: 'SET_EXTRA', extra });
    }
    // Parse time string to seconds for TICK
    const parts = time.split(':');
    this.elapsedSec = (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
    this.tui.dispatch({
      type: 'TICK',
      elapsed: this.elapsedSec,
      segments: this.currentSegments,
      cost: this.currentCost,
    });
  }

  updateCost(cost: number) {
    this.currentCost = cost;
  }

  showStatus(time: string, segments: number) {
    this.drawStatusBar(time, segments);
  }

  drawInputBar(hint?: string) {
    if (hint) {
      this.tui.dispatch({ type: 'INPUT_SET_HINT', hint });
    }
  }

  setInput(_text: string) {
    // No-op: new TUI handles input display internally via InputHandler
  }

  updateTranscript(line: string) {
    this.tui.dispatch({ type: 'TRANSCRIPT_LINE', text: line });
  }

  appendLine(text: string) {
    if (!this.active) {
      console.log(text);
      return;
    }
    // Word-wrap plain (unstyled) lines so they don't get truncated by the renderer.
    // Already-styled lines (with ANSI codes) are passed through as-is — callers that
    // pre-style must word-wrap themselves (see appendInsightLine).
    const cols = this.active ? this.tui.getState().cols : 80;
    const maxW = cols - 4;
    if (text.includes('\x1b') || [...text].length <= maxW) {
      // pre-styled or short enough — dispatch directly
      this.tui.dispatch({ type: 'SCROLL_APPEND', line: { text, category: 'formatted' } });
    } else {
      const words = text.split(' ');
      let current = '';
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if ([...test].length > maxW && current) {
          this.tui.dispatch({ type: 'SCROLL_APPEND', line: { text: current, category: 'formatted' } });
          current = word;
        } else {
          current = test;
        }
      }
      if (current) this.tui.dispatch({ type: 'SCROLL_APPEND', line: { text: current, category: 'formatted' } });
    }
  }

  // Word-wrap a raw insight line, then apply the chalk styler to each wrapped chunk.
  appendInsightLine(raw: string, styler: (s: string) => string, prefix: string) {
    const cols = this.active ? this.tui.getState().cols : 80;
    const maxW = cols - prefix.length - 4;
    const words = raw.split(' ');
    let current = '';
    let first = true;
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if ([...test].length > maxW && current) {
        this.tui.dispatch({ type: 'SCROLL_APPEND', line: { text: (first ? prefix : '    ') + styler(current), category: 'formatted' } });
        current = word;
        first = false;
      } else {
        current = test;
      }
    }
    if (current) this.tui.dispatch({ type: 'SCROLL_APPEND', line: { text: (first ? prefix : '    ') + styler(current), category: 'formatted' } });
  }

  appendChatUser(text: string) {
    this.tui.dispatch({ type: 'SCROLL_APPEND', line: { text, category: 'chat-user' } });
  }

  appendChatAI(text: string) {
    const cols = this.active ? this.tui.getState().cols : 80;
    const maxW = cols - 6; // 4 for '    ' prefix + 2 buffer
    const words = text.split(' ');
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if ([...test].length > maxW && current) {
        this.tui.dispatch({ type: 'SCROLL_APPEND', line: { text: current, category: 'chat-ai' } });
        // if the word itself is longer than maxW, split it hard
        let remaining = word;
        while ([...remaining].length > maxW) {
          this.tui.dispatch({ type: 'SCROLL_APPEND', line: { text: [...remaining].slice(0, maxW).join(''), category: 'chat-ai' } });
          remaining = [...remaining].slice(maxW).join('');
        }
        current = remaining;
      } else {
        current = test;
      }
    }
    if (current) {
      this.tui.dispatch({ type: 'SCROLL_APPEND', line: { text: current, category: 'chat-ai' } });
    }
  }

  teardown() {
    if (!this.active) return;
    this.active = false;
    this.tui.teardown();
  }

  // Access the underlying TUI for onSubmit/onSignal wiring
  get raw() { return this.tui; }
}

const INSIGHT_PROMPT = `<role>Analista de reunioes em tempo real. Voce recebe transcrições incrementais e extrai sinais de decisao.</role>

<task>Extraia APENAS pontos acionaveis. Priorize: decisoes > acoes > riscos > pontos informativos.</task>

<format>
- [decisao] O que foi decidido (quem, o que, quando — se mencionado)
- [acao] Tarefa atribuida a alguem com prazo se mencionado
- [risco] Blocker, dependencia externa, ou preocupacao levantada
- [ponto] Insight tecnico ou de negocio que altera entendimento

Tags obrigatorias. Maximo 5 bullets. Sem preambulo. Portugues BR.
Se nenhum ponto relevante: responda exatamente "(sem pontos relevantes ainda)"
</format>

<guidelines>
- Nao repita pontos de analises anteriores — foque no que e NOVO neste trecho
- Infira nomes reais se mencionados no dialogo. Use [Speaker N] apenas se o nome nao for identificavel
- "Vamos fazer X" = decisao. "Eu vou fazer X" = acao. "E se X acontecer?" = risco
</guidelines>`;

export async function cmdStart(topicArg?: string, opts: { template?: string } = {}): Promise<void> {
  const config = requireConfig();

  let topic = typeof topicArg === 'string' ? topicArg.trim() : '';
  let calendarAttendees: string[] = [];

  // Calendar picker: show upcoming meetings if ICS is configured and no topic given
  if (config.icsUrl && !topic) {
    let meetings: Awaited<ReturnType<typeof getUpcomingMeetings>> = [];
    try {
      meetings = await getUpcomingMeetings(config.icsUrl);
    } catch {
      // Calendar is optional — silently skip on error
    }

    if (meetings.length > 0) {
      console.log('\n📅 Reuniões próximas:\n');
      meetings.forEach((m, i) => {
        const time = `${formatEventTime(m.start)}–${formatEventTime(m.end)}`;
        const attendeePreview = m.attendees.slice(0, 3).join(', ') +
          (m.attendees.length > 3 ? ` +${m.attendees.length - 3}` : '');
        console.log(`  ${i + 1}. ${m.title} (${time})${attendeePreview ? '  · ' + attendeePreview : ''}`);
      });
      console.log('\n  0. Nenhuma (digitar título manualmente)');
      console.log('  Enter. Iniciar sem título\n');

      const pickerRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        pickerRl.question('  Qual reunião? ', (a: string) => {
          pickerRl.close();
          resolve(a.trim());
        });
      });

      if (answer === '' || answer === '0') {
        if (answer === '0') {
          // Ask for manual title
          const titleRl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const manualTitle = await new Promise<string>((resolve) => {
            titleRl.question('  Título: ', (a: string) => {
              titleRl.close();
              resolve(a.trim());
            });
          });
          topic = manualTitle;
        }
        // else Enter = no title, continue as usual
      } else {
        const idx = parseInt(answer) - 1;
        if (!isNaN(idx) && idx >= 0 && idx < meetings.length) {
          const selected = meetings[idx];
          topic = selected.title;
          calendarAttendees = selected.attendees;
        }
      }
      console.log('');
    }
  }

  const templateName = opts.template || 'default';
  const template = getTemplate(templateName);
  if (opts.template && !template) {
    console.error(chalk.red(`Template "${opts.template}" nao encontrado.`));
    console.log(chalk.gray('Disponiveis: ' + listTemplates().map(t => t.name).join(', ')));
    process.exit(1);
  }

  const recordingsDir = path.join(config.vaultPath, 'Recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });

  // Auto-cleanup orphan .tmp-* dirs from crashed sessions
  try {
    const orphans = fs.readdirSync(recordingsDir).filter(f => f.startsWith('.tmp-'));
    for (const d of orphans) {
      fs.rmSync(path.join(recordingsDir, d), { recursive: true, force: true });
    }
    if (orphans.length > 0) {
      console.log(chalk.gray(`Limpou ${orphans.length} sessao(oes) orfas.`));
    }
  } catch {}

  const now = new Date();
  const sessionId = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const segmentsDir = path.join(recordingsDir, `.tmp-${sessionId}`);
  fs.mkdirSync(segmentsDir, { recursive: true });

  const date = now.toLocaleDateString('sv').slice(0, 10);
  const timeLabel = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
  const finalAudioName = `Recording ${date} ${timeLabel}.wav`;
  const finalAudioPath = path.join(recordingsDir, finalAudioName);

  const transcriptLines: string[] = [];
  const processedSegments = new Set<string>();
  let elapsedSec = 0;
  let captureProcess: ChildProcess | null = null;
  let userRequestedStop = false;
  let pollInterval: NodeJS.Timeout | null = null;
  let timerInterval: NodeJS.Timeout | null = null;
  let stopping = false;
  let warned30 = false;
  let warned60 = false;
  let insightInterval: NodeJS.Timeout | null = null;
  let lastInsightLineCount = 0;
  let insightBusy = false;
  let chatBusy = false;
  let consecutiveSilentSegments = 0;
  let semanticContextLoaded = false;
  const segmentRmsDb: Map<number, number> = new Map();
  let skippedSilentSegments = 0;
  let transcribedSegments = 0;
  const remoteSpeakerIds = new Set<string>();   // track unique remote speakers across segments

  // Pause state
  let paused = false;
  let pausedAtSec = 0;     // elapsed seconds when paused (for display)
  let totalPausedSec = 0;   // total seconds spent paused (excluded from timer)
  let pauseStartTime = 0;   // Date.now() when pause started
  const pausedSegments = new Set<string>();  // segments captured during pause (skip transcription)

  const ui = new TerminalUI();
  const chatHistory: Array<{ role: string; content: string }> = [];

  // Context system: auto-loaded + user-added via /ctx + topic-based
  const extraContext: string[] = [];

  // Inject calendar attendees as context (not ordered — AI should NOT assume speaker identity from list order)
  if (calendarAttendees.length > 0) {
    extraContext.push(
      `# Participantes convidados (calendário)\n`
      + `Os seguintes participantes foram convidados para esta reunião: ${calendarAttendees.join(', ')}.\n`
      + `IMPORTANTE: Esta lista NÃO indica quem são Speaker 0, Speaker 1, etc. `
      + `Use o conteúdo da fala para inferir identidades, não a ordem desta lista.`
    );
  }

  function showTimestamp() {
    ui.showStatus(formatTime(elapsedSec), processedSegments.size);
  }

  async function transcribeSegment(segPath: string, offsetSec: number): Promise<void> {
    try {
      const stat = fs.statSync(segPath);
      if (stat.size < 4096) return;

      ui.updateTranscript(chalk.gray(`transcrevendo ${path.basename(segPath)}...`));
      // Single-pass: nova-3 + diarization on each segment (no re-transcription needed)
      const text = await transcribeFile(segPath, config, { diarize: true, model: 'nova-3' });
      if (!text) return;

      transcribedSegments++;

      // Track unique remote speakers for multi-speaker fallback detection
      const speakerMatches = text.matchAll(/\[(?:Remoto|Speaker)\s+(\d+)\]/g);
      for (const m of speakerMatches) remoteSpeakerIds.add(m[1]);

      // Store with timestamp prefix on first line only
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        transcriptLines.push(`${formatTimestamp(offsetSec)} ${lines[0]}`);
        for (let i = 1; i < lines.length; i++) {
          transcriptLines.push(lines[i]);
        }
      }

      if (!semanticContextLoaded) {
        loadSemanticContext();
      }

      // Show transcript in the fixed transcript zone (not the scroll region)
      for (const speakerLine of text.split('\n')) {
        if (speakerLine.trim()) {
          ui.updateTranscript(`${formatTimestamp(offsetSec)} ${speakerLine.trim()}`);
        }
      }
    } catch (err) {
      ui.appendLine(chalk.yellow(`  segmento falhou: ${(err as Error).message}`));
    }
  }

  function startPolling() {
    pollInterval = setInterval(async () => {
      const files = fs.readdirSync(segmentsDir)
        .filter(f => f.endsWith('.wav') && f.startsWith('seg_'))
        .sort();
      for (let i = 0; i < files.length - 1; i++) {
        const seg = files[i];
        if (!processedSegments.has(seg)) {
          processedSegments.add(seg);
          const segIndex = parseInt(seg.replace('seg_', '').replace('.wav', ''));

          // Skip segments captured during pause
          if (pausedSegments.has(seg)) {
            continue;
          }

          // Strategy: skip silent segments before transcribing (cost savings)
          const rmsDb = segmentRmsDb.get(segIndex);
          if (rmsDb !== undefined && rmsDb < SILENCE_THRESHOLD_DB) {
            skippedSilentSegments++;
            ui.updateTranscript(chalk.gray(`seg_${segIndex} silencioso (${rmsDb.toFixed(0)} dB) — pulado`));
            continue;
          }

          await transcribeSegment(path.join(segmentsDir, seg), segIndex * SEGMENT_SECONDS);
          showTimestamp();
        }
      }
    }, 2000);
  }

  async function runAutoInsight() {
    if (insightBusy || chatBusy || stopping || paused) return;
    if (transcriptLines.length <= lastInsightLineCount) return;
    if (transcriptLines.length < 3) return;

    insightBusy = true;
    // Cost optimization: send only NEW lines since last insight (delta), with brief context summary
    const newLines = transcriptLines.slice(lastInsightLineCount);
    const contextSummary = lastInsightLineCount > 0
      ? `[Contexto: ${lastInsightLineCount} linhas anteriores ja analisadas. Foque no trecho NOVO abaixo.]\n\n`
      : '';
    const currentTranscript = contextSummary + newLines.join('\n');
    lastInsightLineCount = transcriptLines.length;

    try {
      const messages = [
        { role: 'system', content: INSIGHT_PROMPT },
        { role: 'user', content: currentTranscript },
      ];
      const response = await chatWithMeetings(messages, config);

      if (response.includes('sem pontos relevantes')) {
        insightBusy = false;
        return;
      }

      ui.appendLine('');
      ui.appendLine(chalk.gray('  ─────────────────────────────────────────'));
      ui.appendLine(chalk.bold.magenta('  Insights') + chalk.gray(` (${formatTime(elapsedSec)})`));

      // Highlight lines that mention the user by name
      const userName = (config.speakerNames && Object.values(config.speakerNames).find(n => /gabriel/i.test(n))) || 'Gabriel';
      const userPattern = new RegExp(userName, 'i');

      for (const line of response.split('\n')) {
        const t = line.trim();
        if (!t || t === '-') continue;

        const mentionsMe = userPattern.test(t);
        const pfx = mentionsMe ? chalk.bgYellow.black(' >> ') + ' ' : '  ';

        if (t.includes('[decisao]')) {
          ui.appendInsightLine(t, s => mentionsMe ? chalk.green.bold(s) : chalk.green(s), pfx);
        } else if (t.includes('[acao]')) {
          ui.appendInsightLine(t, s => mentionsMe ? chalk.cyan.bold(s) : chalk.cyan(s), pfx);
        } else if (t.includes('[risco]')) {
          ui.appendInsightLine(t, s => mentionsMe ? chalk.red.bold(s) : chalk.red(s), pfx);
        } else if (t.includes('[ponto]')) {
          ui.appendInsightLine(t, s => mentionsMe ? chalk.white.bold(s) : chalk.white(s), pfx);
        } else {
          ui.appendInsightLine(t, s => mentionsMe ? chalk.bold(s) : chalk.gray(s), pfx);
        }
      }
      ui.appendLine(chalk.gray('  ─────────────────────────────────────────'));
      ui.appendLine('');
    } catch {
      // insights are optional
    }

    insightBusy = false;
  }

  // Semantic context: after first transcription, find relevant past meetings
  async function loadSemanticContext() {
    if (semanticContextLoaded || transcriptLines.length === 0) return;
    semanticContextLoaded = true;

    try {
      const allSummaries = loadMeetingSummaries(config, 15);
      if (allSummaries.length === 0) return;

      // Build a compact index: [index] date — first line of summary
      const index = allSummaries.map((m, i) => {
        const lines = m.split('\n');
        const dateLine = lines[0]; // [YYYY-MM-DD HH:MM]
        const content = lines.slice(1)
          .filter(l => l.trim() && !l.startsWith('##') && !l.startsWith('Participantes:'))
          .slice(0, 2).join(' ').replace(/\*\*/g, '').slice(0, 120);
        return `[${i}] ${dateLine} — ${content}`;
      }).join('\n');

      const currentSnippet = transcriptLines.slice(0, 5).join('\n');

      const messages = [
        {
          role: 'system',
          content: 'Voce recebe uma transcricao parcial de uma reuniao em andamento e uma lista de reunioes passadas. '
            + 'Retorne APENAS os numeros (indices) das reunioes que sao semanticamente relevantes para o contexto atual. '
            + 'Considere: mesmo projeto, mesmos participantes, mesmo tema, continuidade de decisoes. '
            + 'Formato: numeros separados por virgula (ex: 0,3,7). Se nenhuma for relevante, retorne: nenhuma',
        },
        {
          role: 'user',
          content: `# Reuniao em andamento\n${currentSnippet}\n\n# Reunioes passadas\n${index}`,
        },
      ];

      const response = await chatWithMeetings(messages, config);
      const trimmed = response.trim().toLowerCase();

      if (trimmed === 'nenhuma' || trimmed === 'nenhum') return;

      const indices = trimmed.split(/[,\s]+/)
        .map(s => parseInt(s.replace(/[^\d]/g, '')))
        .filter(n => !isNaN(n) && n >= 0 && n < allSummaries.length);

      if (indices.length === 0) return;

      const relevant = indices.map(i => allSummaries[i]);
      extraContext.push('# Reunioes relacionadas\n' + relevant.join('\n---\n'));

      // Show which meetings were loaded
      const labels = indices.map(i => {
        const dateLine = allSummaries[i].split('\n')[0];
        return dateLine;
      });
      ui.appendLine(chalk.gray(`  Contexto: ${labels.length} reuniao(oes) relacionada(s) carregada(s)`));
      for (const label of labels) {
        ui.appendLine(chalk.gray(`    ${label}`));
      }
    } catch {
      // semantic context is optional — don't block recording
    }
  }

  // Retroactive trim: calculate RMS from WAV file and strip silent trailing segments
  function calcWavRmsDb(wavPath: string): number {
    const buf = fs.readFileSync(wavPath);
    const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2);
    if (pcm.length === 0) return -100;
    let sumSq = 0;
    for (let i = 0; i < pcm.length; i++) {
      const s = pcm[i] / 32768;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / pcm.length);
    return rms > 0 ? 20 * Math.log10(rms) : -100;
  }

  function trimSilentTrailing(segFiles: string[]): { kept: string[]; trimmed: number } {
    let trimCount = 0;
    const files = [...segFiles];

    // Trim from the end
    while (files.length > 1) {
      const last = files[files.length - 1];
      const segPath = path.join(segmentsDir, last);

      // Prefer sidecar RMS if available, else calculate from file
      const idx = parseInt(last.replace('seg_', '').replace('.wav', ''));
      let rmsDb = segmentRmsDb.get(idx);
      if (rmsDb === undefined) {
        rmsDb = calcWavRmsDb(segPath);
      }

      if (rmsDb < SILENCE_TRIM_THRESHOLD_DB) {
        files.pop();
        trimCount++;
      } else {
        break;
      }
    }

    return { kept: files, trimmed: trimCount };
  }

  async function finalize(durationSec: number) {
    if (stopping) return;
    stopping = true;

    if (pollInterval) clearInterval(pollInterval);
    if (timerInterval) clearInterval(timerInterval);
    if (insightInterval) clearInterval(insightInterval);

    // Exit alternate screen for finalization output
    ui.teardown();

    console.log('\n' + chalk.bold('Finalizando...'));

    // 1. Retroactive trim: remove silent trailing segments
    const allFiles = fs.readdirSync(segmentsDir)
      .filter(f => f.endsWith('.wav') && f.startsWith('seg_'))
      .sort();

    const { kept: keptFiles, trimmed: trimmedCount } = trimSilentTrailing(allFiles);
    if (trimmedCount > 0) {
      const trimmedSec = trimmedCount * SEGMENT_SECONDS;
      console.log(chalk.yellow(`  Trimmed ${trimmedCount} segmento(s) silencioso(s) do final (~${Math.round(trimmedSec / 60)} min)`));
      durationSec = Math.max(0, durationSec - trimmedSec);
    }
    console.log(chalk.gray(`  ${keptFiles.length} segmentos (${allFiles.length - keptFiles.length} removidos)`));

    let s = createSpinner('Juntando segmentos...').start();
    try {
      const allSegPaths = keptFiles.map(f => path.join(segmentsDir, f));
      if (allSegPaths.length > 0) {
        mergeWavSegments(allSegPaths, finalAudioPath);
        s.success({ text: `Audio: ${finalAudioName} (${(fs.statSync(finalAudioPath).size / 1024 / 1024).toFixed(1)}MB)` });
      } else {
        s.warn({ text: 'Nenhum segmento para juntar' });
      }
    } catch (err) {
      s.error({ text: `Merge falhou: ${(err as Error).message}` });
    }

    // 2. Smart transcription: single-pass for ≤1 remote speaker, re-transcribe for multi-speaker
    let fullTranscript = transcriptLines.join('\n');
    if (skippedSilentSegments > 0) {
      const savedCost = (skippedSilentSegments * SEGMENT_SECONDS / 60 * DEEPGRAM_PER_MIN).toFixed(4);
      console.log(chalk.green(`  ${skippedSilentSegments} segmentos silenciosos pulados (economia: ~$${savedCost})`));
    }

    // Re-transcribe when: (a) no segments were processed (short recording), or (b) multi-speaker
    const noSegmentsProcessed = transcribedSegments === 0;
    const needsRetranscription = noSegmentsProcessed || remoteSpeakerIds.size > 1;
    if (needsRetranscription && fs.existsSync(finalAudioPath)) {
      const reason = noSegmentsProcessed
        ? 'gravacao curta, nenhum segmento processado'
        : `${remoteSpeakerIds.size} speakers remotos detectados`;
      s = createSpinner(`Transcrevendo audio completo (${reason})...`).start();
      try {
        const fullText = await transcribeFull(finalAudioPath, config);
        if (fullText.trim()) {
          fullTranscript = fullText;
          s.success({ text: `Transcricao: ${fullText.split('\n').length} linhas` });
        } else {
          s.warn({ text: 'Transcricao vazia' });
        }
      } catch (err) {
        s.warn({ text: `Transcricao falhou: ${(err as Error).message}` });
      }
    } else {
      console.log(chalk.gray(`  Transcricao: ${transcribedSegments} segmentos com nova-3 (single-pass)`));
    }

    if (!fullTranscript.trim()) {
      console.log(chalk.yellow('Transcricao vazia — nota nao criada.'));
      cleanup(segmentsDir);
      return;
    }

    // Speaker identification: voice fingerprint auto-match + manual wizard for unknowns
    const unknownLabels: Array<{ label: string; configKey: string }> = [];
    const speakerPatterns = fullTranscript.matchAll(/\[(Speaker \d+|Remoto \d+)\]/g);
    const seenLabels = new Set<string>();
    for (const m of speakerPatterns) {
      const label = m[1];
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);
      const configKey = label.startsWith('Remoto')
        ? `Speaker ${label.replace('Remoto ', '')}`
        : label;
      if (!config.speakerNames?.[configKey]) {
        unknownLabels.push({ label, configKey });
      }
    }

    // Phase 1: Try voice fingerprint auto-match for unknown speakers
    const voiceMatched: Map<string, string> = new Map();  // label → name
    if (unknownLabels.length > 0 && fs.existsSync(finalAudioPath)) {
      try {
        console.log(chalk.gray('\n  Identificando speakers por voz...'));
        // Use calendar attendees as candidates to narrow search
        const candidates = calendarAttendees.length > 0 ? calendarAttendees : undefined;

        for (const { label } of unknownLabels) {
          // Find timestamp range for this speaker from transcript
          const tag = `[${label}]`;
          const speakerLines = fullTranscript.split('\n').filter(l => l.includes(tag));
          if (speakerLines.length === 0) continue;

          // Extract timestamp from first line: [MM:SS] [Speaker N] text
          const tsMatch = speakerLines[0].match(/\[(\d+):(\d+)\]/);
          const startSec = tsMatch ? parseInt(tsMatch[1]) * 60 + parseInt(tsMatch[2]) : 0;
          // Use ~15 seconds of audio from this speaker's first appearance
          const endSec = startSec + 15;

          const matches = await matchSpeaker(finalAudioPath, candidates, startSec, endSec);
          if (matches.length > 0 && matches[0].similarity >= 0.4) {
            const bestMatch = matches[0];
            voiceMatched.set(label, bestMatch.name);
            console.log(chalk.hex('#98c379')(`    ${label} → ${bestMatch.name} (${(bestMatch.similarity * 100).toFixed(0)}%)`));
          }
        }
      } catch {
        // Voice matching is optional — degrade gracefully
      }
    }

    // Apply voice matches
    for (const [label, name] of voiceMatched) {
      if (!config.speakerNames) config.speakerNames = {};
      const configKey = label.startsWith('Remoto')
        ? `Speaker ${label.replace('Remoto ', '')}`
        : label;
      config.speakerNames[configKey] = name;
      fullTranscript = fullTranscript.replace(new RegExp(`\\[${label}\\]`, 'g'), `[${name}]`);
    }

    // Phase 2: Manual wizard for remaining unknown speakers
    const stillUnknown = unknownLabels.filter(u => !voiceMatched.has(u.label));

    let wizardRl: readline.Interface | null = null;
    try {
      wizardRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    } catch {}

    if (wizardRl && stillUnknown.length > 0) {
      console.log(chalk.bold('\n  Speakers nao identificados:\n'));
      for (const { label } of stillUnknown) {
        const tag = `[${label}]`;
        const lines = fullTranscript.split('\n').filter(l => l.includes(tag));
        const sample = lines.slice(0, 2).map(l => l.replace(tag, '').trim().slice(0, 80)).join(' | ');
        console.log(chalk.cyan(`  ${label}:`) + chalk.gray(` "${sample}"`));
      }
      console.log(chalk.gray('  (Enter para pular, nome para salvar no config)\n'));

      for (const { label, configKey } of stillUnknown) {
        const name = await new Promise<string>((resolve) => {
          wizardRl!.question(chalk.cyan(`  ${label} = `), (answer: string) => {
            resolve(answer.trim());
          });
        });
        if (name) {
          if (!config.speakerNames) config.speakerNames = {};
          config.speakerNames[configKey] = name;
          fullTranscript = fullTranscript.replace(new RegExp(`\\[${label}\\]`, 'g'), `[${name}]`);

          // Auto-enroll new speaker for future meetings
          if (fs.existsSync(finalAudioPath)) {
            try {
              const tsMatch = fullTranscript.split('\n')
                .find(l => l.includes(`[${name}]`))
                ?.match(/\[(\d+):(\d+)\]/);
              const startSec = tsMatch ? parseInt(tsMatch[1]) * 60 + parseInt(tsMatch[2]) : 0;
              const enrolled = await enrollSpeaker(finalAudioPath, name, startSec, startSec + 15);
              if (enrolled) {
                console.log(chalk.gray(`    Voice profile salvo para ${name}`));
              }
            } catch {}
          }
        }
      }

      if (Object.keys(config.speakerNames || {}).length > 0) {
        const { saveConfig } = await import('../config');
        saveConfig(config);
        console.log(chalk.green('  Speaker names salvos no config.'));
      }
    }

    // Post-meeting context: ask for optional extra context to enrich the note
    let postMeetingContext = '';
    if (wizardRl) {
      console.log('');
      const ctx = await new Promise<string>((resolve) => {
        wizardRl!.question(chalk.magenta('  Contexto extra para a nota? ') + chalk.gray('(Enter para pular): '), (answer: string) => {
          resolve(answer.trim());
        });
      });
      if (ctx) {
        postMeetingContext = ctx;
        console.log(chalk.green(`  + Contexto adicionado`));
      }
      wizardRl.close();
    }

    // Smart template detection
    let effectiveTemplate = template;
    if (!effectiveTemplate || effectiveTemplate.name === 'default') {
      const sd = createSpinner('Detectando tipo de reuniao...').start();
      try {
        const detectMessages = [
          { role: 'system', content: 'Analise esta transcricao e responda com UMA UNICA PALAVRA: daily, 1on1, retro, planning, technical, knowledge, ou default.\n\nUse "knowledge" quando a reuniao for de onboarding, treinamento, explicacao de dominio/sistema, transferencia de conhecimento — quando alguem esta ENSINANDO conceitos, regras de negocio, fluxos.\n\nNenhuma outra palavra.' },
          { role: 'user', content: fullTranscript.slice(0, 2000) },
        ];
        const detected = (await chatWithMeetings(detectMessages, config)).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        const detectedTemplate = getTemplate(detected);
        if (detectedTemplate && detectedTemplate.name !== 'default') {
          effectiveTemplate = detectedTemplate;
          sd.success({ text: `Tipo: ${detectedTemplate.label}` });
        } else {
          sd.success({ text: 'Tipo: geral' });
        }
      } catch {
        sd.warn({ text: 'Deteccao falhou, usando template padrao' });
      }
    }

    // Build adaptive prompt: wrapper (based on duration) + template prompt
    const adaptiveWrapper = getAdaptiveWrapper(durationSec);
    const basePrompt = effectiveTemplate && effectiveTemplate.name !== 'default'
      ? effectiveTemplate.prompt
      : config.organizationPrompt;
    const tagInstruction = '\n\nApos a nota, adicione uma ultima linha no formato exato:\nTags: tag1, tag2, tag3\n(maximo 5 tags relevantes: backend, frontend, deploy, produto, financeiro, dados, infraestrutura, seguranca, design, planejamento, retrospectiva, daily, 1on1)';
    const finalPrompt = adaptiveWrapper + basePrompt + tagInstruction;

    const tplLabel = effectiveTemplate && effectiveTemplate.name !== 'default' ? ` ${effectiveTemplate.label}` : '';
    const adaptiveLabel = durationSec < 120 ? ' (quick)' : durationSec < 600 ? ' (short)' : durationSec > 1800 ? ' (deep)' : '';
    s = createSpinner(`Organizando com IA${tplLabel}${adaptiveLabel}...`).start();
    let summary = '';
    let chatCost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;

    // Inject post-meeting context into transcript for richer AI output
    const transcriptForAI = postMeetingContext
      ? `${fullTranscript}\n\n[Contexto do usuario pos-reuniao]: ${postMeetingContext}`
      : fullTranscript;
    const configWithPrompt = { ...config, organizationPrompt: finalPrompt };

    try {
      const result = await organizeTranscript(transcriptForAI, configWithPrompt, {
        meetingDate: date,
        participants: calendarAttendees.length > 0 ? calendarAttendees : undefined,
        extraContext: extraContext.length > 0 ? extraContext.join('\n\n') : undefined,
      });
      summary = result.text;
      chatCost = result.costUsd;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      totalTokens = result.totalTokens;
      s.success({ text: `IA: ${totalTokens} tokens` });
    } catch (err) {
      s.error({ text: `IA falhou: ${(err as Error).message}` });
      summary = '> Organizacao automatica falhou.';
    }

    // Parse title and participants from AI output (first two lines)
    let meetingTitle = '';
    let participants: string[] = [];
    const summaryLines = summary.split('\n');
    if (summaryLines.length >= 1) {
      const firstLine = summaryLines[0].replace(/^#+\s*/, '').trim();
      // Title is first line if it doesn't look like a section header or metadata
      if (firstLine && !firstLine.startsWith('##') && !firstLine.startsWith('|') && !firstLine.startsWith('-')) {
        meetingTitle = firstLine;
        summaryLines.shift();
      }
    }
    if (summaryLines.length >= 1) {
      const participantsLine = summaryLines[0];
      const partMatch = participantsLine.match(/^Participantes:\s*(.+)/i);
      if (partMatch) {
        participants = partMatch[1].split(',').map(p => p.trim()).filter(p => p.length > 0);
        summaryLines.shift();
      }
    }
    // Rebuild summary without title/participants lines
    summary = summaryLines.join('\n').replace(/^\n+/, '');

    if (meetingTitle) {
      console.log(chalk.white(`  Titulo: ${meetingTitle}`));
    }
    if (participants.length > 0) {
      console.log(chalk.gray(`  Participantes: ${participants.join(', ')}`));
    }

    // Extract tags from AI response (consolidated — no separate API call)
    let detectedTags: string[] = [];
    const tagLineMatch = summary.match(/^Tags:\s*(.+)$/mi);
    if (tagLineMatch) {
      detectedTags = tagLineMatch[1].split(',').map(t => t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(t => t.length > 1 && t.length < 30);
      summary = summary.replace(/\n*Tags:\s*.+$/mi, '').trim();
    }
    if (detectedTags.length > 0) {
      console.log(chalk.gray(`  Tags: ${detectedTags.join(', ')}`));
    }

    // Cost: segments transcribed + optional re-transcription for multi-speaker
    const segmentMin = (transcribedSegments * SEGMENT_SECONDS) / 60;
    const retranscribeMin = needsRetranscription ? (durationSec / 60) : 0;
    const deepgramCost = (segmentMin + retranscribeMin) * DEEPGRAM_PER_MIN;
    const noteTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    s = createSpinner('Salvando nota...').start();
    const keepAudio = config.deleteAudioAfterTranscription === false;
    const notePath = await createMeetingNote(config, {
      transcript: fullTranscript,
      summary,
      audioPath: keepAudio ? `Recordings/${finalAudioName}` : undefined,
      durationSec,
      whisperCost: deepgramCost,
      chatCost,
      chatDeployment: config.chatModel,
      inputTokens,
      outputTokens,
      totalTokens,
      date,
      time: noteTime,
      tags: detectedTags,
      title: meetingTitle,
      participants,
      meetingType: templateName,
    });
    s.success({ text: path.basename(notePath) });

    cleanup(segmentsDir);

    const totalCost = (deepgramCost + chatCost).toFixed(4);
    console.log('\n' + boxen(
      `${chalk.bold('Reuniao salva')}\n\n` +
      `${chalk.gray('Nota:')}     ${path.basename(notePath)}\n` +
      `${chalk.gray('Duracao:')}  ${formatTime(Math.round(durationSec))}\n` +
      `${chalk.gray('Custo:')}    $${totalCost}\n` +
      `${chalk.gray('Audio:')}    ${finalAudioName}`,
      {
        padding: 1,
        margin: { top: 0, bottom: 1, left: 2, right: 0 },
        borderStyle: 'round',
        borderColor: 'green',
      }
    ));

    // Delete audio after transcription (compliance/storage)
    if (config.deleteAudioAfterTranscription !== false && fs.existsSync(finalAudioPath)) {
      try {
        fs.unlinkSync(finalAudioPath);
        console.log(chalk.gray(`  Audio deletado (compliance). Desative com: meeting config`));
      } catch {}
    }
  }

  function cleanup(dir: string) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  function cleanupAndExit(code = 0) {
    if (pollInterval) clearInterval(pollInterval);
    if (timerInterval) clearInterval(timerInterval);
    if (insightInterval) clearInterval(insightInterval);
    try { rl?.close(); } catch {}
    ui.teardown();
    cleanup(segmentsDir);
    process.exit(code);
  }

  // ── Resolve sidecar ──
  let sidecarWslPath: string;
  try {
    sidecarWslPath = getSidecarPath();
  } catch (err) {
    console.error(chalk.red(`${(err as Error).message}`));
    process.exit(1);
  }

  const sidecarWinPath = toWinPath(sidecarWslPath);
  const segmentsDirWin = toWinPath(segmentsDir);

  const nodeExe = 'node.exe';
  const captureArgs = [
    sidecarWinPath,
    '--output', segmentsDirWin,
    '--segment-duration', String(SEGMENT_SECONDS),
    '--sample-rate', '16000',
    '--mic-gain', String(config.micGain ?? 1.0),
  ];
  if (config.micDeviceId) {
    captureArgs.push('--mic-device', config.micDeviceId);
  }

  // ── Init UI ──
  const templateLabel = template && template.name !== 'default' ? template.label : '';
  ui.setLabels(templateLabel, topic);
  ui.init();

  // Topic-based context: search past meetings BEFORE recording starts
  if (topic) {
    ui.appendLine(chalk.cyan(`  Buscando contexto para "${topic}"...`));
    try {
      const allSummaries = loadMeetingSummaries(config, 15);
      if (allSummaries.length > 0) {
        const index = allSummaries.map((m, i) => {
          const lines = m.split('\n');
          const dateLine = lines[0];
          const content = lines.slice(1)
            .filter(l => l.trim() && !l.startsWith('##') && !l.startsWith('Participantes:'))
            .slice(0, 2).join(' ').replace(/\*\*/g, '').slice(0, 120);
          return `[${i}] ${dateLine} — ${content}`;
        }).join('\n');

        const messages = [
          {
            role: 'system',
            content: 'Voce recebe um topico/projeto e uma lista de reunioes passadas. '
              + 'Retorne APENAS os numeros (indices) das reunioes que sao semanticamente relevantes para o topico. '
              + 'Considere: mesmo projeto, temas relacionados, continuidade de decisoes. '
              + 'Formato: numeros separados por virgula (ex: 0,3,7). Se nenhuma for relevante, retorne: nenhuma',
          },
          {
            role: 'user',
            content: `# Topico: ${topic}\n\n# Reunioes passadas\n${index}`,
          },
        ];

        const response = await chatWithMeetings(messages, config);
        const trimmed = response.trim().toLowerCase();

        if (trimmed !== 'nenhuma' && trimmed !== 'nenhum') {
          const indices = trimmed.split(/[,\s]+/)
            .map(s => parseInt(s.replace(/[^\d]/g, '')))
            .filter(n => !isNaN(n) && n >= 0 && n < allSummaries.length);

          if (indices.length > 0) {
            const relevant = indices.map(i => allSummaries[i]);
            extraContext.push('# Reunioes relacionadas (topico: ' + topic + ')\n' + relevant.join('\n---\n'));
            semanticContextLoaded = true;

            ui.appendLine(chalk.green(`  ${indices.length} reuniao(oes) relacionada(s) carregada(s):`));
            for (const i of indices) {
              const dateLine = allSummaries[i].split('\n')[0];
              ui.appendLine(chalk.gray(`    ${dateLine}`));
            }
          } else {
            ui.appendLine(chalk.gray('  Nenhuma reuniao anterior sobre este topico.'));
          }
        } else {
          ui.appendLine(chalk.gray('  Nenhuma reuniao anterior sobre este topico.'));
        }
      }
    } catch {
      ui.appendLine(chalk.yellow('  Busca de contexto falhou — continuando sem contexto previo.'));
    }
    ui.appendLine('');
  }

  ui.appendLine(chalk.gray('  Iniciando captura WASAPI...'));
  ui.appendLine('');

  captureProcess = spawn(nodeExe, captureArgs);
  const startTime = Date.now();

  // Suppress EPIPE errors when sidecar stdin closes before we write
  captureProcess.stdin?.on('error', () => {});

  // Parse sidecar JSON events
  let stdoutBuffer = '';
  captureProcess.stdout?.on('data', (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.event === 'started') {
          ui.appendLine(chalk.green('  Captura WASAPI iniciada'));
        } else if (evt.event === 'segment') {
          // Track RMS for silence detection + retroactive trim
          const rmsDb = parseFloat(evt.rmsDb);
          segmentRmsDb.set(evt.index, rmsDb);

          // Mark segments during pause for skipping
          if (paused) {
            const segFile = `seg_${String(evt.index).padStart(3, '0')}.wav`;
            pausedSegments.add(segFile);
          }

          // Early warning: no audio signal at all (dead capture)
          if (evt.index <= 2 && rmsDb <= -99) {
            ui.appendLine(chalk.red.bold('  AVISO: Audio sem sinal! Verifique:'));
            ui.appendLine(chalk.red('    - Dispositivo de saida do Windows (fone/caixa)'));
            ui.appendLine(chalk.red('    - Permissao de microfone no Windows'));
            ui.appendLine(chalk.red('    - Se ha audio tocando no sistema'));
          }

          if (rmsDb < SILENCE_THRESHOLD_DB && !paused) {
            consecutiveSilentSegments++;
            if (consecutiveSilentSegments >= SILENCE_TIMEOUT_SEGMENTS && !stopping) {
              const silenceMin = Math.round(consecutiveSilentSegments * SEGMENT_SECONDS / 60);
              ui.appendLine(chalk.yellow(`  ${silenceMin} min de silencio detectado — parando automaticamente`));
              userRequestedStop = true;
              try { captureProcess?.stdin?.write('q\n'); } catch {}
              setTimeout(() => {
                if (captureProcess && !stopping) captureProcess.kill('SIGINT');
              }, 2000);
            }
          } else {
            consecutiveSilentSegments = 0;
          }
        } else if (evt.event === 'error') {
          ui.appendLine(chalk.yellow(`  ${evt.source}: ${evt.message}`));
        } else if (evt.event === 'stopped') {
          ui.appendLine(chalk.gray(`  Captura encerrada: ${evt.totalSegments} segmentos`));
        }
      } catch {}
    }
  });

  captureProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) ui.appendLine(chalk.gray(`  [sidecar] ${msg}`));
  });

  captureProcess.on('error', (err) => {
    ui.teardown();
    console.error(chalk.red(`Sidecar falhou: ${err.message}`));
    console.error(chalk.gray('Verifique se node.exe (Windows) esta no PATH.'));
    cleanupAndExit(1);
  });

  captureProcess.on('close', async (code) => {
    const durationSec = (Date.now() - startTime) / 1000;
    const isCleanExit = code === 0 || code === null || userRequestedStop;
    if (isCleanExit) {
      await finalize(durationSec);
      cleanupAndExit(0);
    } else {
      ui.teardown();
      console.error(chalk.red(`Sidecar saiu com codigo ${code}`));
      cleanupAndExit(1);
    }
  });

  // Timer — header update + safety limits
  timerInterval = setInterval(() => {
    // Subtract paused time from elapsed
    const rawElapsed = Math.floor((Date.now() - startTime) / 1000);
    const currentPause = paused ? Math.floor((Date.now() - pauseStartTime) / 1000) : 0;
    elapsedSec = rawElapsed - totalPausedSec - currentPause;

    // Update header with current time and live cost estimate (single redraw)
    const segMin = (transcribedSegments * SEGMENT_SECONDS) / 60;
    const liveCost = segMin * DEEPGRAM_PER_MIN;
    ui.updateCost(liveCost);  // store cost first, no redraw
    ui.drawStatusBar(formatTime(elapsedSec), processedSegments.size);  // single redraw

    if (!warned30 && elapsedSec >= WARN_SECONDS) {
      warned30 = true;
      ui.appendLine(chalk.yellow('  30 minutos de gravacao. Limite de 60 min sera avaliado conforme atividade.'));
    }

    if (elapsedSec >= HARD_STOP_SECONDS && captureProcess && !stopping) {
      // Only auto-stop if sustained silence (same threshold as silence auto-stop)
      if (consecutiveSilentSegments >= SILENCE_TIMEOUT_SEGMENTS) {
        ui.appendLine(chalk.red('  60+ minutos e silencio sustentado — parando automaticamente'));
        userRequestedStop = true;
        try { captureProcess.stdin?.write('q\n'); } catch {}
        setTimeout(() => {
          if (captureProcess && !stopping) captureProcess.kill('SIGINT');
        }, 2000);
        return;
      } else if (!warned60) {
        warned60 = true;
        ui.appendLine(chalk.yellow('  60 minutos atingidos, mas voz detectada. Continuando sem limite.'));
      }
    }

  }, 1000);

  startPolling();

  // Auto-insights: first at 2min, then every 3min
  setTimeout(() => {
    runAutoInsight();
    insightInterval = setInterval(runAutoInsight, INSIGHT_INTERVAL_MS);
  }, 2 * 60 * 1000);

  // ── Input handling via TUI ──
  // The new TUI uses raw stdin internally (InputHandler) — no readline needed.
  let rl: { close: () => void } | null = { close() {} };  // stub for cleanup compatibility

  // Semantic context: injected after first transcription (not upfront) or pre-loaded via topic

  function buildSystemMsg(): string {
    const currentTranscript = transcriptLines.join('\n');
    const operatorLine = config.userName
      ? `- Voce esta conversando com ${config.userName}, o operador desta ferramenta (pode ou nao ser um participante da reuniao)`
      : '- Voce esta conversando com o operador desta ferramenta — nao assuma que ele e um dos participantes da transcricao';
    let msg = `<role>Assistente de reuniao em tempo real. Voce esta integrado a uma sessao de gravacao ao vivo.</role>

<behavior>
- Responda em portugues BR, de forma concisa e direta (2-4 frases quando possivel)
- Cruze informacoes da transcricao atual com contexto de reunioes passadas quando relevante
- Se alguem perguntar "o que foi decidido?", consulte a transcricao E reunioes anteriores sobre o mesmo tema
- Se a informacao nao esta disponivel, diga "nao encontrei isso na transcricao ou contexto" — nao invente
- Use nomes reais dos participantes quando identificaveis
${operatorLine}
</behavior>\n\n`;

    if (extraContext.length > 0) {
      msg += '# Contexto (reunioes passadas, documentos, participantes)\n' + extraContext.join('\n\n') + '\n\n';
    }

    if (currentTranscript.trim()) {
      msg += '# Transcricao ao vivo (atualizada em tempo real)\n' + currentTranscript + '\n\n';
    }

    return msg;
  }

  ui.raw.onSubmit(async (input: string) => {
    const text = input.trim();
    if (!text) return;

    const cmd = text.replace(/^\/+/, '').toLowerCase();

    if (cmd === 'stop' || cmd === 'parar') {
      userRequestedStop = true;
      ui.appendLine(chalk.blue('  Parando gravacao... aguarde a finalizacao.'));
      if (captureProcess && !stopping) {
        try { captureProcess.stdin?.write('q\n'); } catch {}
        setTimeout(() => {
          if (captureProcess && !stopping) captureProcess.kill('SIGINT');
        }, 3000);
      }
      return;
    }

    if (cmd === 'pause' || cmd === 'pausar' || cmd === 'resume' || cmd === 'retomar') {
      if (!paused) {
        // Pause
        paused = true;
        pauseStartTime = Date.now();
        pausedAtSec = elapsedSec;
        ui.setPaused(true);
        ui.appendLine(chalk.hex('#e5c07b')('  ⏸ Gravação pausada. /pause para retomar.'));
      } else {
        // Resume
        const pauseDuration = Math.floor((Date.now() - pauseStartTime) / 1000);
        totalPausedSec += pauseDuration;
        paused = false;
        ui.setPaused(false);
        ui.appendLine(chalk.hex('#98c379')(`  ▶ Gravação retomada. (pausa: ${formatTime(pauseDuration)})`));
      }
      return;
    }

    if (cmd === 'help' || cmd === 'ajuda') {
      ui.appendLine('');
      ui.appendLine(chalk.bold('  Comandos durante gravação:'));
      ui.appendLine('');
      ui.appendLine(`  ${chalk.green('/stop')}              Para a gravação e finaliza`);
      ui.appendLine(`  ${chalk.green('/pause')}             Pausa/retoma a gravação`);
      ui.appendLine(`  ${chalk.green('/ctx')} ${chalk.cyan('<arquivo>')}     Adiciona arquivo do vault como contexto`);
      ui.appendLine(`  ${chalk.green('/ctx')} ${chalk.cyan('<texto>')}       Adiciona texto livre como contexto`);
      ui.appendLine(`  ${chalk.green('/contexto')}          Mostra contextos carregados`);
      ui.appendLine(`  ${chalk.green('/help')}              Mostra este menu`);
      ui.appendLine('');
      ui.appendLine(chalk.gray('  Digite qualquer texto para perguntar à IA sobre a reunião.'));
      ui.appendLine(chalk.gray('  A IA tem acesso à transcrição em tempo real + contextos carregados.'));
      ui.appendLine('');
      return;
    }

    // /ctx bare (no args) — show usage hint
    if (cmd === 'ctx') {
      ui.appendLine(chalk.yellow('  Uso: /ctx <arquivo.md> ou /ctx <texto livre>'));
      ui.appendLine(chalk.gray('  /contexto para ver contextos carregados'));
      return;
    }

    // /ctx <arg> command — add context from file or free text
    if (cmd.startsWith('ctx ') || cmd.startsWith('contexto ')) {
      const arg = text.replace(/^\/+\w+\s+/, '').trim();
      if (!arg) {
        ui.appendLine(chalk.yellow('  Uso: /ctx <arquivo.md> ou /ctx <texto livre>'));
        return;
      }

      // Try to load as file from vault
      const candidates = [
        path.join(config.vaultPath, arg),
        path.join(config.vaultPath, arg + '.md'),
        path.resolve(arg),
      ];
      let loaded = false;
      for (const filePath of candidates) {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const preview = content.slice(0, 200).replace(/\n/g, ' ');
            extraContext.push(`# ${path.basename(filePath)}\n${content}`);
            ui.appendLine(chalk.green(`  + ${path.basename(filePath)} adicionado ao contexto`));
            ui.appendLine(chalk.gray(`    ${preview}...`));
            loaded = true;
            break;
          } catch {}
        }
      }

      if (!loaded) {
        // Treat as free text context
        extraContext.push(`# Nota do usuario\n${arg}`);
        ui.appendLine(chalk.green(`  + Contexto adicionado: "${arg.slice(0, 60)}${arg.length > 60 ? '...' : ''}"`));
      }
      return;
    }

    // /contexto — show loaded contexts
    if (cmd === 'contexto' || cmd === 'context') {
      if (extraContext.length === 0) {
        ui.appendLine(chalk.gray('  Nenhum contexto extra carregado.'));
      } else {
        ui.appendLine(chalk.bold(`  ${extraContext.length} contexto(s) carregado(s):`));
        for (const ctx of extraContext) {
          const firstLine = ctx.split('\n')[0].replace(/^# /, '');
          ui.appendLine(chalk.gray(`    - ${firstLine}`));
        }
      }
      return;
    }

    if (chatBusy) {
      ui.appendLine(chalk.yellow('  Aguarde a resposta anterior...'));
      return;
    }

    chatBusy = true;

    ui.appendChatUser(text);
    ui.appendLine(chalk.gray('  pensando...'));

    const messages = [
      { role: 'system', content: buildSystemMsg() },
      ...chatHistory,
      { role: 'user', content: text },
    ];

    try {
      const response = await chatWithMeetings(messages, config);
      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: response });
      while (chatHistory.length > 20) chatHistory.shift();

      for (const rline of response.split('\n')) {
        const trimmed = rline.trim();
        if (trimmed) {
          ui.appendChatAI(trimmed);
        }
      }
      ui.appendLine('');
    } catch (err) {
      ui.appendLine(chalk.red(`  Erro: ${(err as Error).message}`));
    }

    chatBusy = false;
  });

  // Ctrl+C / stop signal — graceful shutdown
  ui.raw.onSignal((signal) => {
    if (signal === 'stop') {
      if (userRequestedStop) {
        cleanupAndExit(1);
      }
      userRequestedStop = true;
      ui.appendLine(chalk.blue('  Parando gravacao... aguarde a finalizacao.'));
      ui.drawInputBar(' Finalizando...');
      if (captureProcess && !stopping) {
        try { captureProcess.stdin?.write('q\n'); } catch {}
        setTimeout(() => {
          if (captureProcess && !stopping) captureProcess.kill('SIGINT');
        }, 3000);
      } else {
        cleanupAndExit(0);
      }
    }
  });
}
