import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import { createSpinner } from 'nanospinner';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { requireConfig } from '../config';
import { transcribeFile, transcribeFull } from '../services/transcriber';
import { organizeTranscript, chatWithMeetings } from '../services/organizer';
import { createMeetingNote, loadMeetingSummaries } from '../services/storage';
import { getSidecarCapturePath } from './setup';
import { getTemplate, listTemplates, getAdaptiveWrapper } from '../services/templates';

const DEEPGRAM_PER_MIN = 0.006;
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

// ── Terminal UI (simple flowing output) ──────────────────────────
// No alt screen, no scroll regions — just normal stdout.
// Scrollback preserved, scroll/resize safe.

class TerminalUI {
  init() {}

  drawStatusBar(_time: string, _segments: number, _extra?: string) {
    // No-op: status is shown inline with appendLine
  }

  drawInputBar(_hint?: string) {}

  // Print a line — simple, no cursor tricks
  appendLine(text: string) {
    console.log(text);
  }

  // Show a status separator (only when content arrives, not on timer)
  showStatus(time: string, segments: number) {
    console.log(chalk.dim(`  ── ${time} | ${segments} seg ──`));
  }

  teardown() {}
}

const INSIGHT_PROMPT = `Voce esta acompanhando uma reuniao em tempo real. Analise a transcricao e extraia APENAS os pontos mais importantes.

Formato (exatamente):
- [decisao] texto curto
- [acao] texto curto com responsavel se mencionado
- [ponto] insight ou tema relevante
- [risco] preocupacao ou blocker mencionado

Regras:
- Maximo 5 bullets
- Sem introducao ou conclusao
- Se nada relevante: (sem pontos relevantes ainda)
- Portugues`;

