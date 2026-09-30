import fs from 'fs';
import path from 'path';
import type { Config } from '../config';
import { seriesKey } from './series';
import { noteThemes } from './themes';

// Assuntos em aberto (#meeting/topic): o que ficou sem desfecho numa reunião e
// vai voltar numa próxima. O organizador escreve; aqui só lemos e ranqueamos.
// Fechar usa o mesmo caminho da action (closeSingleTask em taskCloser.ts).

export interface OpenTopic {
  /** relpath no vault — junto com `line`, é o token para fechar o assunto */
  file: string;
  /** linha exata (trimmed) como está no arquivo */
  line: string;
  subject: string;
  /** o que falta para fechar */
  missing?: string;
  /** pessoa, papel ou evento aguardado */
  waitingOn?: string;
  noteTitle: string;
  noteDate: string;
  /** série da nota de origem (frontmatter `series:`) */
  series?: string;
  /** temas da nota de origem (frontmatter `temas:`) */
  themes: string[];
}

const TAG = '#meeting/topic';
/** Suficiente para o frontmatter; a linha do assunto pede o arquivo inteiro. */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/**
 * Parse one open-topic line.
 *
 * @example
 * parseTopicLine('- [ ] **RDM 74892** — falta: aprovação · aguardando: Denis #meeting/topic')
 * // → { subject: 'RDM 74892', missing: 'aprovação', waitingOn: 'Denis' }
 */
export function parseTopicLine(line: string): { subject: string; missing?: string; waitingOn?: string } | null {
  let rest = line.replace(/^- \[ \]\s*/, '').replace(TAG, '').trim();
  const bold = rest.match(/^\*\*(.+?)\*\*\s*[—–-]?\s*/);
  let subject = '';
  if (bold) {
    subject = bold[1].trim();
    rest = rest.slice(bold[0].length);
  }
  const waitingOn = rest.match(/aguardando:\s*(.+?)\s*$/i)?.[1]?.trim();
  if (waitingOn) rest = rest.replace(/\s*·?\s*aguardando:\s*.+$/i, '');
  const missing = rest.match(/falta:\s*(.+?)\s*$/i)?.[1]?.trim();
  if (!subject) subject = (missing ? rest.replace(/\s*[—–-]?\s*falta:.*$/i, '') : rest).trim();
  if (!subject) return null;
  return { subject, missing: missing || undefined, waitingOn: waitingOn || undefined };
}

/** Assuntos ABERTOS de todas as notas de reunião, mais recentes primeiro. */
export function listOpenTopics(config: Config): OpenTopic[] {
  const dir = path.join(config.vaultPath, 'Meetings');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }

  const out: OpenTopic[] = [];
  for (const f of files) {
    let content = '';
    try { content = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { continue; }
    if (!content.includes(TAG)) continue;

    const fm = content.match(FRONTMATTER_RE)?.[1] ?? '';
    const noteDate = f.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
    const noteTitle = (fm.match(/^title:\s*"?(.*?)"?\s*$/m)?.[1] ?? '').trim()
      || f.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2} - /, '');
    const series = fm.match(/^series:\s*"?(.*?)"?\s*$/m)?.[1]?.trim() || undefined;
    const themes = noteThemes(fm) ?? [];

    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('- [ ]') || !line.includes(TAG)) continue;
      const parsed = parseTopicLine(line);
      if (parsed) out.push({ file: `Meetings/${f}`, line, ...parsed, noteTitle, noteDate, series, themes });
    }
  }
  return out.sort((a, b) => b.file.localeCompare(a.file));
}

/** Teto do card da call: mais que isso vira lista que ninguém lê em reunião. */
const MAX_CALL_TOPICS = 6;
/** Notas recentes da série que definem os temas "desta reunião". */
const SERIES_THEME_SAMPLE = 3;

/**
 * Rank open topics for the call in progress.
 *
 * Order: same series (exact calendar title) → shares a theme with the recent
 * notes of that series → `isTopical(text)` (lexical fallback for series
 * without history). The call has no themes of its own yet: the organizer
 * classifies it only at the end, so we borrow them from the series.
 */
export function topicsForCall(
  all: OpenTopic[],
  config: Config,
  sessionTitle: string,
  isTopical: (text: string) => boolean,
): { series: string; themes: string[]; topics: Array<OpenTopic & { why: 'serie' | 'tema' | 'texto' }> } {
  const series = seriesKey(sessionTitle);
  const themes = series ? seriesThemes(config, series) : [];
  const ranked: Array<OpenTopic & { why: 'serie' | 'tema' | 'texto' }> = [];
  const seen = new Set<string>();
  const add = (t: OpenTopic, why: 'serie' | 'tema' | 'texto') => {
    const key = `${t.file}|${t.line}`;
    if (seen.has(key) || ranked.length >= MAX_CALL_TOPICS) return;
    seen.add(key);
    ranked.push({ ...t, why });
  };
  if (series) for (const t of all) if (t.series === series) add(t, 'serie');
  if (themes.length) for (const t of all) if (t.themes.some(x => themes.includes(x))) add(t, 'tema');
  for (const t of all) if (isTopical(`${t.subject} ${t.missing ?? ''} ${t.noteTitle}`)) add(t, 'texto');
  return { series, themes, topics: ranked };
}

/** Temas das notas mais recentes da mesma série (só frontmatter — drvfs é lento). */
function seriesThemes(config: Config, series: string): string[] {
  const dir = path.join(config.vaultPath, 'Meetings');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse(); } catch { return []; }
  const out: string[] = [];
  let sampled = 0;
  for (const f of files) {
    if (sampled >= SERIES_THEME_SAMPLE) break;
    let head = '';
    try {
      const fd = fs.openSync(path.join(dir, f), 'r');
      const buf = Buffer.alloc(2048);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, 2048, 0)).toString('utf-8');
      fs.closeSync(fd);
    } catch { continue; }
    const fm = head.match(FRONTMATTER_RE)?.[1] ?? '';
    if ((fm.match(/^series:\s*"?(.*?)"?\s*$/m)?.[1] ?? '').trim() !== series) continue;
    sampled++;
    for (const t of noteThemes(fm) ?? []) if (!out.includes(t)) out.push(t);
  }
  return out;
}
