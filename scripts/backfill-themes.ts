// Preenche `temas:` (e `series:`, quando dá) nas notas antigas do vault.
//
// Uso:
//   npx -y tsx scripts/backfill-themes.ts            # classifica e mostra o plano
//   npx -y tsx scripts/backfill-themes.ts --apply    # grava no frontmatter
//   npx -y tsx scripts/backfill-themes.ts --hubs     # depois: (re)constrói Temas/<Tema>.md
//
// Temas: o claude (Sonnet, mesmo spawn do organizador) classifica em lotes,
// lendo só a parte organizada de cada nota, sem transcrição, contra o
// vocabulário de meeting-temas.md. Series: título da nota provisória no
// organize.log (= título do calendário), sem custo de modelo.
// A classificação fica em cache (~/.local/state/meeting-cli/backfill-themes.json):
// rodar --apply depois do dry-run não paga de novo.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../src/config';
import { claudeSpawnEnv, resolveClaudeBin } from '../src/services/claudeBin';
import { seriesKey } from '../src/services/series';
import { loadThemes, noteThemes, resolveThemes } from '../src/services/themes';
import { buildTopicNote } from '../src/services/topicNotes';

const APPLY = process.argv.includes('--apply');
const HUBS = process.argv.includes('--hubs');
/** Notas por chamada: lote grande barateia, mas acima disso a atenção por nota cai. */
const BATCH = 12;
/** Chamadas simultâneas ao claude. */
const PARALLEL = 3;
/** Parte organizada por nota no prompt — resumo e pontos cabem folgado. */
const PER_NOTE_CHARS = 1200;
const TIMEOUT_MS = 5 * 60_000;

const config = loadConfig();
if (!config) throw new Error('config não encontrada');
const meetingsDir = path.join(config.vaultPath, 'Meetings');
const stateDir = path.join(os.homedir(), '.local', 'state', 'meeting-cli');
const CACHE_FILE = path.join(stateDir, 'backfill-themes.json');
const ORGANIZE_LOG = path.join(os.homedir(), '.config', 'meeting-cli', 'organize-jobs', 'organize.log');
const themes = loadThemes(config);

type Cache = Record<string, string[]>;
const cache: Cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) : {};
const saveCache = () => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1)); };

/** nota final → título provisório (calendário), como em repair-note-titles.ts. */
function provisionalTitles(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(ORGANIZE_LOG)) return out;
  let pending: string | null = null;
  for (const line of fs.readFileSync(ORGANIZE_LOG, 'utf-8').split('\n')) {
    const start = line.match(/nota provisória: (.+\.md)\s*$/);
    if (start) { pending = start[1]; continue; }
    const done = line.match(/concluído \([^)]*\): (.+\.md)\s*$/);
    if (done && pending) {
      out.set(done[1], pending.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}(-\d{2})? - /, ''));
      pending = null;
    }
  }
  return out;
}

/** Título provisório que não identifica série: genérico ou nome de pessoa (1:1 vive em Pessoas/). */
function usableSeries(title: string): boolean {
  if (!title || /^meeting\b|^reuni[aã]o\b|organizacao automatica/i.test(title)) return false;
  return !/^\p{Lu}[\p{L}'-]+(\s+(d[aeo]s?\s+)?\p{Lu}[\p{L}'-]+)+$/u.test(title);
}

function runClaude(prompt: string): Promise<{ text: string; cost: number }> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--model', config!.claudeModel || 'claude-sonnet-5-5',
      '--max-turns', '1', '--setting-sources', 'project'];
    const proc = spawn(resolveClaudeBin(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: claudeSpawnEnv() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('timeout')); }, TIMEOUT_MS);
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(out) as { result?: string; is_error?: boolean; total_cost_usd?: number };
        if (data.is_error || !data.result) return reject(new Error(`claude: ${(data.result || err).slice(0, 200)}`));
        resolve({ text: data.result, cost: data.total_cost_usd ?? 0 });
      } catch {
        reject(new Error(`claude saiu ${code}: ${err.slice(0, 200)}`));
      }
    });
    proc.stdin.end(prompt);
  });
}

type Item = { file: string; title: string; excerpt: string };

