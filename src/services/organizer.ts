import { Config } from '../config';

export interface OrganizeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

// LiteLLM pricing estimates (gpt-4o-mini)
const PRICING = {
  input: 0.15 / 1_000_000,
  output: 0.60 / 1_000_000,
};

// Token budget for organization input (~4 chars/token heuristic)
const TOKEN_BUDGET = 60_000;
const MAX_INPUT_CHARS = TOKEN_BUDGET * 4; // 240_000 chars

function applyTokenBudget(
  transcript: string,
  extraContext: string | undefined,
): { transcript: string; extraContext: string } {
  let ctx = extraContext ?? '';
  let tx = transcript;

  const measure = () => tx.length + (ctx ? ctx.length + 20 : 0);
  if (measure() <= MAX_INPUT_CHARS) return { transcript: tx, extraContext: ctx };

  // Step 1: keep only top-1 related meeting from extraContext
  const parts = ctx.split('\n---\n');
  ctx = parts.length > 1 ? parts[0] : '';

  if (measure() <= MAX_INPUT_CHARS) return { transcript: tx, extraContext: ctx };

  // Step 2: truncate transcript keeping beginning + end (middle cut)
  // Meetings usually set context at the start and wrap up at the end
  const budget = MAX_INPUT_CHARS - (ctx ? ctx.length + 20 : 0);
  const lines = tx.split('\n');
  const marker = '\n[...trecho intermediario omitido por limite de contexto]\n';
  const halfBudget = Math.floor((budget - marker.length) / 2);

  // Keep first lines up to half budget
  const head: string[] = [];
  let headLen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (headLen + lines[i].length + 1 > halfBudget) break;
    head.push(lines[i]);
    headLen += lines[i].length + 1;
  }

  // Keep last lines up to other half budget
  const tail: string[] = [];
  let tailLen = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (tailLen + lines[i].length + 1 > halfBudget) break;
    tail.unshift(lines[i]);
    tailLen += lines[i].length + 1;
  }

  tx = head.join('\n') + marker + tail.join('\n');

  return { transcript: tx, extraContext: ctx };
}

function buildUrl(config: Config): string {
  let base = config.chatEndpoint;
  if (!base.endsWith('/')) base += '/';
  return `${base}chat/completions`;
}

function authHeader(config: Config): Record<string, string> {
  return { Authorization: `Bearer ${config.chatApiKey}` };
}

export interface UserNote {
  ts: number;   // segundos desde o início da reunião
  text: string;
}

export interface OrganizeOptions {
  meetingDate?: string;     // YYYY-MM-DD for date resolution
  participants?: string[];  // from calendar, helps speaker inference
  extraContext?: string;    // additional context (past meetings, etc.)
  userNotes?: UserNote[];   // anotações do usuário ao vivo — ESQUELETO da nota final
  series?: string;          // título do calendário/Teams — acha as notas irmãs da série
  themes?: Array<{ name: string; hint: string }>;  // vocabulário de meeting-temas.md
}

/**
 * Instrução compartilhada pelos dois engines: as anotações do usuário mandam na
 * estrutura da nota. É a única informação do pipeline que carrega intenção
 * humana explícita — ignorá-la produz uma nota genérica.
 */
export const USER_NOTES_INSTRUCTION =
  'ATENÇÃO — PRIORIDADE MÁXIMA: as anotações do usuário abaixo são o ESQUELETO da nota. '
  + 'Cada bullet dele define uma seção (ou um item de destaque) e a ORDEM DE PRIORIDADE da nota. '
  + 'Expanda CADA anotação com o que a transcrição diz sobre aquele ponto (contexto, quem falou, '
  + 'decisão, números, prazos) — os timestamps das anotações indicam o trecho da transcrição a usar. '
  + 'SÓ DEPOIS de cobrir todas elas, complete a nota com o que ele não anotou. '
  + 'Nada anotado pelo usuário pode ficar de fora ou virar nota de rodapé.';

export function formatUserNotes(notes: UserNote[]): string {
  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return notes.map(n => `- [${fmt(n.ts)}] ${n.text}`).join('\n');
}

