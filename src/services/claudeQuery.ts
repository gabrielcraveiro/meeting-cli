import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { Config } from '../config';
import { resolveClaudeBin, claudeSpawnEnv } from './claudeBin';

// Pergunta agêntica ao vault — mesmo motor headless do claudeOrganizer:
// spawn `claude` em print mode com tools read-only (Read/Grep/Glob) e cwd no
// vault, prompt via stdin, resposta em JSON (traz total_cost_usd).
// Diferença: aqui o objetivo é PESQUISA, não geração de nota — a resposta é
// curta, em PT-BR, e termina com uma linha FONTES que resolvemos para paths reais.

const TIMEOUT_MS = 3 * 60 * 1000;
const SOURCE_DIRS = ['Meetings', 'Briefings', 'References', 'Pessoas', 'Temas'];

export interface VaultAnswer {
  answer: string;
  sources: Array<{ file: string; title: string }>;
  costUsd: number;
}

/** Lista de notas mais recentes pré-injetada no prompt — economiza os turnos
 *  de Glob/descoberta do modelo (custo por pergunta cai substancialmente). */
function recentNoteNames(config: Config, limit = 40): string[] {
  const out: string[] = [];
  for (const dir of SOURCE_DIRS) {
    const full = path.join(config.vaultPath, dir);
    try {
      for (const f of fs.readdirSync(full)) {
        if (f.endsWith('.md')) out.push(`${dir}/${f}`);
      }
    } catch {}
  }
  // Nomes começam com YYYY-MM-DD — ordenação lexicográfica desc = mais recentes primeiro
  return out.sort((a, b) => b.localeCompare(a)).slice(0, limit);
}

const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 8000;

/** Formata os últimos turnos (Usuário:/Assistente:) truncando por turnos e por chars. */
function formatHistory(history: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  let block = recent.map(h => `${h.role === 'user' ? 'Usuário' : 'Assistente'}: ${h.content}`).join('\n\n');
  if (block.length > MAX_HISTORY_CHARS) block = block.slice(-MAX_HISTORY_CHARS);
  return block;
}

export async function askVault(
  question: string,
  config: Config,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<VaultAnswer> {
  const noteList = recentNoteNames(config);
  const hasHistory = !!history && history.length > 0;
  const historyBlock = hasHistory
    ? `\n# Conversa anterior\n${formatHistory(history!)}\n`
    : '';
  const prompt =
    `Você é o pesquisador do vault de reuniões do usuário (Obsidian). Seu trabalho é responder ` +
    `perguntas sobre o histórico de reuniões usando SOMENTE o que está escrito nas notas.\n\n` +
    `<vault>\n` +
    `Você já está no diretório do vault: ${config.vaultPath}\n` +
    `- Meetings/*.md — uma nota por reunião (frontmatter com title, date, participants, tags)\n` +
    `- Briefings/*.md — briefings diários\n` +
    `Use Grep para achar termos e Read para ler as notas relevantes (Glob só se precisar de algo fora da lista abaixo).\n` +
    `As ${noteList.length} notas mais recentes (nome do arquivo já carrega data e título):\n` +
    noteList.map(n => `- ${n}`).join('\n') + '\n' +
    `</vault>\n\n` +
    `<regras>\n` +
    `1. Responda em PT-BR, direto ao ponto (no máximo ~15 linhas), citando datas e títulos das ` +
    `reuniões de onde tirou cada informação.\n` +
    `2. NUNCA invente: se o vault não tem a informação, diga que não encontrou.\n` +
    `3. Sua ÚLTIMA linha deve ser EXATAMENTE no formato abaixo, listando só as notas que você ` +
    `realmente leu e usou (nome do arquivo sem .md, separados por " | "):\n` +
    `FONTES: [[nome-da-nota-1]] | [[nome-da-nota-2]]\n` +
    `Se não usou nenhuma nota, escreva: FONTES:\n` +
    `4. Sem preâmbulo ("vou pesquisar..."), sem cercas de código em volta da resposta.\n` +
    `</regras>\n` +
    historyBlock +
    `\n<pergunta>\n${question}\n</pergunta>\n`;

  // Sempre o modelo rápido: /ask é chat interativo — sonnet agêntico levava
  // ~40-55s por resposta, que na prática lê como "não respondeu". Haiku faz a
  // mesma pesquisa (Grep/Read) numa fração do tempo; a lista de notas recentes
  // pré-injetada já poupa os turnos de descoberta.
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', config.claudeModelQuick || 'claude-haiku-4-5-20251001',
    '--max-turns', '12',
    // Sem settings do usuário: output styles globais poluíam as respostas
    // (blocos ★ Insight etc.) — mesmo isolamento do claudeOrganizer.
    '--setting-sources', 'project',
    '--allowedTools', 'Read', 'Grep', 'Glob',
  ];

  const raw = await runClaude(args, prompt, config.vaultPath);

  let data: {
    result?: string;
    is_error?: boolean;
    total_cost_usd?: number;
  };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('resposta do claude não é JSON válido');
  }

  if (data.is_error || !data.result?.trim()) {
    throw new Error(`claude retornou erro ou resposta vazia: ${(data.result || '').slice(0, 200)}`);
  }

  const text = data.result.trim().replace(/^```(?:markdown)?\n([\s\S]*)\n```$/m, '$1').trim();
  const { answer, names } = splitSources(text);

  return {
    answer,
    sources: resolveSources(names, config),
    costUsd: data.total_cost_usd ?? 0,
  };
}

