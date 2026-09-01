import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../config';
import { refreshIfStale, searchRelated } from './vaultIndex';
import { chatWithMeetings } from './organizer';
import { extractSection } from './storage';

// Preparação pré-reunião: uma nota curta gerada pelo haiku (via chatWithMeetings,
// motor barato) juntando o que o vault já sabe sobre o tema/participantes com
// pendências em aberto que os envolvidos carregam de reuniões passadas. O
// objetivo é o usuário abrir a nota 10min antes e já saber "o que rolou" e "o
// que cobrar" sem reler nada.

const SYSTEM_PROMPT =
  'Voce prepara um briefing pre-reuniao de NO MAXIMO 12 linhas em portugues. Formato: '
  + '## Contexto (2-3 bullets do historico), ## Pendencias abertas (bullets com responsavel), '
  + '## Sugestao de pauta (2-3 bullets). Sem introducao, sem despedida.\n'
  + 'FIO DA CONVERSA: se ha reunioes anteriores do MESMO tema, o Contexto deve dizer onde a '
  + 'conversa PAROU (ultima decisao, o que ficou aberto) priorizando as notas mais recentes — '
  + 'continuidade vale mais que apanhado geral.\n'
  + 'RELEVANCIA: use SOMENTE historico que trata do MESMO assunto da reuniao. Colisao de '
  + 'palavra NAO e relacao — ex.: o produto "Reposicao Gerenciada" nao tem a ver com '
  + '"reposicao de pessoa no time". Na duvida, deixe de fora; briefing curto e certo vale '
  + 'mais que briefing cheio e errado.\n'
  + 'SENSIVEL: NUNCA inclua assuntos de pessoas (desligamento, remuneracao, avaliacao, '
  + 'saude, conflitos) — a nota de prep pode ser aberta em tela compartilhada durante a '
  + 'reuniao. Se o historico so tiver isso, responda apenas com a pauta baseada no titulo.';

/** Nota/linha com assunto sensível de pessoas nunca entra no material do prep —
 * defesa na FONTE (o modelo não vaza o que não vê); o prompt reforça. */
const SENSITIVE_RE =
  /desligamento|desligar|demiss|demitir|remunera|sal[aá]rio|reajuste|promo[cç][aã]o de|avalia[cç][aã]o de desempenho|headcount|contrata[cç][aã]o de/i;

const MAX_USER_CONTENT = 6000;
const MAX_NOTE_CONTEXT = 500;
const MAX_RELATED_NOTES = 4;
const MAX_ATTENDEE_ACTIONS = 10;

export interface PrepEvent {
  title: string;
  start: Date;
  attendees: string[];
}

/** Remove diacríticos preservando comparação simples (case/acento-insensitive). */
function foldAccents(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * true quando o título bate (substring, sem acento, case-insensitive) com algum
 * padrão de agendaIgnore. Default ['daily'] quando o campo não está configurado —
 * a maioria dos calendários tem uma daily que não vale a pena preparar.
 */
export function isIgnoredMeeting(title: string, config: Config): boolean {
  const normTitle = foldAccents(title.toLowerCase()).trim();
  // Evento cancelado/adiado no Outlook mantém o VEVENT com prefixo no título —
  // não vale gastar prep (nem IA) numa reunião que não vai acontecer.
  if (/^(cancelad|canceled|cancelled|adiad|postponed|declinad)/.test(normTitle)) return true;
  const patterns = config.agendaIgnore ?? ['daily'];
  return patterns.some(p => normTitle.includes(foldAccents(p.toLowerCase())));
}

function sanitizeTitle(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 60);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Caminho da nota de prep — data/hora LOCAL do evento, igual à convenção de storage.ts. */
function prepFilePath(config: Config, event: PrepEvent): { path: string; date: string; time: string } {
  const d = event.start;
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const timeColon = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const timeDash = timeColon.replace(':', '-');
  const fileName = `${date} ${timeDash} - ${sanitizeTitle(event.title)} (prep).md`;
  return { path: path.join(config.vaultPath, 'Meetings', fileName), date, time: timeColon };
}

/** "## Resumo" + action items abertos de uma nota do vault, cortado em 500 chars. */
function noteContext(config: Config, relFile: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(path.join(config.vaultPath, relFile), 'utf-8');
  } catch {
    return null;
  }
  const resumo = extractSection(content, 'Resumo');
  const openActions = content
    .split('\n')
    .filter(l => /^\s*- \[ \] /.test(l) && l.includes('#meeting/action'));

  let block = '';
  if (resumo) block += `Resumo: ${resumo}\n`;
  if (openActions.length > 0) block += `Pendencias:\n${openActions.join('\n')}\n`;
  if (!block) return null;
  if (SENSITIVE_RE.test(block)) return null;  // assunto de pessoas fica fora do prep
  return block.slice(0, MAX_NOTE_CONTEXT);
}

/** Primeiro nome de cada attendee — usado pra casar action items sem exigir nome completo. */
function firstNames(attendees: string[]): string[] {
  return attendees.map(a => a.trim().split(/\s+/)[0]).filter(Boolean).map(n => n.toLowerCase());
}

/**
 * Varredura manual em Meetings/*.md por action items abertos que citem o
 * primeiro nome de algum attendee — pega pendências de reuniões que a busca
 * léxica por título pode não trazer (ex: 1:1 antigo com o mesmo participante).
 */
