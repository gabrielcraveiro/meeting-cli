import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { requireConfig } from '../config';
import { listMeetings, parseFrontmatter } from '../services/storage';

export async function cmdStats(): Promise<void> {
  const config = requireConfig();
  const meetings = listMeetings(config);

  if (meetings.length === 0) {
    console.log(chalk.yellow('Nenhuma reuniao encontrada.'));
    return;
  }

  // Aggregate stats
  let totalSeconds = 0;
  let totalCost = 0;
  let totalTokens = 0;
  let withSummary = 0;
  const byMonth: Record<string, { count: number; seconds: number; cost: number }> = {};
  const byModel: Record<string, number> = {};

  for (const m of meetings) {
    totalSeconds += m.audioSeconds;
    totalCost += m.estimatedCostUsd;
    if (m.hasSummary) withSummary++;
    if (m.aiModel) byModel[m.aiModel] = (byModel[m.aiModel] || 0) + 1;

    // Read full frontmatter for token count
    try {
      const content = fs.readFileSync(m.filePath, 'utf-8');
      const meta = parseFrontmatter(content);
      totalTokens += parseInt(meta['ai_total_tokens'] || '0');
    } catch {}

    const month = m.date ? m.date.slice(0, 7) : 'sem-data';
    if (!byMonth[month]) byMonth[month] = { count: 0, seconds: 0, cost: 0 };
    byMonth[month].count++;
    byMonth[month].seconds += m.audioSeconds;
    byMonth[month].cost += m.estimatedCostUsd;
  }

  const totalHours = (totalSeconds / 3600).toFixed(1);
  const avgMinutes = Math.round(totalSeconds / meetings.length / 60);
  const avgCost = (totalCost / meetings.length).toFixed(4);

  // Print to terminal
  console.log(chalk.bold('\nmeeting stats\n'));
  console.log(`  Reunioes:      ${meetings.length}`);
  console.log(`  Com sumario:   ${withSummary}/${meetings.length}`);
  console.log(`  Horas totais:  ${totalHours}h`);
  console.log(`  Media:         ${avgMinutes} min/reuniao`);
  console.log(`  Custo total:   $${totalCost.toFixed(4)}`);
  console.log(`  Custo medio:   $${avgCost}/reuniao`);
  console.log(`  Tokens IA:     ${totalTokens.toLocaleString()}`);
  if (Object.keys(byModel).length > 0) {
    console.log(`  Modelos:       ${Object.entries(byModel).map(([m, c]) => `${m} (${c})`).join(', ')}`);
  }

  // Monthly breakdown
  const months = Object.keys(byMonth).sort().reverse();
  if (months.length > 0) {
    console.log(chalk.bold('\n  Por mes:\n'));
    for (const month of months) {
      const s = byMonth[month];
      const h = (s.seconds / 3600).toFixed(1);
      console.log(`  ${month}  ${String(s.count).padStart(3)} reunioes  ${h.padStart(5)}h  $${s.cost.toFixed(4)}`);
    }
  }

  // Generate markdown dashboard in vault
  const dashPath = path.join(config.vaultPath, 'meeting-stats.md');
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  let md = `---\ntype: dashboard\ntags: [meeting-cli, stats]\nupdated: "${now}"\n---\n`;
  md += `# Meeting CLI — Dashboard\n\n`;
  md += `> Atualizado: ${now}\n\n`;
  md += `## Resumo\n\n`;
  md += `| Metrica | Valor |\n|---------|-------|\n`;
  md += `| Reunioes | ${meetings.length} |\n`;
  md += `| Com sumario | ${withSummary}/${meetings.length} |\n`;
  md += `| Horas totais | ${totalHours}h |\n`;
  md += `| Media por reuniao | ${avgMinutes} min |\n`;
  md += `| Custo total | $${totalCost.toFixed(4)} |\n`;
  md += `| Custo medio | $${avgCost} |\n`;
  md += `| Tokens IA | ${totalTokens.toLocaleString()} |\n\n`;

  if (months.length > 0) {
    md += `## Por Mes\n\n`;
    md += `| Mes | Reunioes | Horas | Custo |\n|-----|----------|-------|-------|\n`;
    for (const month of months) {
      const s = byMonth[month];
      const h = (s.seconds / 3600).toFixed(1);
      md += `| ${month} | ${s.count} | ${h}h | $${s.cost.toFixed(4)} |\n`;
    }
    md += '\n';
  }

  // Recent meetings table
  const recent = meetings.slice(0, 15);
  md += `## Ultimas Reunioes\n\n`;
  md += `| Data | Hora | Duracao | Custo | Modelo | Sumario |\n`;
  md += `|------|------|---------|-------|--------|----------|\n`;
  for (const m of recent) {
    const dur = `${Math.round(m.audioSeconds / 60)} min`;
    const sum = m.hasSummary ? 'Sim' : 'Nao';
    md += `| ${m.date} | ${m.time} | ${dur} | $${m.estimatedCostUsd.toFixed(4)} | ${m.aiModel} | ${sum} |\n`;
  }
  md += '\n';

  fs.writeFileSync(dashPath, md, 'utf-8');
  console.log(chalk.green(`\n  Dashboard salvo: ${path.basename(dashPath)}`));
  console.log(chalk.gray(`  ${dashPath}\n`));
}