/**
 * Remove preambulos meta que o claude headless pode prefixar a nota — blocos
 * "★ Insight ─── ... ───" herdados dos output styles do usuario, linhas
 * decorativas e cercas de codigo soltas. Sem isso, a primeira linha do bloco
 * vira o titulo do arquivo no vault.
 */
export function stripMetaPreamble(text: string): string {
  const lines = text.split('\n');
  const isRuler = (s: string) => /^[─—━_]{4,}/.test(s) || /^-{4,}$/.test(s);
  let i = 0;
  let unwrapped = false;
  for (;;) {
    while (i < lines.length && (lines[i].trim() === '' || /^```/.test(lines[i].trim()))) i++;
    if (i >= lines.length) break;
    const l = lines[i].trim();
    if (/^[★☆]/.test(l)) {
      i++;  // consome o bloco inteiro ate a regua de fechamento
      while (i < lines.length && !isRuler(lines[i].trim())) i++;
      if (i < lines.length) i++;
      continue;
    }
    if (isRuler(l)) { i++; continue; }
    // Linha-rotulo ecoada do contrato ("Título: X", "Título e nota:", "Título
    // e nota da reunião — primeira linha real abaixo."). Se o resto for curto
    // e nao for meta-comentario, e o titulo real com prefixo — desembrulha.
    // Senao, descarta a linha; o titulo real vem nas seguintes.
    const label = l.match(/^#{0,6}\s*t[íi]tulo\b[^:—–-]*[:—–-]\s*(.*)$/i);
    if (label) {
      const rest = label[1].trim();
      const isMeta = /primeira linha|abaixo|nota da reuni|vou gerar|segue (a )?nota/i.test(rest);
      if (rest && rest.length <= 80 && !isMeta) {
        lines[i] = rest;
        unwrapped = true;
        break;
      }
      i++; continue;
    }
    break;
  }
  // ATENCAO: `unwrapped` importa quando o rotulo esta na PRIMEIRA linha (i=0)
  // — sem ele, a reescrita era descartada e o rotulo vazava pro titulo.
  return i > 0 || unwrapped ? lines.slice(i).join('\n') : text;
}

export interface ParsedSummary {
  title: string;
  participants: string[];
  tags: string[];
  /** linha "Temas: ..." como veio — valide com resolveThemes antes de gravar */
  themes: string[];
  /** corpo da nota sem titulo/participantes/linha de tags */
  body: string;
}

/**
 * Interpreta a saida crua do organizador: Linha 1 = titulo, Linha 2 =
 * "Participantes: ...", ultima linha "Tags: ...". Compartilhado entre o
 * finalize sincrono (CLI interativo) e o worker `meeting organize-job`.
 */
/** Até onde procurar a linha "Participantes:" — o preâmbulo real nunca passa disso. */
const PREAMBLE_SCAN_LINES = 25;
/** Título de reunião é curto; frase longa é o agente falando consigo mesmo. */
const MAX_TITLE_CHARS = 140;
/** Começos típicos de comentário do agente que vazaram como título (casos reais do vault). */
const META_TITLE_RE = new RegExp([
  '^antes d[aeo]\\b.*\\bnota', '^confirm(ed|ei|ado)\\b', '^encontrei\\b', '^consulta [àa]s notas',
  '^contexto de reuni', '^no (pending|direct)\\b', '^this confirms', '^now i\\b',
  '^vou (gerar|montar|produzir)', '^segue (a )?nota', '^agora (vou|tenho)', '^[⚠★☆`>]',
].join('|'), 'i');
/** "Ana Souza, Bruno Lima" — a linha de participantes sem o rótulo. */
const NAME_LIST_RE = /^\p{Lu}[\p{L}'-]+(\s+(d[aeo]s?\s+)?\p{Lu}[\p{L}'-]+)+(\s*,\s*\p{Lu}[\p{L}'-]+(\s+(d[aeo]s?\s+)?\p{Lu}[\p{L}'-]+)+)+$/u;

/**
 * True when `line` can be a meeting title. Rejects agent chatter, long
 * sentences and labels. Exported for the vault title repair script.
 */
export function looksLikeTitle(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > MAX_TITLE_CHARS) return false;
  if (META_TITLE_RE.test(t) || NAME_LIST_RE.test(t)) return false;
  if (/[:.]$/.test(t)) return false;                 // frase/rótulo, não título
  if (/\b(a nota|nota final|nota da reuni|no vault)\b/i.test(t)) return false;
  return true;
}

