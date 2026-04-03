import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { requireConfig } from '../config';
import { transcribeFull } from '../services/transcriber';
import { organizeTranscript } from '../services/organizer';
import { createMeetingNote } from '../services/storage';
import { getTemplate } from '../services/templates';

export async function cmdTranscribe(filePath: string, opts: { template?: string; noAi?: boolean }): Promise<void> {
  const config = requireConfig();

  // Resolve path
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(chalk.red(`❌ Arquivo não encontrado: ${absPath}`));
    process.exit(1);
  }

  const stat = fs.statSync(absPath);
  console.log(chalk.bold('\n🎤 Meeting CLI — Transcrição de arquivo\n'));
  console.log(chalk.gray(`Arquivo: ${absPath}`));
  console.log(chalk.gray(`Tamanho: ${(stat.size / 1024 / 1024).toFixed(1)}MB`));

  // Transcribe
  console.log(chalk.blue('\n⏳ Transcrevendo com Deepgram...'));
  const transcribeResult = await transcribeFull(absPath, config);
  const transcript = transcribeResult.text;

  if (!transcript.trim()) {
    console.log(chalk.yellow('⚠ Transcrição vazia — nenhuma fala detectada.'));
    return;
  }

  console.log(chalk.green(`✓ Transcrição: ${transcript.split('\n').length} linhas`));
  if (transcribeResult.billableSec > 0) {
    const billableMin = (transcribeResult.billableSec / 60).toFixed(1);
    console.log(chalk.gray(`   Fala detectada: ${billableMin}min cobráveis`));
  }
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.cyan(transcript));
  console.log(chalk.gray('─'.repeat(60)));

  if (opts.noAi) {
    console.log(chalk.gray('\n--no-ai: pulando organização com IA.'));
    return;
  }

  // Organize with AI
  console.log(chalk.blue('\n🤖 Organizando com IA...'));

  // Use template prompt if specified
  const template = opts.template ? getTemplate(opts.template) : null;
  const configWithPrompt = template
    ? { ...config, organizationPrompt: template.prompt }
    : config;

  if (template) {
    console.log(chalk.gray(`   Template: ${template.label}`));
  }

  const result = await organizeTranscript(transcript, configWithPrompt);

  // Estimate duration from file size (rough: 16kHz mono 16-bit = 32KB/s)
  const ext = path.extname(absPath).toLowerCase();
  let durationSec = 0;
  if (ext === '.wav') {
    durationSec = (stat.size - 44) / (16000 * 2); // 16kHz 16-bit mono
  } else {
    // For MP3/other formats, estimate ~16KB/s at 128kbps
    durationSec = stat.size / 16000;
  }

  const now = new Date();
  const date = now.toLocaleDateString('sv').slice(0, 10);
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const deepgramCost = (durationSec / 60) * 0.006;

  // Copy audio to Recordings
  const audioName = path.basename(absPath);
  const recordingsDir = path.join(config.vaultPath, 'Recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });
  const destAudio = path.join(recordingsDir, audioName);
  if (!fs.existsSync(destAudio)) {
    fs.copyFileSync(absPath, destAudio);
  }

  const notePath = await createMeetingNote(config, {
    transcript,
    summary: result.text,
    audioPath: `Recordings/${audioName}`,
    durationSec,
    whisperCost: deepgramCost,
    chatCost: result.costUsd,
    chatDeployment: config.chatModel,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    totalTokens: result.totalTokens,
    date,
    time,
  });

  const totalCost = (deepgramCost + result.costUsd).toFixed(4);
  console.log(chalk.green(`\n✅ Nota criada: ${path.basename(notePath)}`));
  console.log(chalk.gray(`   Custo: $${totalCost}`));
}
