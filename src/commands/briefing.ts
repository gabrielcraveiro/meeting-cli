import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { requireConfig, Config } from '../config';
import { getUpcomingMeetings, formatEventTime, CalendarEvent } from '../services/calendar';
import { notifyWindows } from '../services/notify';
import { ensureTasksDashboard } from '../services/storage';

// Briefing matinal (Fase 1 do roadmap): o motor claude headless le a agenda de
// hoje (ICS) + o vault Obsidian e devolve o dia pronto — reunioes com contexto
// das anteriores, action items vencendo/parados e temas recorrentes sem decisao.
//
// Roda de manha via cron (--quiet). Degrada de forma graciosa: sem ICS funciona
// so com o vault; sem o binario `claude` monta um briefing basico sem IA.

const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TASK_LINES = 200;

interface BriefingOptions {
  quiet?: boolean;
  note?: boolean;  // commander: --no-note => note === false
}

export async function cmdBriefing(options: BriefingOptions = {}): Promise<void> {
  const config = requireConfig();
  const quiet = !!options.quiet;
  const saveNote = options.note !== false;

  const now = new Date();
  const today = localDate(now);
  const log = (msg: string) => { if (!quiet) console.log(msg); };

  log('\n' + chalk.bold('☀ Briefing do dia') + chalk.gray(`  ${today}`) + '\n');

  // 1) Agenda de hoje (tolerante a ausencia/erro de ICS)
  let events: CalendarEvent[] = [];
  let calendarWarning = '';
  if (config.icsUrl) {
    try {
      const hoursLeftToday = hoursUntilEndOfDay(now);
      const upcoming = await getUpcomingMeetings(config.icsUrl, hoursLeftToday);
      events = upcoming.filter(e => localDate(e.start) === today);
    } catch (err: any) {
      calendarWarning = `Nao foi possivel ler o calendario ICS: ${err?.message || err}`;
      log(chalk.yellow(`  ⚠ ${calendarWarning}`));
    }
  } else {
    calendarWarning = 'Sem icsUrl configurado — briefing gerado apenas com o vault.';
    log(chalk.gray(`  (sem calendario configurado — usando so o vault)`));
  }

  log(chalk.gray(`  Reunioes de hoje: ${events.length}`));
  log(chalk.gray('  Consultando o vault com o motor claude...\n'));

  // Garante que o dashboard de tasks existe (o briefing fala dele)
  ensureTasksDashboard(config);

  // 2) Briefing com IA; se falhar, degrada para versao basica
  let briefing: string;
  let degraded = false;
  try {
    briefing = await runBriefingWithClaude(config, events, today, calendarWarning);
  } catch (err: any) {
    degraded = true;
    log(chalk.yellow(`  ⚠ Motor claude falhou (${err?.message || err}) — gerando briefing basico sem IA.`));
    briefing = buildFallbackBriefing(config, events, today);
  }

  const summaryLine = firstSummaryLine(briefing);

  // 3) Terminal
  if (!quiet) {
    console.log(briefing);
    console.log('');
  }

  // 4) Nota no vault
  if (saveNote) {
    try {
      const notePath = saveBriefingNote(config, today, briefing, degraded);
      log(chalk.green(`  ✓ Nota salva: ${notePath}`));
    } catch (err: any) {
      log(chalk.red(`  ✗ Falha ao salvar nota: ${err?.message || err}`));
    }
  }

  // 5) Toast
  notifyWindows('☀ Briefing do dia', summaryLine);
}

// ── Motor claude headless ────────────────────────────────────────────

