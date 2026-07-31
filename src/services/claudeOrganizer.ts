import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { Config } from '../config';
import type { OrganizeResult, OrganizeOptions } from './organizer';

// Claude Code headless engine — same style as the poc-automvp runner:
// spawn the `claude` binary in print mode, prompt via stdin, parse the JSON
// result (which carries total_cost_usd and token usage).
//
// Unlike the plain chat-completion organizer, this engine gets READ-ONLY tools
// (Read/Grep/Glob) over the Obsidian vault, so it can research past meetings,
// fix ASR errors on proper names/jargon using real context, and link decisions
// across meetings. The transcript goes via temp file, not prompt — long
// meetings don't blow the context window, Claude reads what it needs.

const TIMEOUT_MS = 6 * 60 * 1000;

export async function organizeWithClaude(
  transcript: string,
  config: Config,
  options?: OrganizeOptions,
): Promise<OrganizeResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-organize-'));
  const transcriptPath = path.join(tmpDir, 'transcricao.txt');
  fs.writeFileSync(transcriptPath, transcript);

  let contextPath: string | null = null;
  if (options?.extraContext) {
    contextPath = path.join(tmpDir, 'contexto.md');
    fs.writeFileSync(contextPath, options.extraContext);
  }

  const meta: string[] = [];
  if (options?.meetingDate) meta.push(`Data da reunião: ${options.meetingDate}`);
  if (options?.participants?.length) {
    meta.push(`Participantes na call (roster real, inclui quem só ouviu): ${options.participants.join(', ')}`);
  }

  const prompt =
    `${config.organizationPrompt}\n\n` +
    `<workflow>\n` +
    `Você está em modo agente com ferramentas read-only. Siga esta ordem:\n` +
    `1. Leia a transcrição completa em: ${transcriptPath}\n` +
    (contextPath ? `2. Leia o contexto pré-carregado em: ${contextPath}\n` : '') +
    `3. O vault Obsidian do usuário está em: ${config.vaultPath} — use Grep/Glob/Read para ` +
    `pesquisar reuniões anteriores relacionadas (mesmos participantes, mesmo projeto, mesmos temas).\n` +
    `4. Use o que encontrar para: corrigir erros de transcrição em nomes próprios, siglas e jargões ` +
    `(o ASR erra termos como nomes de sistemas internos — o vault tem a grafia correta); inferir ` +
    `identidades dos speakers; conectar decisões e action items com reuniões passadas.\n` +
    `5. Sua ÚLTIMA mensagem deve conter APENAS a nota final no formato do contrato acima — ` +
    `sem preâmbulo, sem explicações, sem cercas de código em volta.\n` +
    `</workflow>\n\n` +
    (meta.length > 0 ? `<metadados>\n${meta.join('\n')}\n</metadados>\n` : '');

  const args = [
    '-p',
    '--output-format', 'json',
    '--model', config.claudeModel || 'claude-sonnet-5',
    '--max-turns', '25',
    '--allowedTools', 'Read', 'Grep', 'Glob',
    '--add-dir', tmpDir,
  ];

  try {
    const raw = await runClaude(args, prompt, config.vaultPath);
    const data = JSON.parse(raw) as {
      result?: string;
      is_error?: boolean;
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    if (data.is_error || !data.result?.trim()) {
      throw new Error(`claude retornou erro ou resultado vazio: ${(data.result || '').slice(0, 200)}`);
    }

    // Strip an accidental code fence around the note, if any
    const text = data.result.trim().replace(/^```(?:markdown)?\n([\s\S]*)\n```$/m, '$1');

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    return {
      text,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: data.total_cost_usd ?? 0,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function runClaude(args: string[], prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // cwd = vault, so Grep/Glob default to the notes tree
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
