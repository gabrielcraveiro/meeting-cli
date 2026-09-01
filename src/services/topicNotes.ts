import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../config';
import { refreshIfStale, search } from './vaultIndex';
import { chatWithMeetings } from './organizer';

// Nota macro por tema: Temas/<Tema>.md consolida o que se sabe sobre um assunto
// que se espalhou por dezenas de reuniões (ex.: "autorizador" tem 88 notas).
//
// ECONOMIA É REQUISITO DE PROJETO — decisões tomadas por isso:
//  1. UMA chamada ao modelo barato (luna), não agente: quem descobre as notas do
//     tema é o índice léxico LOCAL (grátis), não turnos de Grep/Read do claude.
//  2. Transcrição NUNCA entra: só a parte organizada da nota (resumo/decisões/
//     pontos), truncada — ~90% menos tokens por nota.
//  3. INCREMENTAL: a nota do tema guarda quais arquivos já foram incorporados;
//     a atualização manda só o tema atual + as notas NOVAS. Sem notas novas,
//     retorna sem chamar nada (custo zero).
//  4. Reuniões do MESMO dia viram um bloco só — várias agendas do mesmo assunto
//     num dia ("Pix no app") são uma sessão contínua, não N eventos.

const SRC_BLOCK = /<!--\s*meeting-cli:topic-sources\n([\s\S]*?)-->/;
/** teto por nota no prompt — resumo/decisões cabem folgado */
const PER_NOTE_CHARS = 1600;
/** teto de notas novas por atualização (as mais recentes primeiro) */
const MAX_NEW_NOTES = 14;
/** candidatas do índice por tema */
const MAX_HITS = 40;

export interface TopicResult {
  file: string;
  added: number;
  skipped: boolean;   // true = nada novo, não chamou o modelo
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 60);
}

/** Parte organizada da nota (sem frontmatter e sem transcrição), truncada. */
function organizedPart(raw: string): string {
  const body = raw.split('## Transcricao')[0].replace(/^---[\s\S]*?---\n/, '').trim();
  return body.length > PER_NOTE_CHARS ? `${body.slice(0, PER_NOTE_CHARS)}…` : body;
}

/** Notas do vault que pertencem ao tema, mais recentes primeiro. */
function topicNotes(config: Config, topic: string): Array<{ file: string; title: string; date: string }> {
  refreshIfStale(config);
  return search(topic, MAX_HITS)
    .filter(h => h.file.startsWith('Meetings/') && !h.file.includes('(prep)'))
    .map(h => ({ file: h.file, title: h.title, date: h.date }))
    .sort((a, b) => b.file.localeCompare(a.file));
}

/**
 * Cria/atualiza Temas/<Tema>.md. Retorna skipped=true quando não havia nota
 * nova (nenhuma chamada ao modelo).
 */