/** Separa a linha `FONTES: ...` do corpo; fallback = wikilinks no corpo. */
export function splitSources(text: string): { answer: string; names: string[] } {
  const lines = text.split('\n');
  let names: string[] = [];
  let answer = text;

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*(?:\*\*)?FONTES(?:\*\*)?\s*:\s*(.*)$/i);
    if (!m) continue;
    names = extractNames(m[1]);
    lines.splice(i, 1);
    answer = lines.join('\n').trim();
    break;
  }

  if (names.length === 0) names = extractNames(answer);  // fallback: wikilinks no corpo
  return { answer, names: [...new Set(names)] };
}

function extractNames(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const name = m[1].trim();
    if (name) out.push(name);
  }
  if (out.length === 0) {
    // aceita "FONTES: nota-a | nota-b" sem wikilink
    for (const part of s.split('|')) {
      const name = part.trim().replace(/\.md$/i, '');
      if (name && !/^(nenhuma?|n\/a|-)$/i.test(name)) out.push(name);
    }
  }
  return out;
}

/** Casa cada nome (basename sem .md, case-insensitive) com um arquivo real do vault. */
export function resolveSources(names: string[], config: Config): Array<{ file: string; title: string }> {
  if (names.length === 0) return [];

  const byKey = new Map<string, { file: string; title: string }>();
  for (const dir of SOURCE_DIRS) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(config.vaultPath, dir)).filter(f => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const base = f.replace(/\.md$/i, '');
      const entry = { file: `${dir}/${f}`, title: base };
      if (!byKey.has(base.toLowerCase())) byKey.set(base.toLowerCase(), entry);
    }
  }

  const out: Array<{ file: string; title: string }> = [];
  for (const name of names) {
    const key = name.replace(/^.*\//, '').replace(/\.md$/i, '').trim().toLowerCase();
    const hit = byKey.get(key);
    if (hit && !out.some(o => o.file === hit.file)) out.push(hit);
  }
  return out;
}

function runClaude(args: string[], prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveClaudeBin(), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: claudeSpawnEnv() });

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
        ? new Error('binário `claude` não encontrado no PATH — instale o Claude Code CLI')
        : err);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude saiu com código ${code}: ${stderr.slice(0, 300)}`));
      }
      resolve(stdout);
    });

    proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
