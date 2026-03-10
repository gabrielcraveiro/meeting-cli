import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import { requireConfig } from '../config';
import { transcribeFile } from '../services/transcriber';
import { organizeTranscript, chatWithMeetings } from '../services/organizer';
import { createMeetingNote } from '../services/storage';
import { getSidecarCapturePath } from './setup';
import { getTemplate, listTemplates } from '../services/templates';

const DEEPGRAM_PER_MIN = 0.006;
const SEGMENT_SECONDS = 10;
const WARN_SECONDS = 30 * 60;   // 30 min — aviso
const HARD_STOP_SECONDS = 60 * 60; // 60 min — para automaticamente

// WSL ↔ Windows path conversion
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

// Resolve sidecar path — prefers ~/.config/meeting-cli/sidecar (installed via setup)
function getSidecarPath(): string {
  // Primary: installed via `meeting setup`
  const setupPath = getSidecarCapturePath();
  if (fs.existsSync(setupPath)) return setupPath;

  // Fallback: project sidecar directory (dev mode)
  const candidates = [
    path.resolve(__dirname, '..', 'sidecar', 'capture.js'),
    path.resolve(__dirname, '..', '..', 'sidecar', 'capture.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error('Sidecar não encontrado. Rode: meeting setup');
}

// Merge WAV segments into a single WAV file
function mergeWavSegments(segmentPaths: string[], outputPath: string): void {
  if (segmentPaths.length === 0) return;

  // Read first file to get WAV header params
  const firstBuf = fs.readFileSync(segmentPaths[0]);
  const channels = firstBuf.readUInt16LE(22);
  const sampleRate = firstBuf.readUInt32LE(24);
  const bitsPerSample = firstBuf.readUInt16LE(34);

  // Collect all PCM data (skip 44-byte header from each segment)
  const pcmChunks: Buffer[] = [];
  let totalPcmSize = 0;
  for (const segPath of segmentPaths) {
    const buf = fs.readFileSync(segPath);
    const pcm = buf.subarray(44);
    pcmChunks.push(pcm);
    totalPcmSize += pcm.length;
  }

  // Write merged WAV
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + totalPcmSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(totalPcmSize, 40);

  fs.writeFileSync(outputPath, Buffer.concat([header, ...pcmChunks]));
}

export async function cmdStart(opts: { template?: string } = {}): Promise<void> {
  const config = requireConfig();

  // Resolve template
  const templateName = opts.template || 'default';
  const template = getTemplate(templateName);
  if (opts.template && !template) {
    console.error(chalk.red(`❌ Template "${opts.template}" não encontrado.`));
    console.log(chalk.gray('Templates disponíveis: ' + listTemplates().map(t => t.name).join(', ')));
    process.exit(1);
  }

  // Setup dirs
  const recordingsDir = path.join(config.vaultPath, 'Recordings');
  const now = new Date();
  const sessionId = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const segmentsDir = path.join(recordingsDir, `.tmp-${sessionId}`);
  fs.mkdirSync(segmentsDir, { recursive: true });
  fs.mkdirSync(recordingsDir, { recursive: true });

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
  let rl: readline.Interface | null = null;

  function redrawHeader() {
    process.stdout.write(`\r${chalk.red('●')} Gravando ${chalk.yellow(formatTime(elapsedSec))} | Ctrl+C para parar  `);
  }

  async function transcribeSegment(segPath: string, offsetSec: number): Promise<void> {
    try {
      const stat = fs.statSync(segPath);
      if (stat.size < 4096) {
        console.log(chalk.gray(`   ⏭ ${path.basename(segPath)}: muito pequeno (${stat.size}B), pulando`));
        return;
      }

      process.stdout.write(`\n${chalk.gray(`   🎤 Transcrevendo ${path.basename(segPath)} (${(stat.size / 1024).toFixed(1)}KB)...`)}`);
      redrawHeader();
      const text = await transcribeFile(segPath, config);
      if (!text) {
        process.stdout.write(`\n${chalk.yellow(`   ⚠ ${path.basename(segPath)}: transcript vazio`)}`);
        redrawHeader();
        return;
      }

      const line = `${formatTimestamp(offsetSec)} ${text}`;
      transcriptLines.push(line);
      process.stdout.write('\n' + chalk.cyan(line));
      redrawHeader();
    } catch (err) {
      process.stderr.write(`\n${chalk.yellow('⚠ Segmento falhou:')} ${(err as Error).message}`);
    }
  }

  function startPolling() {
    pollInterval = setInterval(async () => {
      const files = fs.readdirSync(segmentsDir)
        .filter(f => f.endsWith('.wav') && f.startsWith('seg_'))
        .sort();

      // Process all segments except the last (may still be writing)
      for (let i = 0; i < files.length - 1; i++) {
        const seg = files[i];
        if (!processedSegments.has(seg)) {
          processedSegments.add(seg);
          const segIndex = parseInt(seg.replace('seg_', '').replace('.wav', ''));
          await transcribeSegment(path.join(segmentsDir, seg), segIndex * SEGMENT_SECONDS);
        }
      }
    }, 2000);
  }

  async function finalize(durationSec: number) {
    if (stopping) return;
    stopping = true;

    if (pollInterval) clearInterval(pollInterval);
    if (timerInterval) clearInterval(timerInterval);

    process.stdout.write('\n\n');
    console.log(chalk.blue('⏳ Finalizando transcrição...'));

    const allFiles = fs.readdirSync(segmentsDir)
      .filter(f => f.endsWith('.wav') && f.startsWith('seg_'))
      .sort();
    console.log(chalk.gray(`   Segmentos encontrados: ${allFiles.length}`));

    // Transcribe remaining segments
    const remaining = allFiles.filter(f => !processedSegments.has(f));
    for (const seg of remaining) {
      processedSegments.add(seg);
      const segIndex = parseInt(seg.replace('seg_', '').replace('.wav', ''));
      await transcribeSegment(path.join(segmentsDir, seg), segIndex * SEGMENT_SECONDS);
    }

    // Merge segments into final recording
    console.log(chalk.blue('🔗 Juntando segmentos...'));
    try {
      const allSegPaths = allFiles.map(f => path.join(segmentsDir, f));
      if (allSegPaths.length > 0) {
        mergeWavSegments(allSegPaths, finalAudioPath);
        console.log(chalk.gray(`   Áudio salvo: ${finalAudioName} (${(fs.statSync(finalAudioPath).size / 1024 / 1024).toFixed(1)}MB)`));
      }
    } catch (err) {
      console.warn(chalk.yellow(`⚠ Merge falhou: ${(err as Error).message}`));
    }

    const fullTranscript = transcriptLines.join('\n');

    if (!fullTranscript.trim()) {
      console.log(chalk.yellow('⚠ Transcrição vazia — nota não criada.'));
      cleanup(segmentsDir);
      return;
    }

    // Organize with AI (use template prompt if specified)
    const templateLabel = template ? ` (${template.label})` : '';
    console.log(chalk.blue(`🤖 Organizando com IA${templateLabel}...`));
    let summary = '';
    let chatCost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;

    const configWithPrompt = template
      ? { ...config, organizationPrompt: template.prompt }
      : config;

    try {
      const result = await organizeTranscript(fullTranscript, configWithPrompt);
      summary = result.text;
      chatCost = result.costUsd;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      totalTokens = result.totalTokens;
    } catch (err) {
      console.warn(chalk.yellow(`⚠ IA falhou: ${(err as Error).message}`));
      summary = '> Organização automática falhou.';
    }

    const deepgramCost = (durationSec / 60) * DEEPGRAM_PER_MIN;
    const noteTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

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
    });

    cleanup(segmentsDir);

    const totalCost = (deepgramCost + chatCost).toFixed(4);
    console.log(chalk.green(`\n✅ Reunião salva: ${path.basename(notePath)}`));
    console.log(chalk.gray(`   Duração: ${formatTime(Math.round(durationSec))} | Custo: $${totalCost}`));
  }

  function cleanup(dir: string) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  // Resolve sidecar
  let sidecarWslPath: string;
  try {
    sidecarWslPath = getSidecarPath();
  } catch (err) {
    console.error(chalk.red(`❌ ${(err as Error).message}`));
    process.exit(1);
  }

  // node.exe needs Windows-style paths
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

  console.log(chalk.bold('\n🎙  Meeting CLI — Gravação (WASAPI)\n'));
  if (template && template.name !== 'default') {
    console.log(chalk.magenta(`Template: ${template.label} — ${template.description}`));
  }
  console.log(chalk.gray(`Sidecar: ${sidecarWinPath}`));
  console.log(chalk.gray(`Segmentos: ${segmentsDir}`));
  console.log(chalk.gray(`Áudio final: ${finalAudioPath}`));
  console.log(chalk.gray(`\nDigite uma pergunta para chat ao vivo com IA | /stop para parar | /help\n`));

  captureProcess = spawn(nodeExe, captureArgs);
  const startTime = Date.now();

  // Parse JSON events from sidecar stdout
  let stdoutBuffer = '';
  captureProcess.stdout?.on('data', (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.event === 'segment') {
          process.stdout.write(`\n${chalk.gray(`   📦 Segmento ${evt.index}: ${evt.durationSec}s | sys=${evt.peakSys} mic=${evt.peakMic}`)}`);
          redrawHeader();
        } else if (evt.event === 'error') {
          process.stdout.write(`\n${chalk.yellow(`   ⚠ ${evt.source}: ${evt.message}`)}`);
          redrawHeader();
        } else if (evt.event === 'started') {
          process.stdout.write(`\n${chalk.green('   ✓ Captura WASAPI iniciada')}`);
          redrawHeader();
        } else if (evt.event === 'stopped') {
          process.stdout.write(`\n${chalk.gray(`   Captura encerrada: ${evt.totalSegments} segmentos`)}`);
        }
      } catch {
        // Non-JSON output, ignore
      }
    }
  });

  captureProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(chalk.gray(`   [sidecar] ${msg}`));
  });

  function cleanupAndExit(code = 0) {
    if (pollInterval) clearInterval(pollInterval);
    if (timerInterval) clearInterval(timerInterval);
    try { rl?.close(); } catch {}
    cleanup(segmentsDir);
    process.exit(code);
  }

  captureProcess.on('error', (err) => {
    console.error(chalk.red(`\n❌ Sidecar falhou: ${err.message}`));
    console.error(chalk.gray('   Verifique se node.exe (Windows) está no PATH.'));
    cleanupAndExit(1);
  });

  captureProcess.on('close', async (code) => {
    const durationSec = (Date.now() - startTime) / 1000;
    const isCleanExit = code === 0 || code === null || userRequestedStop;
    if (isCleanExit) {
      await finalize(durationSec);
      cleanupAndExit(0);
    } else {
      console.error(chalk.red(`\n❌ Sidecar saiu com código ${code}`));
      cleanupAndExit(1);
    }
  });

  // Timer with 30min warning and 60min hard stop
  timerInterval = setInterval(() => {
    elapsedSec = Math.floor((Date.now() - startTime) / 1000);

    // 30 min warning
    if (!warned30 && elapsedSec >= WARN_SECONDS) {
      warned30 = true;
      process.stdout.write(`\n${chalk.bgYellow.black(' ⚠ 30 minutos de gravação! Ctrl+C para parar. Auto-stop em 30 min. ')}`);
    }

    // 60 min hard stop
    if (elapsedSec >= HARD_STOP_SECONDS && captureProcess && !stopping) {
      process.stdout.write(`\n${chalk.bgRed.white(' ⏹ 60 minutos — parando gravação automaticamente ')}`);
      userRequestedStop = true;
      try { captureProcess.stdin?.write('q\n'); } catch {}
      setTimeout(() => {
        if (captureProcess && !stopping) captureProcess.kill('SIGINT');
      }, 2000);
      return;
    }

    redrawHeader();
  }, 1000);

  startPolling();
  redrawHeader();

  // Live chat during recording
  const chatHistory: Array<{ role: string; content: string }> = [];
  let chatBusy = false;

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: '',
  });

  // Suppress default readline output during recording
  rl.on('line', async (input: string) => {
    const text = input.trim();
    if (!text) {
      redrawHeader();
      return;
    }

    if (text === '/stop' || text === '/parar') {
      userRequestedStop = true;
      if (captureProcess && !stopping) {
        try { captureProcess.stdin?.write('q\n'); } catch {}
        setTimeout(() => {
          if (captureProcess && !stopping) captureProcess.kill('SIGINT');
          setTimeout(() => process.exit(0), 2000);
        }, 2000);
      }
      return;
    }

    if (text === '/help') {
      process.stdout.write('\n' + chalk.gray('  /stop     — para a gravação'));
      process.stdout.write('\n' + chalk.gray('  /help     — mostra comandos'));
      process.stdout.write('\n' + chalk.gray('  <texto>   — pergunta à IA sobre a reunião em andamento\n'));
      redrawHeader();
      return;
    }

    if (chatBusy) {
      process.stdout.write('\n' + chalk.yellow('  ⏳ Aguarde a resposta anterior...\n'));
      redrawHeader();
      return;
    }

    chatBusy = true;
    const currentTranscript = transcriptLines.join('\n');

    if (!currentTranscript.trim()) {
      process.stdout.write('\n' + chalk.yellow('  ⚠ Ainda sem transcrição para contexto.\n'));
      chatBusy = false;
      redrawHeader();
      return;
    }

    process.stdout.write('\n' + chalk.gray('  🤖 Pensando...'));

    const systemMsg = `Você é um assistente em tempo real durante uma reunião. Responda em português, de forma concisa e direta.
Aqui está a transcrição parcial da reunião em andamento:

${currentTranscript}

Responda a pergunta do usuário baseado nesta transcrição. Se a informação não estiver na transcrição, diga isso.`;

    const messages = [
      { role: 'system', content: systemMsg },
      ...chatHistory,
      { role: 'user', content: text },
    ];

    try {
      const response = await chatWithMeetings(messages, config);
      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: response });

      // Keep chat history manageable (last 10 exchanges)
      while (chatHistory.length > 20) {
        chatHistory.shift();
      }

      process.stdout.write('\r\x1b[K'); // clear "Pensando..."
      process.stdout.write('\n' + chalk.bold.blue('  💬 ') + chalk.white(text));
      process.stdout.write('\n' + chalk.blue('  🤖 ') + response.split('\n').join('\n     '));
      process.stdout.write('\n');
    } catch (err) {
      process.stdout.write('\n' + chalk.red(`  ❌ ${(err as Error).message}\n`));
    }

    chatBusy = false;
    redrawHeader();
  });

  // Ctrl+C handler
  process.on('SIGINT', () => {
    userRequestedStop = true;
    if (captureProcess && !stopping) {
      // Send 'q' to sidecar stdin (same as ffmpeg convention)
      try { captureProcess.stdin?.write('q\n'); } catch {}
      setTimeout(() => {
        if (captureProcess && !stopping) {
          captureProcess.kill('SIGINT');
        }
        setTimeout(() => process.exit(0), 2000);
      }, 2000);
    } else {
      if (pollInterval) clearInterval(pollInterval);
      if (timerInterval) clearInterval(timerInterval);
      process.exit(0);
    }
  });
}