/**
 * Corta o preâmbulo usando o próprio contrato da nota: a linha logo acima de
 * "Participantes:" é o título. Mais robusto que listar preâmbulos conhecidos —
 * o agente inventa um formato novo de comentário a cada tanto.
 */
function cutAtContract(lines: string[]): string[] {
  const limit = Math.min(lines.length, PREAMBLE_SCAN_LINES);
  for (let i = 1; i < limit; i++) {
    if (!/^participantes\s*:/i.test(lines[i].trim())) continue;
    let j = i - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    const candidate = lines[j]?.replace(/^#+\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1') ?? '';
    if (j >= 0 && looksLikeTitle(candidate)) return lines.slice(j);
    return lines.slice(i);  // sem título válido acima: começa em Participantes
  }
  return lines;
}

export function parseOrganizedSummary(raw: string): ParsedSummary {
  const lines = cutAtContract(stripMetaPreamble(raw).split('\n'));
  let title = '';
  let participants: string[] = [];
  const tags: string[] = [];

  if (lines.length >= 1) {
    // "## Seção" na primeira linha = o modelo pulou o título. A checagem era
    // feita DEPOIS de tirar os "#", então "## Resumo" virava o título.
    const isSection = /^\s*##/.test(lines[0]);
    const firstLine = lines[0].replace(/^#+\s*/, '').trim();
    // "Participantes:" na primeira linha = o modelo pulou o título; deixa a
    // linha para o parse de participantes abaixo em vez de virar título.
    if (firstLine && !isSection && !firstLine.startsWith('|') && !firstLine.startsWith('-')
        && !/^participantes\s*:/i.test(firstLine)) {
      // Linha que não passa no teste sai da nota, mas não vira título: o
      // chamador cai no título do calendário (melhor que frase do agente).
      const clean = firstLine.replace(/^\*\*(.+)\*\*$/, '$1').trim();  // "**Título**" → "Título"
      title = looksLikeTitle(clean) ? clean : '';
      lines.shift();
    }
  }
  if (lines.length >= 1) {
    const m = lines[0].match(/^Participantes:\s*(.+)/i);
    if (m) {
      participants = m[1].split(',').map(p => p.trim()).filter(p => p.length > 0);
      lines.shift();
    }
  }
  let body = lines.join('\n').replace(/^\n+/, '');
  const themes: string[] = [];
  const themeMatch = body.match(/^Temas:\s*(.*)$/mi);
  if (themeMatch) {
    for (const t of themeMatch[1].split(',')) if (t.trim() && !/^\(?nenhum/i.test(t.trim())) themes.push(t.trim());
    body = body.replace(/\n*^Temas:\s*.*$/mi, '').trim();
  }
  const tagMatch = body.match(/^Tags:\s*(.+)$/mi);
  if (tagMatch) {
    for (const t of tagMatch[1].split(',')) {
      const tag = t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (tag.length > 1 && tag.length < 30) tags.push(tag);
    }
    body = body.replace(/\n*Tags:\s*.+$/mi, '').trim();
  }
  return { title, participants, tags, themes, body };
}

/**
 * Engine dispatcher: routes to the Claude Code headless engine when configured,
 * falling back to the plain chat-completion organizer on any failure (claude
 * binary missing, timeout, error result) so a meeting note is never lost.
 */
export async function organize(
  transcript: string,
  config: Config,
  options?: OrganizeOptions,
): Promise<OrganizeResult & { engine: 'claude' | 'chat' | 'chat-fallback' }> {
  if (config.organizerEngine === 'claude') {
    try {
      const { organizeWithClaude } = await import('./claudeOrganizer');
      const result = await organizeWithClaude(transcript, config, options);
      return { ...result, engine: 'claude' };
    } catch (err) {
      console.error(`  [claude engine] ${(err as Error).message} — usando engine chat como fallback`);
      const result = await organizeTranscript(transcript, config, options);
      return { ...result, engine: 'chat-fallback' };
    }
  }
  const result = await organizeTranscript(transcript, config, options);
  return { ...result, engine: 'chat' };
}

export async function organizeTranscript(transcript: string, config: Config, options?: OrganizeOptions): Promise<OrganizeResult> {
  const url = buildUrl(config);

  // Build user message with metadata context
  let userContent = '';
  if (options?.meetingDate) {
    userContent += `Data da reuniao: ${options.meetingDate}\n`;
  }
  if (options?.participants && options.participants.length > 0) {
    userContent += `Participantes esperados (calendario): ${options.participants.join(', ')}\n`;
  }
  const { transcript: budgetedTranscript, extraContext: budgetedExtra } =
    applyTokenBudget(transcript, options?.extraContext);
  if (budgetedExtra) {
    userContent += `\nContexto adicional:\n${budgetedExtra}\n`;
  }
  if (options?.userNotes && options.userNotes.length > 0) {
    userContent += `\n# Anotações do usuário durante a reunião (ESQUELETO DA NOTA)\n`
      + `${USER_NOTES_INSTRUCTION}\n\n${formatUserNotes(options.userNotes)}\n`;
  }
  userContent += `\nTranscription:\n\n${budgetedTranscript}`;

  // max_completion_tokens (não max_tokens) e SEM temperature: os modelos
  // GPT-5.x do Azure rejeitam os parâmetros legados; os antigos aceitam ambos.
  const payload = {
    model: config.chatModel || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: config.organizationPrompt },
      { role: 'user', content: userContent },
    ],
    // GPT-5.x (reasoning) consome DESTE teto os tokens de raciocínio interno:
    // 4000 dava nota VAZIA em reunião longa (raciocínio comia tudo e o texto
    // visível vinha em branco). 16k dá folga pros dois.
    max_completion_tokens: 16000,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader(config), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Chat error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  const usage = data.usage;
  const costUsd =
    usage.prompt_tokens * PRICING.input +
    usage.completion_tokens * PRICING.output;

  return {
    text: data.choices[0].message.content,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    costUsd,
  };
}

export async function chatWithMeetings(
  messages: Array<{ role: string; content: string }>,
  config: Config
): Promise<string> {
  // Com o engine claude configurado, o claude é o motor PRIMÁRIO do caminho
  // rápido (haiku: segundos, funciona em qualquer rede) e o LiteLLM corporativo
  // vira fallback — inverso do desenho original, que prendia chat/insights à VPN.
  if (config.organizerEngine === 'claude') {
    try {
      return await chatViaClaude(messages, config);
    } catch (err) {
      try {
        return await chatViaLiteLLM(messages, config);
      } catch {
        throw err;  // erro do claude é o mais relevante nesse arranjo
      }
    }
  }
  try {
    return await chatViaLiteLLM(messages, config);
  } catch (err) {
    throw err;
  }
}

function chatViaClaude(
  messages: Array<{ role: string; content: string }>,
  config: Config
): Promise<string> {
  const { spawn } = require('child_process') as typeof import('child_process');
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const convo = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`)
    .join('\n\n');
  const prompt = `${system}\n\n${convo}\n\nResponda a última mensagem do usuário diretamente, sem preâmbulo.`;

  return new Promise<string>((resolve, reject) => {
    const { resolveClaudeBin } = require('./claudeBin') as typeof import('./claudeBin');
    const proc = spawn(resolveClaudeBin(), [
      '-p', '--output-format', 'json',
      // Caminho rápido: haiku responde em segundos — sonnet fica pros passes profundos
      '--model', config.claudeModelQuick || 'claude-haiku-4-5-20251001',
      '--max-turns', '1',
      '--disallowedTools', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '';
    const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} ; reject(new Error('claude chat timeout')); }, 90_000);
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude chat exit ${code}`));
      try {
        const data = JSON.parse(out);
        if (data.is_error || !data.result) return reject(new Error('claude chat sem resultado'));
        resolve(String(data.result).trim());
      } catch (e) { reject(e as Error); }
    });
    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

async function chatViaLiteLLM(
  messages: Array<{ role: string; content: string }>,
  config: Config
): Promise<string> {
  const url = buildUrl(config);

  const payload = {
    model: config.chatModel || 'gpt-4o-mini',
    messages,
    max_completion_tokens: 2000,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader(config), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Chat error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}