export async function buildTopicNote(config: Config, topic: string): Promise<TopicResult> {
  const dir = path.join(config.vaultPath, 'Temas');
  const file = path.join(dir, `${sanitize(topic)}.md`);

  let existingBody = '';
  const already = new Set<string>();
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf-8');
    const m = raw.match(SRC_BLOCK);
    if (m) m[1].split('\n').map(l => l.trim()).filter(Boolean).forEach(f => already.add(f));
    existingBody = raw.replace(SRC_BLOCK, '').replace(/^---[\s\S]*?---\n/, '').trim();
  }

  const all = topicNotes(config, topic);
  const fresh = all.filter(n => !already.has(n.file)).slice(0, MAX_NEW_NOTES);
  if (fresh.length === 0) {
    return { file: `Temas/${path.basename(file)}`, added: 0, skipped: true };
  }

  // Agrupa por dia: N agendas do mesmo assunto no mesmo dia = uma sessão.
  const byDay = new Map<string, string[]>();
  for (const n of fresh) {
    let content = '';
    try { content = organizedPart(fs.readFileSync(path.join(config.vaultPath, n.file), 'utf-8')); } catch { continue; }
    if (!content) continue;
    const day = n.date || n.file.slice(9, 19);
    byDay.set(day, [...(byDay.get(day) ?? []), `[[${n.title}]]\n${content}`]);
  }
  if (byDay.size === 0) {
    return { file: `Temas/${path.basename(file)}`, added: 0, skipped: true };
  }
  const newBlocks = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, parts]) => `## ${day}${parts.length > 1 ? ` (${parts.length} reuniões no dia — trate como sessão contínua)` : ''}\n${parts.join('\n\n')}`)
    .join('\n\n');

  const system =
    'Voce mantem a NOTA MACRO de um tema no Obsidian do usuario — a fonte unica sobre o assunto, '
    + 'construida a partir de notas de reuniao. PT-BR, denso e curto.\n'
    + 'Formato EXATO (headers ##, omita secao vazia):\n'
    + '## Estado atual — 3-5 bullets: o que JA esta definido hoje.\n'
    + '## Em aberto — o que falta decidir, com quem depende.\n'
    + '## Linha do tempo — `AAAA-MM-DD — decisao/virada · [[nota]]` (so viradas REAIS; agrupe o '
    + 'mesmo dia numa linha; MAXIMO 12 linhas: se estourar, condense as mais antigas).\n'
    + '## Porques — 2-4 bullets de razoes/trade-offs que se perdem entre reunioes.\n'
    + 'REGRAS: consolide, nao acumule — se a versao anterior da nota macro for dada, REESCREVA-A '
    + 'integrando o novo (decisao nova SUBSTITUI a antiga; mencione a mudanca se foi reversao). '
    + 'Nao invente. Sem preambulo. Nao repita a mesma informacao em duas secoes.';

  const user =
    (existingBody ? `# Nota macro atual (reescreva integrando o novo)\n${existingBody}\n\n` : '')
    + `# Tema: ${topic}\n\n# Notas ${existingBody ? 'NOVAS' : ''} do tema\n${newBlocks}`;

  const out = (await chatWithMeetings(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    config,
  )).trim();
  if (!out) throw new Error('modelo retornou vazio');

  const sources = [...already, ...fresh.map(n => n.file)];
  const today = new Date().toLocaleDateString('sv').slice(0, 10);
  const note =
    `---\ntype: tema\ntitle: "${topic}"\ntags: [tema]\nupdated: ${today}\n`
    + `sources_count: ${sources.length}\n---\n`
    + `# ${topic}\n\n${out}\n\n`
    + `<!--meeting-cli:topic-sources\n${sources.join('\n')}\n-->\n`;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, note, 'utf-8');
  return { file: `Temas/${path.basename(file)}`, added: fresh.length, skipped: false };
}

/** Temas já existentes em Temas/. */
export function listTopics(config: Config): Array<{ file: string; title: string; updated: string; sources: number }> {
  const dir = path.join(config.vaultPath, 'Temas');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }
  return files.map(f => {
    let head = '';
    try { head = fs.readFileSync(path.join(dir, f), 'utf-8').slice(0, 400); } catch {}
    return {
      file: `Temas/${f}`,
      title: f.replace(/\.md$/, ''),
      updated: head.match(/^updated:\s*(\S+)/m)?.[1] ?? '',
      sources: parseInt(head.match(/^sources_count:\s*(\d+)/m)?.[1] ?? '0', 10),
    };
  }).sort((a, b) => b.updated.localeCompare(a.updated));
}

/**
 * Sugestões de tema: termos frequentes nos títulos das notas recentes que ainda
 * não têm nota macro. Só contagem local — zero chamada de modelo.
 */
export function suggestTopics(config: Config, limit = 8): Array<{ topic: string; notes: number }> {
  const dir = path.join(config.vaultPath, 'Meetings');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.includes('(prep)')); } catch { return []; }
  const STOP = new Set(['reuniao','reunião','alinhamento','sobre','para','com','das','dos','the','and','call','sync','time','nota','titulo','título','check','round','entre','plano','novo','nova']);
  const freq = new Map<string, number>();
  for (const f of files.sort().slice(-120)) {
    const title = f.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2} - /, '');
    const seen = new Set<string>();
    for (const w of title.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (w.length < 4 || STOP.has(w) || seen.has(w)) continue;
      seen.add(w);
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  const have = new Set(listTopics(config).map(t => t.title.toLowerCase()));
  return [...freq.entries()]
    .filter(([w, n]) => n >= 3 && !have.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([topic, notes]) => ({ topic, notes }));
}
