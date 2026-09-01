import fs from 'fs';
import path from 'path';
import { Config } from '../config';

// Fechamento de pendências (ciclo Granola) com o agente SEM ferramenta Edit:
// a transcrição é entrada não confiável (qualquer participante da call pode
// falar algo que vire instrução), então o claude apenas PROPÕE fechamentos num
// bloco estruturado no fim da nota — e este módulo valida e aplica. O único
// diff que pode acontecer no vault é `- [ ]` → `- [x] … ✅ <data>` numa linha
// #meeting/action cujo texto o agente citou EXATAMENTE.

const BLOCK_RE = /<!--\s*meeting-cli:fechar\n([\s\S]*?)-->/;

export interface ClosedTask {
  file: string;   // relpath no vault
  line: string;   // texto original da linha
}

export interface TaskClosureResult {
  /** corpo da nota sem o bloco de máquina */
  summary: string;
  closed: ClosedTask[];
  rejected: string[];  // propostas que falharam na validação (auditoria/log)
}

/**
 * Extrai o bloco `<!--meeting-cli:fechar ... -->` da saída do organizador,
 * valida cada proposta e aplica o flip do checkbox na nota de origem.
 * Formato de cada linha do bloco: `caminho/relativo.md :: - [ ] texto exato #meeting/action`
 */
export function applyTaskClosures(config: Config, rawSummary: string, meetingDate: string): TaskClosureResult {
  const m = rawSummary.match(BLOCK_RE);
  if (!m) return { summary: rawSummary, closed: [], rejected: [] };

  const summary = rawSummary.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  const closed: ClosedTask[] = [];
  const rejected: string[] = [];

  for (const rawLine of m[1].split('\n')) {
    const entry = rawLine.trim();
    if (!entry) continue;
    const sep = entry.indexOf('::');
    if (sep < 1) { rejected.push(entry); continue; }

    const relFile = entry.slice(0, sep).trim();
    const taskLine = entry.slice(sep + 2).trim();

    if (closeSingleTask(config, relFile, taskLine, meetingDate)) {
      closed.push({ file: relFile, line: taskLine });
    } else {
      rejected.push(entry);
    }
  }

  return { summary, closed, rejected };
}

/**
 * Flip validado de UMA linha `- [ ] … #meeting/action` → `- [x] … ✅ data`.
 * Mesmas validações duras do fluxo do organizador; também é o backend do
 * checkbox da tela de tarefas do app. Retorna false em qualquer desvio.
 */
export function closeSingleTask(config: Config, relFile: string, taskLine: string, date: string): boolean {
  const vaultRoot = path.resolve(config.vaultPath);
  const target = path.resolve(vaultRoot, relFile);
  if (!target.startsWith(vaultRoot + path.sep)) return false;
  if (!target.endsWith('.md') || !fs.existsSync(target)) return false;
  if (!taskLine.startsWith('- [ ]') || !taskLine.includes('#meeting/action')) return false;

  try {
    const content = fs.readFileSync(target, 'utf-8');
    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.trim() === taskLine);
    if (idx === -1) return false;

    const indent = lines[idx].slice(0, lines[idx].indexOf('- [ ]'));
    const rest = taskLine.slice('- [ ]'.length).trimStart();
    const alreadyDated = /✅\s*\d{4}-\d{2}-\d{2}/.test(rest);
    lines[idx] = `${indent}- [x] ${rest}${alreadyDated ? '' : ` ✅ ${date}`}`;
    fs.writeFileSync(target, lines.join('\n'), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export interface OpenTask {
  /** relpath no vault — junto com `line`, é o token para fechar a tarefa */
  file: string;
  /** linha exata (trimmed) como está no arquivo */
  line: string;
  /** texto limpo para exibição (sem checkbox, dono, prazo e tags) */
  text: string;
  owner?: string;
  /** true = tarefa do próprio usuário: sem prefixo **Nome:** (convenção do
   * organizador) ou dono batendo com config.userName */
  mine: boolean;
  /** prazo YYYY-MM-DD, se a linha tem 📅 */
  due?: string;
  noteTitle: string;
  noteDate: string;
}

/** Agregado de action items ABERTOS de todas as notas de reunião do vault. */
export function listOpenTasks(config: Config): OpenTask[] {
  const dir = path.join(config.vaultPath, 'Meetings');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }

  const userFirst = (config.userName ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';

  const out: OpenTask[] = [];
  for (const f of files) {
    let content = '';
    try { content = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { continue; }
    if (!content.includes('#meeting/action')) continue;

    const noteDate = f.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
    const noteTitle = f.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2} - /, '');

    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('- [ ]') || !line.includes('#meeting/action')) continue;

      let text = line.slice('- [ ]'.length).trim();
      const due = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1];
      const owner = text.match(/^\*\*([^*:]+?):?\*\*:?\s*/)?.[1]?.trim();
      text = text
        .replace(/^\*\*[^*]+\*\*:?\s*/, '')
        .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
        .replace(/#meeting\/action/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!text) continue;

      const mine =
        !owner ||
        (!!userFirst && owner.trim().split(/\s+/)[0].toLowerCase() === userFirst);
      out.push({ file: `Meetings/${f}`, line, text, owner, mine, due, noteTitle, noteDate });
    }
  }

  // Com prazo primeiro (vencidas no topo), depois as de notas mais recentes
  out.sort((a, b) =>
    (a.due ?? '9999-99-99').localeCompare(b.due ?? '9999-99-99')
    || b.noteDate.localeCompare(a.noteDate));
  return out;
}
