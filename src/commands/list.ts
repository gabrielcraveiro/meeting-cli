import chalk from 'chalk';
import { requireConfig } from '../config';
import { listMeetings } from '../services/storage';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

export function cmdList(options: { limit?: string }): void {
  const config = requireConfig();
  const limit = parseInt(options.limit || '20');
  const meetings = listMeetings(config).slice(0, limit);

  if (meetings.length === 0) {
    console.log(chalk.yellow('Nenhuma reunião encontrada.'));
    return;
  }

  const cols = {
    date: 16,
    duration: 10,
    cost: 9,
    model: 14,
    status: 6,
    file: 40,
  };

  const sep = '─'.repeat(Object.values(cols).reduce((a, b) => a + b + 3, 1));

  console.log(chalk.bold('\n📋 Reuniões\n'));
  console.log(sep);
  console.log(
    chalk.bold(
      ` ${pad('Data', cols.date)} │ ${pad('Duração', cols.duration)} │ ${pad('Custo', cols.cost)} │ ${pad('Modelo', cols.model)} │ ${pad('IA', cols.status)} │ ${pad('Arquivo', cols.file)}`
    )
  );
  console.log(sep);

  for (const m of meetings) {
    const dateStr = `${m.date} ${m.time}`;
    const duration = formatDuration(m.audioSeconds);
    const cost = m.estimatedCostUsd > 0 ? `$${m.estimatedCostUsd.toFixed(4)}` : '-';
    const model = m.aiModel || '-';
    const hasAI = m.hasSummary ? chalk.green('✓') : chalk.gray('–');

    console.log(
      ` ${pad(dateStr, cols.date)} │ ${pad(duration, cols.duration)} │ ${pad(cost, cols.cost)} │ ${pad(model, cols.model)} │ ${pad(hasAI, cols.status + 9)} │ ${pad(m.fileName.replace('.md', ''), cols.file)}`
    );
  }

  console.log(sep);
  console.log(chalk.gray(`\n  ${meetings.length} reunião(ões) | Custo total: $${meetings.reduce((s, m) => s + m.estimatedCostUsd, 0).toFixed(4)}\n`));
}
