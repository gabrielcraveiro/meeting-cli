import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
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
  console.log(chalk.gray(`  ${dashPath}`));

  // Generate HTML version and open in browser
  const htmlPath = dashPath.replace(/\.md$/, '.html');
  const html = generateHtmlDashboard(meetings.length, withSummary, totalHours, avgMinutes, totalCost, avgCost, totalTokens, byModel, byMonth, months, recent);
  fs.writeFileSync(htmlPath, html, 'utf-8');

  // Open in browser (WSL2: convert to Windows path and use cmd.exe)
  const winPath = htmlPath.replace(/^\/mnt\/([a-z])\//, (_, d: string) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
  execFile('cmd.exe', ['/c', 'start', '', winPath], { windowsHide: true }, () => {});
  console.log(chalk.gray(`  Abrindo no browser...\n`));
}

function generateHtmlDashboard(
  total: number, withSummary: number, totalHours: string, avgMinutes: number,
  totalCost: number, avgCost: string, totalTokens: number,
  byModel: Record<string, number>,
  byMonth: Record<string, { count: number; seconds: number; cost: number }>,
  months: string[],
  recent: Array<{ date: string; time: string; audioSeconds: number; estimatedCostUsd: number; aiModel: string; hasSummary: boolean }>
): string {
  const modelStr = Object.entries(byModel).map(([m, c]) => `${m} (${c})`).join(', ');

  const monthRows = months.map(m => {
    const s = byMonth[m];
    const h = (s.seconds / 3600).toFixed(1);
    return `<tr><td>${m}</td><td>${s.count}</td><td>${h}h</td><td>$${s.cost.toFixed(4)}</td></tr>`;
  }).join('\n');

  const recentRows = recent.map(m => {
    const dur = `${Math.round(m.audioSeconds / 60)} min`;
    return `<tr>
      <td>${m.date}</td><td>${m.time}</td><td>${dur}</td>
      <td>$${m.estimatedCostUsd.toFixed(4)}</td><td>${m.aiModel}</td>
      <td>${m.hasSummary ? '<span class="badge ok">✓</span>' : '<span class="badge no">✗</span>'}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Meeting CLI — Dashboard</title>
<style>
  :root {
    --bg: #282c34; --bg2: #21252b; --bg3: #2c313a;
    --fg: #abb2bf; --fg2: #5c6370;
    --red: #e06c75; --green: #98c379; --yellow: #e5c07b;
    --blue: #61afef; --magenta: #c678dd; --cyan: #56b6c2;
    --orange: #d19a66; --border: #3e4451;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    background: var(--bg); color: var(--fg);
    padding: 2rem; max-width: 1100px; margin: 0 auto;
    line-height: 1.6;
  }
  h1 { color: var(--blue); font-size: 1.5rem; margin-bottom: 0.5rem; }
  h2 { color: var(--magenta); font-size: 1.1rem; margin: 2rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
  .subtitle { color: var(--fg2); font-size: 0.85rem; margin-bottom: 2rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .card {
    background: var(--bg3); border: 1px solid var(--border); border-radius: 8px;
    padding: 1.2rem; text-align: center;
  }
  .card .value { font-size: 1.8rem; font-weight: bold; color: var(--cyan); }
  .card .label { font-size: 0.8rem; color: var(--fg2); margin-top: 0.3rem; }
  .card.cost .value { color: var(--green); }
  .card.warn .value { color: var(--yellow); }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th { text-align: left; color: var(--blue); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.6rem 0.8rem; border-bottom: 2px solid var(--border); }
  td { padding: 0.5rem 0.8rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
  tr:hover td { background: var(--bg2); }
  .badge { padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; }
  .badge.ok { background: rgba(152,195,121,0.15); color: var(--green); }
  .badge.no { background: rgba(224,108,117,0.15); color: var(--red); }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin: 1.5rem 0; }
  .chart-box { background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 1.2rem; }
  .chart-title { font-size: 0.85rem; color: var(--fg2); margin-bottom: 0.8rem; }
  .bar-chart { display: flex; flex-direction: column; gap: 0.5rem; }
  .bar-row { display: flex; align-items: center; gap: 0.8rem; }
  .bar-label { width: 70px; font-size: 0.8rem; color: var(--fg2); text-align: right; }
  .bar-track { flex: 1; height: 22px; background: var(--bg2); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; display: flex; align-items: center; padding: 0 0.5rem; font-size: 0.75rem; color: var(--bg); font-weight: bold; min-width: fit-content; }
  .bar-fill.count { background: var(--blue); }
  .bar-fill.hours { background: var(--cyan); }
  .bar-fill.cost { background: var(--green); }
  .models { color: var(--fg2); font-size: 0.85rem; margin-top: 0.5rem; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--fg2); font-size: 0.75rem; text-align: center; }
</style>
</head>
<body>
  <h1>Meeting CLI — Dashboard</h1>
  <div class="subtitle">Atualizado: ${new Date().toLocaleString('pt-BR')}</div>

  <div class="cards">
    <div class="card"><div class="value">${total}</div><div class="label">Reuniões</div></div>
    <div class="card"><div class="value">${totalHours}h</div><div class="label">Horas gravadas</div></div>
    <div class="card"><div class="value">${avgMinutes} min</div><div class="label">Média / reunião</div></div>
    <div class="card cost"><div class="value">$${totalCost.toFixed(2)}</div><div class="label">Custo total</div></div>
    <div class="card cost"><div class="value">$${avgCost}</div><div class="label">Custo / reunião</div></div>
    <div class="card warn"><div class="value">${(totalTokens / 1000).toFixed(0)}k</div><div class="label">Tokens IA</div></div>
  </div>

  <p class="models">Modelos: ${modelStr || 'N/A'} · Sumários: ${withSummary}/${total}</p>

  <h2>Por Mês</h2>
  <div class="charts">
    <div class="chart-box">
      <div class="chart-title">Reuniões / mês</div>
      <div class="bar-chart">
        ${months.slice().reverse().map(m => {
          const s = byMonth[m];
          const maxCount = Math.max(...months.map(mm => byMonth[mm].count));
          const pct = maxCount > 0 ? (s.count / maxCount * 100) : 0;
          return `<div class="bar-row"><div class="bar-label">${m}</div><div class="bar-track"><div class="bar-fill count" style="width:${Math.max(pct, 8)}%">${s.count}</div></div></div>`;
        }).join('\n')}
      </div>
    </div>
    <div class="chart-box">
      <div class="chart-title">Horas / mês</div>
      <div class="bar-chart">
        ${months.slice().reverse().map(m => {
          const s = byMonth[m];
          const h = s.seconds / 3600;
          const maxH = Math.max(...months.map(mm => byMonth[mm].seconds / 3600));
          const pct = maxH > 0 ? (h / maxH * 100) : 0;
          return `<div class="bar-row"><div class="bar-label">${m}</div><div class="bar-track"><div class="bar-fill hours" style="width:${Math.max(pct, 8)}%">${h.toFixed(1)}h</div></div></div>`;
        }).join('\n')}
      </div>
    </div>
  </div>

  <table>
    <thead><tr><th>Mês</th><th>Reuniões</th><th>Horas</th><th>Custo</th></tr></thead>
    <tbody>${monthRows}</tbody>
  </table>

  <h2>Últimas Reuniões</h2>
  <table>
    <thead><tr><th>Data</th><th>Hora</th><th>Duração</th><th>Custo</th><th>Modelo</th><th>Sumário</th></tr></thead>
    <tbody>${recentRows}</tbody>
  </table>

  <footer>Generated by Meeting CLI · ${new Date().toISOString().slice(0, 10)}</footer>
</body>
</html>`;
}
