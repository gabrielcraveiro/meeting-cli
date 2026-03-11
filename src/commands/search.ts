import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { createSpinner } from 'nanospinner';
import { requireConfig } from '../config';
import { parseFrontmatter, extractSection } from '../services/storage';
import { chatWithMeetings } from '../services/organizer';

interface SearchResult {
  fileName: string;
  date: string;
  time: string;
  matchCount: number;
  snippets: string[];
}

function highlightMatch(line: string, terms: string[]): string {
  let result = line;
  for (const term of terms) {
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(regex, chalk.bgYellow.black('$1'));
  }
  return result;
}

// ── Semantic search: uses AI to find meetings by meaning ──
async function semanticSearch(query: string, limit: number): Promise<void> {
  const config = requireConfig();
  const meetingsDir = path.join(config.vaultPath, 'Meetings');

  if (!fs.existsSync(meetingsDir)) {
    console.log(chalk.yellow('⚠ Nenhuma reunião encontrada.'));
    return;
  }

  const files = fs.readdirSync(meetingsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();

  const s = createSpinner(`Analisando ${files.length} reuniões com IA...`).start();

  // Build compact index: date + title + first lines of summary
  const summaries: Array<{ fileName: string; date: string; time: string; preview: string }> = [];
  for (const fileName of files) {
    const filePath = path.join(meetingsDir, fileName);
    const content = fs.readFileSync(filePath, 'utf-8');
    const meta = parseFrontmatter(content);
    const summary = extractSection(content, 'AI Summary');
    const preview = summary
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('##'))
      .slice(0, 3)
      .join(' ')
      .replace(/\*\*/g, '')
      .slice(0, 200);
    summaries.push({
      fileName,
      date: meta['date'] || '',
      time: meta['time'] || '',
      preview,
    });
  }

  const index = summaries.map((m, i) =>
    `[${i}] ${m.date} ${m.time} — ${m.preview}`
  ).join('\n');

  try {
    const messages = [
      {
        role: 'system',
        content: 'Voce recebe uma busca semantica e uma lista de reunioes com resumos. '
          + 'Retorne os numeros (indices) das reunioes que sao semanticamente relevantes para a busca. '
          + 'Considere: temas relacionados, decisoes, projetos, participantes, problemas mencionados. '
          + 'Nao precisa ser match exato — busque por SIGNIFICADO e CONTEXTO. '
          + 'Formato: numeros separados por virgula, ordenados por relevancia (mais relevante primeiro). '
          + 'Maximo 10 resultados. Se nenhuma for relevante, retorne: nenhuma',
      },
      {
        role: 'user',
        content: `# Busca: ${query}\n\n# Reunioes\n${index}`,
      },
    ];

    const response = await chatWithMeetings(messages, config);
    const trimmed = response.trim().toLowerCase();

    if (trimmed === 'nenhuma' || trimmed === 'nenhum') {
      s.warn({ text: 'Nenhum resultado semântico encontrado.' });
      console.log(chalk.gray(`\n  Tente: meeting search "${query}" (busca por texto)\n`));
      return;
    }

    const indices = trimmed.split(/[,\s]+/)
      .map(str => parseInt(str.replace(/[^\d]/g, '')))
      .filter(n => !isNaN(n) && n >= 0 && n < summaries.length);

    if (indices.length === 0) {
      s.warn({ text: 'Nenhum resultado semântico encontrado.' });
      return;
    }

    const shown = indices.slice(0, limit);
    s.success({ text: `${shown.length} reunião(ões) relevante(s)` });
    console.log('');

    for (const idx of shown) {
      const m = summaries[idx];
      console.log(chalk.green(`📝 ${m.date} ${m.time}`));
      console.log(chalk.gray(`   ${m.fileName}`));
      // Show AI summary snippet
      const lines = m.preview.split('. ').slice(0, 2).join('. ');
      if (lines.trim()) {
        console.log(`   ${chalk.white(lines.trim())}`);
      }
      console.log('');
    }
  } catch (err) {
    s.error({ text: `Busca semântica falhou: ${(err as Error).message}` });
    console.log(chalk.gray('  Tente a busca por texto: meeting search "query" (sem --smart)'));
  }
}

// ── Full-text search ──
async function textSearch(query: string, limit: number): Promise<void> {
  const config = requireConfig();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const meetingsDir = path.join(config.vaultPath, 'Meetings');

  if (!fs.existsSync(meetingsDir)) {
    console.log(chalk.yellow('⚠ Nenhuma reunião encontrada.'));
    return;
  }

  const files = fs.readdirSync(meetingsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();

  console.log(chalk.bold(`\n🔍 Buscando "${query}" em ${files.length} reuniões...\n`));

  const results: SearchResult[] = [];

  for (const fileName of files) {
    const filePath = path.join(meetingsDir, fileName);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lower = content.toLowerCase();

    const allMatch = terms.every(t => lower.includes(t));
    if (!allMatch) continue;

    const meta = parseFrontmatter(content);
    const lines = content.split('\n');
    const snippets: string[] = [];
    let matchCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      if (terms.some(t => lineLower.includes(t))) {
        matchCount++;
        if (snippets.length < 3) {
          const ctx = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2))
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('---') && !l.startsWith('#'))
            .join(' ');
          if (ctx.trim()) {
            snippets.push(ctx.slice(0, 200));
          }
        }
      }
    }

    if (matchCount > 0) {
      results.push({
        fileName,
        date: meta['date'] || '',
        time: meta['time'] || '',
        matchCount,
        snippets,
      });
    }
  }

  if (results.length === 0) {
    console.log(chalk.yellow(`Nenhum resultado para "${query}".`));
    console.log(chalk.gray(`  Tente: meeting search --smart "${query}" (busca semântica com IA)\n`));
    return;
  }

  results.sort((a, b) => b.matchCount - a.matchCount);
  const shown = results.slice(0, limit);

  console.log(chalk.gray(`${results.length} reuniões encontradas (mostrando ${shown.length}):\n`));

  for (const r of shown) {
    console.log(chalk.green(`📝 ${r.date} ${r.time}`) + chalk.gray(` — ${r.matchCount} ocorrências`));
    console.log(chalk.gray(`   ${r.fileName}`));
    for (const snip of r.snippets) {
      console.log(`   ${highlightMatch(snip, terms)}`);
    }
    console.log('');
  }
}

export async function cmdSearch(query: string, opts: { limit?: string; smart?: boolean }): Promise<void> {
  if (!query.trim()) {
    console.error(chalk.red('❌ Informe um termo de busca: meeting search "deploy"'));
    process.exit(1);
  }

  const limit = parseInt(opts.limit || '10', 10);

  if (opts.smart) {
    await semanticSearch(query, limit);
  } else {
    await textSearch(query, limit);
  }
}