async function runBriefingWithClaude(
  config: Config,
  events: CalendarEvent[],
  today: string,
  calendarWarning: string,
): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-briefing-'));
  try {
    const agendaPath = path.join(tmpDir, 'agenda.md');
    fs.writeFileSync(agendaPath, renderAgenda(events, today, calendarWarning), 'utf-8');

    const prompt = buildBriefingPrompt(config, today, agendaPath);

    const args = [
      '-p',
      '--output-format', 'json',
      '--model', config.claudeModel || 'claude-sonnet-5',
      '--max-turns', '25',
      '--allowedTools', 'Read', 'Grep', 'Glob',
      '--add-dir', tmpDir,
    ];

    const raw = await runClaude(args, prompt, config.vaultPath);
    const data = JSON.parse(raw) as { result?: string; is_error?: boolean };
    if (data.is_error || !data.result?.trim()) {
      throw new Error(`claude retornou erro ou resultado vazio: ${(data.result || '').slice(0, 200)}`);
    }
    return data.result.trim().replace(/^```(?:markdown)?\n([\s\S]*)\n```$/m, '$1');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function buildBriefingPrompt(config: Config, today: string, agendaPath: string): string {
  const who = config.userName ? ` O usuario e ${config.userName}.` : '';
  return (
    `<role>Chefe de gabinete do usuario.${who} Toda manha voce entrega um briefing curto que faz ` +
    `ele comecar o dia sabendo exatamente o que importa. Voce escreve em portugues do Brasil.</role>\n\n` +
    `<contexto>\nHoje e ${today}.\n` +
    `Agenda de hoje (ja extraida do calendario): ${agendaPath}\n` +
    `Vault Obsidian (suas notas de reuniao): ${config.vaultPath} — as notas ficam em Meetings/, ` +
    `com frontmatter YAML (date, participants, tags, title).\n` +
    `Voce esta em modo agente com ferramentas READ-ONLY (Read, Grep, Glob).\n</contexto>\n\n` +
    `<workflow>\n` +
    `1. Leia a agenda em ${agendaPath}.\n` +
    `2. Para CADA reuniao de hoje: use Grep/Glob/Read no vault para achar as ultimas notas com os ` +
    `mesmos participantes ou o mesmo tema. Traga o que ficou pendente e o contexto que a pessoa ` +
    `precisa lembrar antes de entrar na call (decisoes anteriores, o que foi prometido, o que travou).\n` +
    `3. Action items abertos: rode Grep pelo padrao "- [ ] " nas notas do vault (Meetings/ e demais ` +
    `notas). Cruze com a data de hoje (${today}) e destaque, em ordem: (a) os com 📅 vencido ou ` +
    `vencendo hoje; (b) os que estao parados ha mais de 7 dias (use a data da nota de origem). ` +
    `IGNORE tasks ja marcadas ("- [x] ") — elas foram concluidas no Obsidian.\n` +
    `4. Temas recorrentes sem decisao: assuntos que aparecem em 3+ notas recentes e ainda nao ` +
    `tem uma decisao registrada. Isso e o que ninguem percebe sozinho — vale ouro.\n` +
    `</workflow>\n\n` +
    `<output>\n` +
    `Sua ULTIMA mensagem deve conter APENAS o briefing em markdown, sem preambulo e sem cercas de codigo.\n` +
    `Linha 1: uma linha-resumo do dia com NO MAXIMO 100 caracteres, sem markdown, sem header ` +
    `(ex: "3 calls, 2 tasks vencidas; elegibilidade sem decisao ha 3 semanas"). Essa linha vai num toast.\n` +
    `Depois, linha em branco e as secoes com headers ##, so as que tiverem conteudo:\n` +
    `## Reunioes de hoje — para cada uma: hora, titulo, participantes e 1-3 bullets de contexto/pendencias ` +
    `do vault, com link [[nome da nota]] quando citar uma reuniao especifica.\n` +
    `## Pendencias que cobram voce hoje — action items vencidos/vencendo hoje. Formato: ` +
    `\`- [ ] descricao — 📅 prazo · [[nota de origem]]\`.\n` +
    `## Parado ha mais de 7 dias — action items sem movimento, com quantos dias.\n` +
    `## Temas recorrentes sem decisao — tema, quantas vezes voltou, desde quando.\n\n` +
    `Regras: compacto (o dia inteiro deve caber em uma tela). Sem enfeite, sem "espero que ajude". ` +
    `Se uma secao nao tiver conteudo real, OMITA — nao escreva "nenhuma pendencia encontrada". ` +
    `Se o vault estiver praticamente vazio, diga isso em uma linha e pare.\n` +
    `</output>`
  );
}

function runClaude(args: string[], prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGTERM'); } catch {}
      reject(new Error(`claude excedeu ${TIMEOUT_MS / 60000} min — abortado`));
    }, TIMEOUT_MS);

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err.code === 'ENOENT'
        ? new Error('binario `claude` nao encontrado no PATH — instale o Claude Code CLI')
        : err);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude saiu com codigo ${code}: ${stderr.slice(0, 300)}`));
      }
      resolve(stdout);
    });

    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ── Fallback sem IA ─────────────────────────────────────────────────

function buildFallbackBriefing(config: Config, events: CalendarEvent[], today: string): string {
  const tasks = collectOpenTasks(config);
  const overdue = tasks.filter(t => t.due && t.due < today);
  const dueToday = tasks.filter(t => t.due === today);

  const summary = `${events.length} reuniao(oes) hoje, ${tasks.length} tasks abertas` +
    (overdue.length ? `, ${overdue.length} vencidas` : '');

  const lines: string[] = [summary.slice(0, 100), ''];
  lines.push('> Briefing basico (sem IA): o motor claude nao respondeu.');
  lines.push('');

  lines.push('## Reunioes de hoje');
  if (events.length === 0) {
    lines.push('- Nenhuma reuniao no calendario para hoje.');
  } else {
    for (const e of events) {
      const people = e.attendees.length ? ` — ${e.attendees.slice(0, 8).join(', ')}` : '';
      lines.push(`- ${formatEventTime(e.start)}–${formatEventTime(e.end)} **${e.title}**${people}`);
    }
  }
  lines.push('');

  if (overdue.length || dueToday.length) {
    lines.push('## Pendencias que cobram voce hoje');
    for (const t of [...overdue, ...dueToday]) {
      lines.push(`- [ ] ${t.text} · [[${t.note}]]`);
    }
    lines.push('');
  }

  if (tasks.length) {
    lines.push('## Todas as tasks abertas');
    for (const t of tasks.slice(0, 50)) {
      lines.push(`- [ ] ${t.text} · [[${t.note}]]`);
    }
    if (tasks.length > 50) lines.push(`- ... e mais ${tasks.length - 50}`);
    lines.push('');
  }

  return lines.join('\n');
}

interface OpenTask { text: string; note: string; due: string | null }

// Grep bruto por "- [ ] " nas notas do vault (usado no modo degradado)
function collectOpenTasks(config: Config): OpenTask[] {
  const out: OpenTask[] = [];
  const walk = (dir: string, depth = 0) => {
    if (depth > 4 || out.length >= MAX_TASK_LINES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= MAX_TASK_LINES) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name.endsWith('.md') && entry.name !== 'Tasks.md') {
        let content = '';
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        if (!content.includes('- [ ] ')) continue;
        for (const line of content.split('\n')) {
          const m = line.match(/^\s*- \[ \] (.+)$/);
          if (!m) continue;
          const text = m[1].trim();
          const dueMatch = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
          out.push({ text, note: entry.name.replace(/\.md$/, ''), due: dueMatch ? dueMatch[1] : null });
          if (out.length >= MAX_TASK_LINES) return;
        }
      }
    }
  };
  walk(config.vaultPath);
  return out.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
}

// ── Nota no vault ───────────────────────────────────────────────────

function saveBriefingNote(config: Config, today: string, briefing: string, degraded: boolean): string {
  const dir = path.join(config.vaultPath, 'Briefings');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${today}.md`);
  const generated = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const content = `---
type: briefing
date: ${today}
tags: [meeting-cli, briefing]
generated: "${generated}"
engine: ${degraded ? 'fallback' : 'claude'}
---
# Briefing — ${today}

${briefing}
`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ── Helpers ─────────────────────────────────────────────────────────

function renderAgenda(events: CalendarEvent[], today: string, warning: string): string {
  const lines = [`# Agenda de ${today}`, ''];
  if (warning) lines.push(`> ${warning}`, '');
  if (events.length === 0) {
    lines.push('Nenhuma reuniao no calendario para hoje.');
  } else {
    for (const e of events) {
      lines.push(`## ${formatEventTime(e.start)}–${formatEventTime(e.end)} — ${e.title}`);
      if (e.organizer) lines.push(`- Organizador: ${e.organizer}`);
      lines.push(`- Participantes: ${e.attendees.length ? e.attendees.join(', ') : '(nao informados no convite)'}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hoursUntilEndOfDay(now: Date): number {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  return Math.max(1, (end.getTime() - now.getTime()) / 3600000);
}

function firstSummaryLine(briefing: string): string {
  for (const raw of briefing.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    return line.replace(/[*_`]/g, '').slice(0, 120);
  }
  return 'Briefing do dia gerado.';
}
