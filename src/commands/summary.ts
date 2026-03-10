import * as fs from 'fs';
import chalk from 'chalk';
import { requireConfig } from '../config';
import { listMeetings, extractSection } from '../services/storage';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function cmdSummary(options: { limit?: string; raw?: boolean }): void {
  const config = requireConfig();
  const limit = parseInt(options.limit || '5');
  const meetings = listMeetings(config).slice(0, limit);

  if (meetings.length === 0) {
    console.log(chalk.yellow('Nenhuma reunião encontrada.'));
    return;
  }

  console.log(chalk.bold(`\n📋 Resumo das últimas ${meetings.length} reunião(ões)\n`));

  for (const m of meetings) {
    const divider = '═'.repeat(60);
    const dateStr = `${m.date} ${m.time}`;
    const duration = formatDuration(m.audioSeconds);
    const cost = m.estimatedCostUsd > 0 ? ` | $${m.estimatedCostUsd.toFixed(4)}` : '';

    console.log(chalk.bold.blue(`\n${divider}`));
    console.log(chalk.bold(`📅 ${dateStr}  (${duration}${cost})`));
    console.log(chalk.gray(m.fileName));
    console.log(chalk.bold.blue(divider));

    const content = fs.readFileSync(m.filePath, 'utf-8');
    const summary = extractSection(content, 'AI Summary');
    const transcript = extractSection(content, 'Transcription');

    if (summary && !summary.includes('Generating summary')) {
      if (options.raw) {
        console.log('\n' + summary + '\n');
      } else {
        // Highlight action items and decisions
        const formatted = summary
          .split('\n')
          .map(line => {
            if (line.match(/^#{1,3} /)) return chalk.bold.yellow(line);
            if (line.match(/^\*\*.*\*\*/)) return chalk.bold(line);
            if (line.match(/^- \*\*(Action|Ação|Decisão)/i)) return chalk.green(line);
            if (line.match(/^\[Speaker/i)) return chalk.cyan(line);
            return line;
          })
          .join('\n');
        console.log('\n' + formatted + '\n');
      }
    } else if (transcript) {
      console.log(chalk.yellow('\n⚠ Sem resumo de IA. Transcrição:\n'));
      console.log(transcript.slice(0, 500) + (transcript.length > 500 ? '...' : '') + '\n');
    } else {
      console.log(chalk.gray('\n(sem conteúdo)\n'));
    }
  }
}
