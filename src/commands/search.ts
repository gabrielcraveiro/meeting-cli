import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { requireConfig } from '../config';
import { parseFrontmatter } from '../services/storage';

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

export async function cmdSearch(query: string, opts: { limit?: string }): Promise<void> {
  const config = requireConfig();
  const limit = parseInt(opts.limit || '10', 10);

  if (!query.trim()) {
    console.error(chalk.red('❌ Informe um termo de busca: meeting search "deploy"'));
    process.exit(1);
  }

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

    // Check if all terms appear in the file
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
          // Show context: line before, match, line after
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
    return;
  }

  // Sort by match count (most relevant first)
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