async function classify(batch: Item[]): Promise<number> {
  const prompt =
    'Classifique cada reunião abaixo com ATÉ 2 temas desta lista FECHADA (use o nome exato; a descrição só orienta):\n'
    + themes.map(t => `- ${t.name}: ${t.hint}`).join('\n')
    + '\n\nRegras: escolha pelo ASSUNTO CENTRAL, não por menção de passagem (daily que cita Pix uma vez não é Pix). '
    + 'Na dúvida, lista vazia. Conversa pessoal, desligamento, avaliação ou headcount: lista vazia. '
    + 'Não use ferramentas. Responda SOMENTE um array JSON, sem texto em volta: '
    + '[{"id": 1, "temas": ["Nome"]}, ...] com um objeto por reunião.\n\n'
    + batch.map((it, i) => `### id ${i + 1} — ${it.title}\n${it.excerpt}`).join('\n\n');
  const { text, cost } = await runClaude(prompt);
  const json = text.match(/\[[\s\S]*\]/)?.[0];
  if (!json) throw new Error(`resposta sem JSON: ${text.slice(0, 120)}`);
  for (const r of JSON.parse(json) as Array<{ id: number; temas: string[] }>) {
    const it = batch[r.id - 1];
    if (it) cache[it.file] = resolveThemes(r.temas ?? [], themes);
  }
  saveCache();
  return cost;
}

async function main() {
  const fromLog = provisionalTitles();
  const todo: Item[] = [];
  const all: Array<{ file: string; fm: string }> = [];
  for (const file of fs.readdirSync(meetingsDir).filter(f => f.endsWith('.md') && !f.includes('(prep)'))) {
    const raw = fs.readFileSync(path.join(meetingsDir, file), 'utf-8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    if (!fm || noteThemes(fm) !== null) continue;  // já classificada
    const organized = raw.slice(raw.indexOf('\n---\n') + 5).split(/\n---\n+## Transcri/)[0].trim();
    if (!organized || /organizacao automatica falhou|organizando com ia/i.test(organized.slice(0, 300))) continue;
    all.push({ file, fm });
    if (!(file in cache)) {
      const title = (fm.match(/^title:\s*"?(.*?)"?\s*$/m)?.[1] ?? file).trim();
      todo.push({ file, title, excerpt: organized.slice(0, PER_NOTE_CHARS) });
    }
  }

  console.log(`${all.length} notas sem tema; ${todo.length} ainda não classificadas (resto em cache).`);
  let cost = 0;
  const batches: Item[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < batches.length) {
      const b = batches[next++];
      try {
        cost += await classify(b);
      } catch (e) {
        console.log(`  lote falhou (${(e as Error).message}) — rode de novo para retomar`);
      }
      done++;
      process.stdout.write(`\r  lotes ${done}/${batches.length} · US$ ${cost.toFixed(2)}`);
    }
  }));
  if (batches.length) console.log();

  const count = new Map<string, number>();
  let none = 0;
  let withSeries = 0;
  for (const { file } of all) {
    const t = cache[file];
    if (!t) continue;
    if (t.length === 0) none++;
    for (const n of t) count.set(n, (count.get(n) ?? 0) + 1);
    if (usableSeries(fromLog.get(file) ?? '')) withSeries++;
  }
  console.log('\nNotas por tema:');
  for (const [n, c] of [...count.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(3)}  ${n}`);
  console.log(`  ${String(none).padStart(3)}  (sem tema)`);
  console.log(`\nseries: recuperável para ${withSeries} notas pelo organize.log.`);

  if (APPLY) {
    let written = 0;
    for (const { file, fm } of all) {
      const t = cache[file];
      if (!t) continue;
      const abs = path.join(meetingsDir, file);
      const raw = fs.readFileSync(abs, 'utf-8');
      const series = fromLog.get(file) ?? '';
      let front = fm.replace(/^(title:.*)$/m, `$1\ntemas: [${t.join(', ')}]`);
      if (!/^temas:/m.test(front)) front += `\ntemas: [${t.join(', ')}]`;  // nota sem title:
      if (!/^series:/m.test(front) && usableSeries(series)) {
        front = front.replace(/^(title:.*)$/m, `$1\nseries: "${seriesKey(series).replace(/"/g, "'")}"`);
      }
      fs.writeFileSync(abs, raw.replace(fm, front));
      written++;
    }
    console.log(`Gravado em ${written} notas.`);
  } else {
    console.log('Dry-run. Rode com --apply para gravar.');
  }

  if (HUBS) {
    for (const t of themes) {
      // buildTopicNote incorpora no máximo 14 notas por chamada: repete até não sobrar nova.
      for (let round = 0; round < 10; round++) {
        const r = await buildTopicNote(config!, t.name);
        if (r.skipped) break;
        console.log(`  ${r.file}: +${r.added}`);
      }
    }
  }
}

void main();