function openActionItemsForAttendees(config: Config, attendees: string[]): string[] {
  const names = firstNames(attendees);
  if (names.length === 0) return [];

  const dir = path.join(config.vaultPath, 'Meetings');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }

  const out: string[] = [];
  for (const f of files) {
    if (out.length >= MAX_ATTENDEE_ACTIONS) break;
    let content: string;
    try { content = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (out.length >= MAX_ATTENDEE_ACTIONS) break;
      if (!/^\s*- \[ \] /.test(line) || !line.includes('#meeting/action')) continue;
      if (SENSITIVE_RE.test(line)) continue;  // pendência sensível não entra no prep
      const lower = line.toLowerCase();
      if (names.some(n => lower.includes(n))) out.push(line.trim());
    }
  }
  return out;
}

export async function generatePrepNote(config: Config, event: PrepEvent): Promise<string | null> {
  const { path: filePath, date, time } = prepFilePath(config, event);
  // Idempotente: já existe (call em fila de novo, retry do timer) — não regenera.
  if (fs.existsSync(filePath)) return filePath;

  refreshIfStale(config);
  // Busca ESTRITA: título genérico ("[99+ Epharma] PBM Meeting") não pode
  // arrastar contexto de qualquer nota que diga "epharma". Sem histórico
  // realmente do assunto, o prep sai só com a pauta — e tudo bem.
  // Nota de prep NÃO alimenta prep: era contexto gerado virando fonte de
  // contexto novo (erro se propagava e crescia a cada reunião do mesmo nome).
  const hits = [...searchRelated(event.title, 4), ...searchRelated(event.attendees.join(' '), 2)]
    .filter(h => !h.file.includes('(prep)'));
  const seenFiles = new Set<string>();
  const relatedNotes: string[] = [];
  for (const hit of hits) {
    if (relatedNotes.length >= MAX_RELATED_NOTES) break;
    if (seenFiles.has(hit.file)) continue;
    seenFiles.add(hit.file);
    const ctx = noteContext(config, hit.file);
    if (ctx) relatedNotes.push(`### ${hit.title} (${hit.date})\n${ctx}`);
  }

  const attendeeActions = openActionItemsForAttendees(config, event.attendees);

  let userContent = `Titulo da reuniao: ${event.title}\n`
    + `Participantes: ${event.attendees.length > 0 ? event.attendees.join(', ') : '(nao informado)'}\n\n`;
  if (relatedNotes.length > 0) {
    userContent += `# Historico relacionado\n${relatedNotes.join('\n\n')}\n\n`;
  }
  if (attendeeActions.length > 0) {
    userContent += `# Pendencias abertas de participantes (outras reunioes)\n${attendeeActions.join('\n')}\n`;
  }
  userContent = userContent.slice(0, MAX_USER_CONTENT);

  let briefing: string;
  try {
    briefing = await chatWithMeetings(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      config,
    );
  } catch {
    return null;  // erro de IA — nunca cria nota vazia
  }
  if (!briefing || !briefing.trim()) return null;

  const noteContent = `---
type: meeting-prep
tags: [meeting, prep]
date: ${date}
time: ${time}
title: "${event.title} (prep)"
---
# ${event.title} — preparação

${briefing.trim()}

---
## Suas anotações
`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, noteContent);
  return filePath;
}

// ── Ciclo de vida da prep ────────────────────────────────────────────────
// A nota de prep é efêmera: serve nos 10 minutos antes da reunião e vira ruído
// depois (aparece em Recentes, na lateral, na busca). Some por dois caminhos:
// quando a nota real da reunião nasce (a prep foi superada) e numa faxina das
// que ficaram para trás. Nunca apaga de verdade — vai para .trash/ do vault,
// recuperável no Obsidian.

/** Move um arquivo do vault para .trash/, sem sobrescrever homônimo. */
function moveToTrash(config: Config, absPath: string): boolean {
  try {
    const trash = path.join(config.vaultPath, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    let dest = path.join(trash, path.basename(absPath));
    if (fs.existsSync(dest)) dest = path.join(trash, `${Date.now()}-${path.basename(absPath)}`);
    fs.renameSync(absPath, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Arquiva a prep correspondente a uma reunião que acabou de virar nota:
 * mesmo dia e horário a até 40min do início. Retorna o nome arquivado.
 */
export function archivePrepForNote(config: Config, noteDate: string, noteTime: string): string | null {
  const dir = path.join(config.vaultPath, 'Meetings');
  const [h, m] = noteTime.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const noteMin = h * 60 + m;

  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.startsWith(noteDate) && f.endsWith('(prep).md'));
  } catch { return null; }

  for (const f of files) {
    const t = f.match(/^\d{4}-\d{2}-\d{2} (\d{2})-(\d{2}) - /);
    if (!t) continue;
    if (Math.abs(+t[1] * 60 + +t[2] - noteMin) > 40) continue;
    if (moveToTrash(config, path.join(dir, f))) return f;
  }
  return null;
}

/**
 * Faxina das preps de dias anteriores (a reunião já passou, com ou sem nota).
 * Roda no boot do daemon e uma vez por dia. Devolve quantas arquivou.
 */
export function archiveStalePreps(config: Config): number {
  const dir = path.join(config.vaultPath, 'Meetings');
  const today = new Date().toLocaleDateString('sv').slice(0, 10);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('(prep).md'));
  } catch { return 0; }

  let n = 0;
  for (const f of files) {
    const day = f.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= today) continue;  // hoje fica
    if (moveToTrash(config, path.join(dir, f))) n++;
  }
  return n;
}
