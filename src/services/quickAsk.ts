import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../config';
import { refreshIfStale, search } from './vaultIndex';
import { splitSources, resolveSources, type VaultAnswer } from './claudeQuery';

// Modo RÁPIDO do /ask — RAG clássico em vez de agente: o daemon busca as notas
// relevantes no índice local (vaultIndex, ~ms), injeta o conteúdo no prompt e
// faz UMA chamada ao endpoint de chat (LiteLLM/Azure — o "luna" do config).
// Alvo: ~5-10s por resposta, contra ~40s do modo profundo (claude agêntico),
// que continua disponível via mode:'deep' para perguntas que exigem pesquisa
// iterativa de verdade.

const TIMEOUT_MS = 60_000;
const TOP_NOTES = 6;
/** Orçamento por nota: a parte organizada vem primeiro no arquivo, então o
 * corte no teto preserva resumo/decisões e sacrifica o fim da transcrição. */
const NOTE_CHAR_BUDGET = 7000;

function loadNotes(config: Config, question: string): Array<{ file: string; title: string; body: string }> {
  refreshIfStale(config);
  const hits = search(question, TOP_NOTES);
  const out: Array<{ file: string; title: string; body: string }> = [];
  for (const h of hits) {
    try {
      const raw = fs.readFileSync(path.join(config.vaultPath, h.file), 'utf-8');
      const body = raw.length > NOTE_CHAR_BUDGET
        ? `${raw.slice(0, NOTE_CHAR_BUDGET)}\n[... nota truncada ...]`
        : raw;
      out.push({ file: h.file, title: h.title, body });
    } catch {}
  }
  return out;
}

export async function askVaultFast(
  question: string,
  config: Config,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<VaultAnswer> {
  const notes = loadNotes(config, question);

  const context = notes.length > 0
    ? notes
        .map(n => `<nota arquivo="${n.file.replace(/\.md$/i, '')}">\n${n.body}\n</nota>`)
        .join('\n\n')
    : '(a busca não encontrou notas relevantes para esta pergunta)';

  const system =
    `Você é o pesquisador do vault de reuniões do usuário (Obsidian). Responda usando SOMENTE ` +
    `o conteúdo das notas fornecidas abaixo.\n\n` +
    `Regras:\n` +
    `1. PT-BR, direto ao ponto (máximo ~15 linhas), citando datas e títulos das reuniões de onde ` +
    `tirou cada informação.\n` +
    `2. NUNCA invente: se as notas não têm a informação, diga que não encontrou e sugira ` +
    `reformular (ou usar o modo profundo).\n` +
    `3. Sua ÚLTIMA linha deve ser EXATAMENTE:\n` +
    `FONTES: [[nome-do-arquivo-1]] | [[nome-do-arquivo-2]]\n` +
    `listando só as notas que você realmente usou (valor de arquivo= das tags <nota>). ` +
    `Se não usou nenhuma: FONTES:\n` +
    `4. Sem preâmbulo, sem cercas de código.\n\n` +
    `# Notas do vault\n${context}`;

  const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: system }];
  for (const h of history ?? []) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: question });

  let base = config.chatEndpoint;
  if (!base.endsWith('/')) base += '/';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.chatApiKey}` },
      body: JSON.stringify({ model: config.chatModel, messages }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(ctrl.signal.aborted
      ? `modo rápido excedeu ${TIMEOUT_MS / 1000}s`
      : `modo rápido: falha ao chamar ${config.chatModel} — ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`modo rápido: ${config.chatModel} retornou ${response.status} — ${detail}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('modo rápido: resposta vazia do modelo');

  const { answer, names } = splitSources(text);
  return { answer, sources: resolveSources(names, config), costUsd: 0 };
}
