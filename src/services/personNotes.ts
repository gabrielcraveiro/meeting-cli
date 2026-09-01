import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../config';

// Dossiê por pessoa: reuniões 1:1 acumulam num arquivo Pessoas/<Nome>.md —
// a "nota macro" da relação. A nota da reunião continua existindo (transcript,
// tarefas, pipeline intacto); aqui entra só o digest datado com wikilink.
// Ações entram como bullets SIMPLES (sem checkbox) de propósito: checkbox
// duplicado contaria duas vezes no agregado de tarefas (#meeting/action).

export interface PersonDigest {
  /** nome completo da outra pessoa do 1:1 */
  person: string;
  date: string;   // YYYY-MM-DD
  time: string;   // HH:mm
  /** nome do arquivo da nota da reunião SEM .md (vira wikilink) */
  noteFileBase: string;
  /** parágrafo do ## Resumo da nota */
  summary: string;
  /** decisões/combinados como texto puro */
  bullets: string[];
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Acrescenta o digest de um 1:1 à página da pessoa (cria se não existir).
 * Idempotente por wikilink: se a seção desta reunião já está lá, não duplica.
 * Retorna o path da página, ou null se pulou.
 */
export function appendPersonDigest(config: Config, d: PersonDigest): string | null {
  const person = d.person.replace(/\s*\([^)]*\)\s*$/, '').trim();  // remove "(ouvinte)" etc
  if (!person || person.length < 3) return null;

  const dir = path.join(config.vaultPath, 'Pessoas');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sanitizeFileName(person)}.md`);

  const wikilink = `[[${d.noteFileBase}]]`;
  let existing = '';
  if (fs.existsSync(file)) {
    existing = fs.readFileSync(file, 'utf-8');
    if (existing.includes(wikilink)) return null;  // já registrado
  } else {
    existing =
      `---\n` +
      `type: pessoa\n` +
      `name: "${person}"\n` +
      `tags: [pessoa]\n` +
      `---\n` +
      `# ${person}\n\n` +
      `Histórico de conversas 1:1 — cada seção linka a nota completa da reunião.\n`;
  }

  const bullets = d.bullets
    .map(b => b.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map(b => `- ${b}`)
    .join('\n');

  const section =
    `\n## ${d.date} ${d.time} — ${wikilink}\n` +
    `${d.summary.trim()}\n` +
    (bullets ? `${bullets}\n` : '');

  fs.writeFileSync(file, `${existing.replace(/\n+$/, '\n')}${section}`, 'utf-8');
  return file;
}

/** Extrai o parágrafo do ## Resumo do corpo organizado (fallback: 1º parágrafo). */
export function extractSummary(body: string): string {
  const m = body.match(/^## Resumo\s*\n+([\s\S]*?)(?=\n## |\n*$)/m);
  const text = (m ? m[1] : body).trim().split(/\n{2,}/)[0]?.trim() ?? '';
  return text.length > 700 ? `${text.slice(0, 700)}…` : text;
}

/** Ações da nota como texto puro (sem checkbox/tags — não duplicar tarefas). */
export function extractActionBullets(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('- [ ]') || !line.includes('#meeting/action')) continue;
    const text = line
      .slice('- [ ]'.length)
      .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/#meeting\/action/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * Reunião 1:1? Exatamente 2 participantes, um deles o dono da ferramenta
 * (match por primeiro nome do config.userName). Retorna a OUTRA pessoa.
 */
export function detectOneOnOne(participants: string[], config: Config): string | null {
  const clean = participants
    .map(p => p.replace(/\s*\([^)]*\)\s*$/, '').trim())
    .filter(Boolean);
  if (clean.length !== 2) return null;
  const userFirst = (config.userName ?? '').trim().split(/\s+/)[0]?.toLowerCase();
  if (!userFirst) return null;
  const isUser = (n: string) => n.split(/\s+/)[0].toLowerCase() === userFirst;
  if (isUser(clean[0]) === isUser(clean[1])) return null;  // zero ou dois "eu"
  return isUser(clean[0]) ? clean[1] : clean[0];
}