export async function cmdStart(opts: { template?: string } = {}): Promise<void> {
  const config = requireConfig();

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
  let insightInterval: NodeJS.Timeout | null = null;
  let lastInsightLineCount = 0;
  let insightBusy = false;
  let chatBusy = false;
  let consecutiveSilentSegments = 0;
  const segmentRmsDb: Map<number, number> = new Map();

  const ui = new TerminalUI();
  const chatHistory: Array<{ role: string; content: string }> = [];

  function showTimestamp() {
    ui.showStatus(formatTime(elapsedSec), processedSegments.size);
  }

  async function transcribeSegment(segPath: string, offsetSec: number): Promise<void> {
    try {
      const stat = fs.statSync(segPath);
      if (stat.size < 4096) return;

      ui.appendLine(chalk.gray(`  transcrevendo ${path.basename(segPath)}...`));
      const text = await transcribeFile(segPath, config);
      if (!text) return;

      const line = `${formatTimestamp(offsetSec)} ${text}`;
      transcriptLines.push(line);

      // Show each speaker line separately for readability
      for (const speakerLine of text.split('\n')) {
        if (speakerLine.trim()) {
          ui.appendLine(chalk.cyan(`  ${formatTimestamp(offsetSec)} `) + speakerLine.trim());
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
          await transcribeSegment(path.join(segmentsDir, seg), segIndex * SEGMENT_SECONDS);
          showTimestamp();
        }
      }
    }, 2000);
  }

  async function runAutoInsight() {
    if (insightBusy || chatBusy || stopping) return;
    if (transcriptLines.length <= lastInsightLineCount) return;
    if (transcriptLines.length < 3) return;

    insightBusy = true;
    const currentTranscript = transcriptLines.join('\n');
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
        const prefix = mentionsMe ? chalk.bgYellow.black(' >> ') + ' ' : '  ';

        if (t.includes('[decisao]')) {
          ui.appendLine(prefix + (mentionsMe ? chalk.green.bold(t) : chalk.green(t)));
        } else if (t.includes('[acao]')) {
          ui.appendLine(prefix + (mentionsMe ? chalk.cyan.bold(t) : chalk.cyan(t)));
        } else if (t.includes('[risco]')) {
          ui.appendLine(prefix + (mentionsMe ? chalk.red.bold(t) : chalk.red(t)));
        } else if (t.includes('[ponto]')) {
          ui.appendLine(prefix + (mentionsMe ? chalk.white.bold(t) : chalk.white(t)));
        } else {
          ui.appendLine(prefix + (mentionsMe ? chalk.bold(t) : chalk.gray(t)));
        }
      }
      ui.appendLine(chalk.gray('  ─────────────────────────────────────────'));
      ui.appendLine('');
    } catch {
      // insights are optional
    }

    insightBusy = false;
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

    // 2. Re-transcribe full audio with nova-3 + diarization + speaker names
    let fullTranscript = transcriptLines.join('\n'); // fallback: live segments

    if (fs.existsSync(finalAudioPath)) {
      s = createSpinner('Re-transcrevendo com nova-3 + diarizacao...').start();
      try {
        const fullText = await transcribeFull(finalAudioPath, config);
        if (fullText.trim()) {
          fullTranscript = fullText;
          s.success({ text: `Transcricao final: ${fullText.split('\n').length} linhas com diarizacao` });
        } else {
          s.warn({ text: 'Re-transcricao vazia, usando segmentos' });
        }
      } catch (err) {
        s.warn({ text: `Re-transcricao falhou, usando segmentos: ${(err as Error).message}` });
      }
    }

    if (!fullTranscript.trim()) {
      console.log(chalk.yellow('Transcricao vazia — nota nao criada.'));
      cleanup(segmentsDir);
      return;
    }

    // Speaker naming wizard: find unknown speakers and ask user
    const speakerRegex = /\[Speaker (\d+)\]/g;
    const speakerIds = new Set<string>();
    let speakerMatch: RegExpExecArray | null;
    while ((speakerMatch = speakerRegex.exec(fullTranscript)) !== null) {
      speakerIds.add(speakerMatch[1]);
    }

    if (speakerIds.size > 0) {
      const unknownSpeakers: string[] = [];
      for (const id of speakerIds) {
        if (!config.speakerNames?.[`Speaker ${id}`]) {
          unknownSpeakers.push(id);
        }
      }

      if (unknownSpeakers.length > 0) {
        // Recreate readline for the wizard (original may be closed by Ctrl+C)
        let wizardRl: readline.Interface | null = null;
        try {
          wizardRl = readline.createInterface({ input: process.stdin, output: process.stdout });
        } catch {}

        if (wizardRl) {
          console.log(chalk.bold('\n  Identificacao de speakers:\n'));
          for (const id of unknownSpeakers) {
            const label = `[Speaker ${id}]`;
            const lines = fullTranscript.split('\n').filter(l => l.includes(label));
            const sample = lines.slice(0, 2).map(l => l.replace(label, '').trim().slice(0, 80)).join(' | ');
            console.log(chalk.cyan(`  Speaker ${id}:`) + chalk.gray(` "${sample}"`));
          }
          console.log(chalk.gray('  (Enter para pular, nome para salvar no config)\n'));

          const askRl = wizardRl;
          for (const id of unknownSpeakers) {
            const name = await new Promise<string>((resolve) => {
              askRl.question(chalk.cyan(`  Speaker ${id} = `), (answer: string) => {
                resolve(answer.trim());
              });
            });
            if (name) {
              if (!config.speakerNames) config.speakerNames = {};
              config.speakerNames[`Speaker ${id}`] = name;
              fullTranscript = fullTranscript.replace(new RegExp(`\\[Speaker ${id}\\]`, 'g'), `[${name}]`);
            }
          }
          askRl.close();

          // Save updated config with new speaker names
          if (Object.keys(config.speakerNames || {}).length > 0) {
            const { saveConfig } = await import('../config');
            saveConfig(config);
            console.log(chalk.green('  Speaker names salvos no config.\n'));
          }
        }
      }
    }

    // Smart template detection
    let effectiveTemplate = template;
    if (!effectiveTemplate || effectiveTemplate.name === 'default') {
      const sd = createSpinner('Detectando tipo de reuniao...').start();
      try {
        const detectMessages = [
          { role: 'system', content: 'Analise esta transcricao e responda com UMA UNICA PALAVRA: daily, 1on1, retro, planning, technical, ou default. Nenhuma outra palavra.' },
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
    const finalPrompt = adaptiveWrapper + basePrompt;

    const templateLabel = effectiveTemplate && effectiveTemplate.name !== 'default' ? ` ${effectiveTemplate.label}` : '';
    const adaptiveLabel = durationSec < 120 ? ' (quick)' : durationSec < 600 ? ' (short)' : durationSec > 1800 ? ' (deep)' : '';
    s = createSpinner(`Organizando com IA${templateLabel}${adaptiveLabel}...`).start();
    let summary = '';
    let chatCost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;

    const configWithPrompt = { ...config, organizationPrompt: finalPrompt };

    try {
      const result = await organizeTranscript(fullTranscript, configWithPrompt);
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

    // Auto-detect meeting tags (combined with title for better detection)
    let detectedTags: string[] = [];
    try {
      const tagMessages = [
        { role: 'system', content: 'Analise esta transcricao e retorne tags relevantes para categorizar a reuniao. Retorne APENAS uma lista separada por virgula, sem explicacao. Exemplos de tags: backend, frontend, deploy, produto, financeiro, dados, infraestrutura, seguranca, design, planejamento, retrospectiva, daily, 1on1. Maximo 5 tags.' },
        { role: 'user', content: (meetingTitle + '\n' + fullTranscript).slice(0, 3000) },
      ];
      const tagResponse = (await chatWithMeetings(tagMessages, config)).trim();
      detectedTags = tagResponse.split(',').map(t => t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(t => t.length > 1 && t.length < 30);
      if (detectedTags.length > 0) {
        console.log(chalk.gray(`  Tags: ${detectedTags.join(', ')}`));
      }
    } catch {}

    const deepgramCost = (durationSec / 60) * DEEPGRAM_PER_MIN;
    const noteTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    s = createSpinner('Salvando nota...').start();
    const notePath = await createMeetingNote(config, {
      transcript: fullTranscript,
      summary,
      audioPath: `Recordings/${finalAudioName}`,
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
  console.log('\n' + gradient(['#ff6b6b', '#ffd93d', '#6bcb77'])('  Meeting CLI') + chalk.gray(' v1.1.0'));
  console.log(chalk.gray('  /stop = parar  |  /help = comandos  |  digite = chat ao vivo\n'));
  ui.init();

  if (template && template.name !== 'default') {
    ui.appendLine(chalk.magenta(`  Template: ${template.label}`));
  }

  // Meeting briefing
  try {
    const recentMeetings = loadMeetingSummaries(config, 3);
    if (recentMeetings.length > 0) {
      const briefingLines: string[] = [];
      for (const m of recentMeetings) {
        const lines = m.split('\n');
        const dateLine = lines[0]; // [YYYY-MM-DD HH:MM]
        // Get first meaningful content line (skip headers, empty lines, participant lists)
        const contentLines = lines.slice(1)
          .filter(l => l.trim() && !l.startsWith('##') && !l.startsWith('- [Speaker') && !l.startsWith('- **Speaker') && !l.startsWith('Participantes:'));
        const preview = contentLines.slice(0, 2).join(' ').replace(/\*\*/g, '').slice(0, 100);
        briefingLines.push(`${chalk.white(dateLine)}`);
        if (preview.trim()) briefingLines.push(`${chalk.gray(preview)}...`);
      }
      console.log(boxen(briefingLines.join('\n'), {
        title: 'Briefing',
        titleAlignment: 'left',
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        margin: { top: 0, bottom: 0, left: 2, right: 0 },
        borderStyle: 'round',
        borderColor: 'gray',
        dimBorder: true,
      }));
    }
  } catch {}

  ui.appendLine('');
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

          // Early warning: no audio signal at all (dead capture)
          if (evt.index <= 2 && rmsDb <= -99) {
            ui.appendLine(chalk.red.bold('  AVISO: Audio sem sinal! Verifique:'));
            ui.appendLine(chalk.red('    - Dispositivo de saida do Windows (fone/caixa)'));
            ui.appendLine(chalk.red('    - Permissao de microfone no Windows'));
            ui.appendLine(chalk.red('    - Se ha audio tocando no sistema'));
          }

          if (rmsDb < SILENCE_THRESHOLD_DB) {
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

  // Timer — status bar update + safety limits
  timerInterval = setInterval(() => {
    elapsedSec = Math.floor((Date.now() - startTime) / 1000);

    if (!warned30 && elapsedSec >= WARN_SECONDS) {
      warned30 = true;
      ui.appendLine(chalk.yellow('  30 minutos de gravacao. Auto-stop em 30 min.'));
    }

    if (elapsedSec >= HARD_STOP_SECONDS && captureProcess && !stopping) {
      ui.appendLine(chalk.red('  60 minutos — parando automaticamente'));
      userRequestedStop = true;
      try { captureProcess.stdin?.write('q\n'); } catch {}
      setTimeout(() => {
        if (captureProcess && !stopping) captureProcess.kill('SIGINT');
      }, 2000);
      return;
    }

  }, 1000);

  startPolling();

  // Auto-insights: first at 2min, then every 3min
  setTimeout(() => {
    runAutoInsight();
    insightInterval = setInterval(runAutoInsight, INSIGHT_INTERVAL_MS);
  }, 2 * 60 * 1000);

  // ── Readline for chat ──
  let rl: readline.Interface | null = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: '',
  });

  // Context system: auto-loaded + user-added via /ctx
  const extraContext: string[] = [];

  // Auto-load recent meeting summaries as context
  try {
    const recentMeetings = loadMeetingSummaries(config, 5);
    if (recentMeetings.length > 0) {
      extraContext.push('# Reunioes recentes\n' + recentMeetings.join('\n---\n'));
    }
  } catch {}

  function buildSystemMsg(): string {
    const currentTranscript = transcriptLines.join('\n');
    let msg = 'Voce e um assistente em tempo real durante uma reuniao. Responda em portugues, de forma concisa e direta.\n\n';

    if (extraContext.length > 0) {
      msg += '# Contexto adicional\n' + extraContext.join('\n\n') + '\n\n';
    }

    if (currentTranscript.trim()) {
      msg += '# Transcricao da reuniao em andamento\n' + currentTranscript + '\n\n';
    }

    msg += 'Responda baseado na transcricao e no contexto. Se a informacao nao esta disponivel, diga isso.';
    return msg;
  }

  rl.on('line', async (input: string) => {
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

    if (cmd === 'help' || cmd === 'ajuda') {
      ui.appendLine(chalk.gray('  /stop          — para a gravacao'));
      ui.appendLine(chalk.gray('  /ctx <arquivo> — adiciona arquivo do vault como contexto'));
      ui.appendLine(chalk.gray('  /ctx <texto>   — adiciona texto livre como contexto'));
      ui.appendLine(chalk.gray('  /contexto      — mostra contextos carregados'));
      ui.appendLine(chalk.gray('  /help          — mostra comandos'));
      ui.appendLine(chalk.gray('  <texto>        — pergunta a IA sobre a reuniao'));
      return;
    }

    // /ctx command — add context from file or free text
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

    ui.appendLine(chalk.bold.blue('  > ') + chalk.white(text));
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
        if (rline.trim()) {
          ui.appendLine(chalk.blue('    ') + rline);
        }
      }
      ui.appendLine('');
    } catch (err) {
      ui.appendLine(chalk.red(`  Erro: ${(err as Error).message}`));
    }

    chatBusy = false;
  });

  // Ctrl+C — graceful shutdown
  process.on('SIGINT', () => {
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
  });
}
