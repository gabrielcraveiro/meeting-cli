import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { requireConfig } from '../config';
import { getSidecarCapturePath } from './setup';

// `meeting audio-test` — 10-second capture that reports per-channel signal
// peaks (system vs mic) straight from the sidecar. Purpose: isolate dead-mic
// issues in 30 seconds instead of discovering them after a whole meeting.
// Run it once normally and once while in a Teams call to compare.

function toWinPath(p: string): string {
  return p.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
}

const TEST_SECONDS = 5;
const SEGMENTS_TO_CAPTURE = 2;

export async function cmdAudioTest(): Promise<void> {
  const config = requireConfig();

  let sidecarPath = getSidecarCapturePath();
  if (!fs.existsSync(sidecarPath)) {
    const alt = path.resolve(__dirname, '..', 'sidecar', 'capture.js');
    if (fs.existsSync(alt)) sidecarPath = alt;
    else {
      console.error(chalk.red('Sidecar não encontrado. Rode: meeting setup'));
      process.exit(1);
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-audiotest-'));
  const args = [
    toWinPath(sidecarPath),
    '--output', toWinPath(tmpDir),
    '--segment-duration', String(TEST_SECONDS),
    '--sample-rate', '16000',
    '--mic-gain', String(config.micGain ?? 1.0),
  ];
  if (config.micDeviceId) args.push('--mic-device', config.micDeviceId);

  console.log(chalk.bold('\n  meeting audio-test') + chalk.gray(` — ${SEGMENTS_TO_CAPTURE}× ${TEST_SECONDS}s de captura\n`));
  console.log(chalk.gray(`  Mic device: ${config.micDeviceId || '(padrão do sistema)'}  |  gain: ${config.micGain ?? 1.0}`));
  console.log(chalk.cyan(`\n  FALE ALGO durante o teste (e deixe algum som tocando, se possível)...\n`));

  const proc = spawn('node.exe', args);
  let segments = 0;
  let peakMicMax = 0;
  let peakSysMax = 0;

  // Post-gain peak tiers: >0.15 healthy speech, 0.01–0.15 weak (silence
  // detection may still discard it), <0.01 effectively dead.
  const STRONG = 0.15;
  const WEAK = 0.01;

  const finish = (code?: number) => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log('');
    const verdict = (label: string, peak: number, deadHint: string) => {
      if (peak >= STRONG) {
        console.log(`  ${chalk.green('OK')}  ${label.padEnd(18)} ${chalk.gray(`sinal forte (peak ${peak.toFixed(3)})`)}`);
      } else if (peak >= WEAK) {
        console.log(`  ${chalk.yellow('!!')}  ${label.padEnd(18)} ${chalk.yellow(`sinal FRACO (peak ${peak.toFixed(3)}) — pode ser descartado como silêncio`)}`);
      } else {
        console.log(`  ${chalk.red('XX')}  ${label.padEnd(18)} ${chalk.red(deadHint)}`);
      }
    };
    verdict('Sistema (remoto)', peakSysMax, 'sem sinal — tinha áudio tocando no Windows?');
    verdict('Microfone (você)', peakMicMax, 'SEM SINAL — mic errado, mute físico ou permissão do Windows');
    if (peakMicMax < STRONG) {
      console.log(chalk.yellow('\n  Dicas: suba o nível do mic no Windows (Configurações → Som → Entrada → Volume);'));
      console.log(chalk.yellow('  aumente micGain no ~/.config/meeting-cli/config.json;'));
      console.log(chalk.yellow('  headset Bluetooth pode trocar de dispositivo ao entrar em call.'));
    }
    console.log('');
    process.exit(code ?? 0);
  };

  let buf = '';
  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt: any;
      try { evt = JSON.parse(line); } catch { continue; }

      if (evt.event === 'metadata') {
        const { event: _e, source, ...rest } = evt;
        console.log(chalk.gray(`  [${source}] ${Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(' ')}`));
      } else if (evt.event === 'started') {
        console.log(chalk.green('  Captura iniciada'));
      } else if (evt.event === 'error') {
        console.log(chalk.red(`  ERRO [${evt.source}]: ${evt.message}`));
      } else if (evt.event === 'segment') {
        segments++;
        const pMic = parseFloat(evt.peakMic);
        const pSys = parseFloat(evt.peakSys);
        peakMicMax = Math.max(peakMicMax, pMic || 0);
        peakSysMax = Math.max(peakSysMax, pSys || 0);
        const fmt = (v: number) => (v >= STRONG ? chalk.green : v >= WEAK ? chalk.yellow : chalk.red)(v.toFixed(4));
        console.log(`  seg ${segments}/${SEGMENTS_TO_CAPTURE}: rms=${evt.rmsDb}dB  peakSys=${fmt(pSys)}  peakMic=${fmt(pMic)}`);
        if (segments >= SEGMENTS_TO_CAPTURE) {
          try { proc.stdin?.write('q\n'); } catch {}
          setTimeout(() => { try { proc.kill('SIGINT'); } catch {} ; finish(); }, 1500);
        }
      }
    }
  });

  proc.stderr.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.log(chalk.gray(`  [sidecar] ${msg}`));
  });

  proc.on('error', (err) => {
    console.error(chalk.red(`  Sidecar falhou: ${err.message} (node.exe no PATH?)`));
    process.exit(1);
  });

  proc.stdin?.on('error', () => {});

  // Safety timeout
  setTimeout(() => {
    console.log(chalk.yellow('  Timeout — encerrando teste'));
    try { proc.kill('SIGINT'); } catch {}
    finish(1);
  }, (TEST_SECONDS * SEGMENTS_TO_CAPTURE + 15) * 1000);
}
