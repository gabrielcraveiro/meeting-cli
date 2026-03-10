import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { loadConfig } from '../config';
import { isSidecarInstalled } from './setup';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export async function cmdDoctor(): Promise<void> {
  console.log(chalk.bold('\nmeeting doctor — diagnostico\n'));
  const checks: Check[] = [];

  // 1. Config exists
  const config = loadConfig();
  if (!config) {
    checks.push({ name: 'Config', status: 'fail', message: 'Nao encontrado. Rode: meeting config' });
    printResults(checks);
    return;
  }
  checks.push({ name: 'Config', status: 'ok', message: '~/.config/meeting-cli/config.json' });

  // 2. Vault path
  if (fs.existsSync(config.vaultPath)) {
    const meetingsDir = path.join(config.vaultPath, 'Meetings');
    const count = fs.existsSync(meetingsDir)
      ? fs.readdirSync(meetingsDir).filter(f => f.endsWith('.md')).length
      : 0;
    checks.push({ name: 'Vault', status: 'ok', message: `${config.vaultPath} (${count} notas)` });
  } else {
    checks.push({ name: 'Vault', status: 'fail', message: `Caminho nao existe: ${config.vaultPath}` });
  }

  // 3. node.exe (Windows)
  try {
    const ver = execFileSync('node.exe', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
    checks.push({ name: 'node.exe', status: 'ok', message: ver });
  } catch {
    checks.push({ name: 'node.exe', status: 'fail', message: 'Nao encontrado no PATH. Instale Node.js no Windows.' });
  }

  // 4. Sidecar
  if (isSidecarInstalled()) {
    checks.push({ name: 'Sidecar', status: 'ok', message: 'native-audio-node instalado' });
  } else {
    checks.push({ name: 'Sidecar', status: 'fail', message: 'Nao instalado. Rode: meeting setup' });
  }

  // 5. Deepgram API key
  if (config.deepgramApiKey) {
    try {
      const resp = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${config.deepgramApiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        checks.push({ name: 'Deepgram', status: 'ok', message: `Key valida (${config.deepgramModel || 'nova-2'})` });
      } else {
        checks.push({ name: 'Deepgram', status: 'fail', message: `Key invalida (HTTP ${resp.status})` });
      }
    } catch (err) {
      checks.push({ name: 'Deepgram', status: 'warn', message: `Sem conexao: ${(err as Error).message}` });
    }
  } else {
    checks.push({ name: 'Deepgram', status: 'fail', message: 'API key nao configurada' });
  }

  // 6. LiteLLM / Chat endpoint
  if (config.chatEndpoint && config.chatApiKey) {
    try {
      const resp = await fetch(`${config.chatEndpoint}/v1/models`, {
        headers: { Authorization: `Bearer ${config.chatApiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        checks.push({ name: 'LiteLLM', status: 'ok', message: `${config.chatModel} @ ${config.chatEndpoint.slice(0, 40)}` });
      } else {
        checks.push({ name: 'LiteLLM', status: 'warn', message: `HTTP ${resp.status} — endpoint pode estar inativo` });
      }
    } catch (err) {
      checks.push({ name: 'LiteLLM', status: 'warn', message: `Sem conexao: ${(err as Error).message}` });
    }
  } else {
    checks.push({ name: 'LiteLLM', status: 'fail', message: 'Endpoint ou API key nao configurados' });
  }

  // 7. Disk space for recordings
  try {
    const recordingsDir = path.join(config.vaultPath, 'Recordings');
    if (fs.existsSync(recordingsDir)) {
      const files = fs.readdirSync(recordingsDir).filter(f => f.endsWith('.wav') || f.endsWith('.mp3'));
      let totalSize = 0;
      for (const f of files) {
        try { totalSize += fs.statSync(path.join(recordingsDir, f)).size; } catch {}
      }
      const sizeMb = (totalSize / 1024 / 1024).toFixed(0);
      checks.push({ name: 'Recordings', status: 'ok', message: `${files.length} arquivos (${sizeMb}MB)` });
    } else {
      checks.push({ name: 'Recordings', status: 'ok', message: 'Nenhuma gravacao ainda' });
    }
  } catch {}

  printResults(checks);
}

function printResults(checks: Check[]) {
  const icons = { ok: chalk.green('OK'), warn: chalk.yellow('!!'), fail: chalk.red('XX') };
  for (const c of checks) {
    console.log(`  ${icons[c.status]}  ${c.name.padEnd(12)} ${chalk.gray(c.message)}`);
  }
  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  if (fails === 0 && warns === 0) {
    console.log(chalk.green('\nTudo certo! Pronto para gravar.\n'));
  } else if (fails === 0) {
    console.log(chalk.yellow(`\n${warns} aviso(s) — pode funcionar, mas verifique.\n`));
  } else {
    console.log(chalk.red(`\n${fails} problema(s) encontrado(s). Corrija antes de gravar.\n`));
  }
}
