import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { Config } from '../config';
import type { OrganizeResult, OrganizeOptions } from './organizer';
import { resolveClaudeBin, claudeSpawnEnv } from './claudeBin';

// Claude Code headless engine — same style as the poc-automvp runner:
// spawn the `claude` binary in print mode, prompt via stdin, parse the JSON
// result (which carries total_cost_usd and token usage).
//
// Unlike the plain chat-completion organizer, this engine gets READ-ONLY tools
// (Read/Grep/Glob) over the Obsidian vault, so it can research past meetings,
// fix ASR errors on proper names/jargon using real context, and link decisions
// across meetings. The transcript goes via temp file, not prompt — long
// meetings don't blow the context window, Claude reads what it needs.

// Reunião de ~1h + pesquisa agêntica no vault estoura 6 min com folga — o
// timeout curto jogava a nota no fallback chat sem necessidade.
const TIMEOUT_MS = 12 * 60 * 1000;

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

  // Anotações ao vivo do usuário: viram arquivo próprio para não competirem com o
  // resto do contexto — o workflow abaixo as promove a esqueleto da nota.
  let notesPath: string | null = null;
  if (options?.userNotes?.length) {
    const { USER_NOTES_INSTRUCTION, formatUserNotes } = await import('./organizer');
    notesPath = path.join(tmpDir, 'anotacoes.md');
    fs.writeFileSync(
      notesPath,
      `# Anotações do usuário durante a reunião\n\n`
      + `${USER_NOTES_INSTRUCTION}\n\n`
      + `${formatUserNotes(options.userNotes)}\n`,
    );
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
    `0a. PRIVACIDADE — conteúdo pessoal sensível NÃO entra na nota: saúde, família, ` +
    `relacionamentos, finanças pessoais, desabafos íntimos ou qualquer assunto privado ` +
    `sem relação com o trabalho. Se um trecho assim for relevante ao contexto, registre ` +
    `no máximo "conversa pessoal (não registrada)" — sem detalhes. Assuntos de trabalho ` +
    `sensíveis (desligamentos, remuneração, avaliação) SÃO registráveis, com sobriedade.\n` +
    `0b. CONCISÃO — o leitor é humano e lê pouco. Tetos RÍGIDOS mesmo em reunião de 1h: ` +
    `Resumo em 2-4 frases; no máximo ~5 seções e ~20 bullets NO TOTAL da nota (1 linha cada); ` +
    `priorize os itens que mudam decisão/ação — detalhe mora na transcrição logo abaixo. ` +
    `Corte redundância entre seções (o que está no Resumo não volta nos Pontos). ` +
    `Nota longa não é nota completa — é nota não lida.\n` +
    `0c. A PRIMEIRA LINHA é o título EM SI (ex.: "Consulta de NF — Rate Limiting"). ` +
    `JAMAIS escreva a palavra "Título", "Título:" ou qualquer rótulo/explicação nela.\n` +
    `0. FORMATO ADAPTATIVO — calibre a nota ao teor da conversa:\n` +
    `   • Conversa curta/informal/1:1 sem pauta de projeto (papo pessoal, logística, follow-up ` +
    `rápido): nota COMPACTA — título + Participantes + ## Resumo (2-3 frases) e, se houver, ` +
    `## Pontos Principais. SEM tabela de action items, sem seções vazias, sem decisões forçadas ` +
    `(action item só se alguém assumiu algo concreto — aí vale uma linha \`- [ ]\` simples).\n` +
    `   • Transcrição trivial (segundos de fala, despedida, teste): só título + ## Resumo de 1 linha.\n` +
    `   • Daily/alinhamento multi-pessoa (participantes reportando status, mesmo que evolua ` +
    `pra discussão longa): seções "### Nome" com **Ontem/Hoje/Blockers** (1 linha cada), depois ` +
    `## Resumo (2-3 frases), ## Blockers Ativos (consolidado — riscos entram AQUI, sem seção ` +
    `separada), ## Timeline (marcos [MM:SS] da discussão, MÁXIMO 10, só viradas de assunto e ` +
    `decisões) e Action Items. Essa timeline navegável é o mapa da reunião longa.\n` +
    `   • Reunião de trabalho estruturada: contrato completo definido acima.\n` +
    `1. Leia a transcrição completa em: ${transcriptPath}\n` +
    (contextPath ? `2. Leia o contexto pré-carregado em: ${contextPath}\n` : '') +
    (notesPath
      ? `2b. ⚠️ LEIA PRIMEIRO E OBEDEÇA: as anotações que o usuário fez AO VIVO durante a reunião estão em: ${notesPath}\n` +
        `   Elas são o ESQUELETO da nota — cada bullet dele define uma seção/item e a ordem de prioridade. ` +
        `Expanda CADA anotação com o que a transcrição diz sobre aquele ponto (use o timestamp da anotação ` +
        `para achar o trecho). SÓ DEPOIS de cobrir todas complete a nota com o que ele não anotou. ` +
        `Nenhuma anotação pode ficar de fora.\n`
      : '') +
    `3. O vault Obsidian do usuário está em: ${config.vaultPath} — use Grep/Glob/Read para ` +
    `pesquisar reuniões anteriores relacionadas (mesmos participantes, mesmo projeto, mesmos temas).\n` +
    `4. Use o que encontrar para: corrigir erros de transcrição em nomes próprios, siglas e jargões ` +
    `(o ASR erra termos como nomes de sistemas internos — o vault tem a grafia correta); inferir ` +
    `identidades dos speakers; conectar decisões e action items com reuniões passadas.\n` +
    `4b. FECHAMENTO DE PENDÊNCIAS (ciclo Granola): use Grep para achar action items ABERTOS no vault ` +
    `(linhas \`- [ ]\` com #meeting/action). Se a transcrição DESTA reunião evidenciar que um deles foi ` +
    `CONCLUÍDO (alguém relata que fez: "já subiu", "assinado", "enviado", "resolvido"), você NÃO edita ` +
    `nada — apenas PROPONHA o fechamento no fim da sua resposta, depois de tudo, num bloco exatamente assim:\n` +
    `<!--meeting-cli:fechar\n` +
    `caminho/relativo/da/nota.md :: - [ ] linha exata do item como está no arquivo #meeting/action\n` +
    `-->\n` +
    `   • Uma proposta por linha; a linha do item deve ser cópia EXATA do arquivo (confirme com Read).\n` +
    `   • O sistema valida e aplica o flip — propostas que não baterem são descartadas.\n` +
    `   • Na dúvida ("quase pronto", "vou fazer", menção vaga) NÃO proponha.\n` +
    `   • Cada item proposto deve aparecer também na nota, numa subseção ` +
    `"### Pendências fechadas nesta reunião" com o wikilink da nota de origem — se nenhuma, omita tudo ` +
    `(subseção e bloco).\n` +
    `4c. CONEXÕES OBSIDIAN (grafo do vault): quando o corpo da nota mencionar uma reunião, projeto ou ` +
    `tema que TEM nota no vault, cite com wikilink inline: [[nome exato do arquivo sem .md]]. ` +
    `Ao final da nota (antes das tags), adicione a seção:\n` +
    `   ## Relacionadas\n` +
    `   - [[nome exato do arquivo]] — meia linha explicando a relação\n` +
    `   Regras: 2 a 5 notas genuinamente relacionadas (continuação de pauta, mesmo projeto, decisão ` +
    `anterior sobre o mesmo tema); use o nome EXATO do arquivo confirmado via Glob/Grep (nomes têm ` +
    `espaços, datas e acentos); NUNCA linke arquivo que você não confirmou existir — link quebrado é ` +
    `pior que link nenhum. Se nada for genuinamente relacionado, omita a seção.\n` +
    `5. ACTION ITEMS SÃO RAROS E CAROS — critério duro (aprendido no uso: dezenas de tasks ` +
    `geradas viram lista morta que ninguém revê):\n` +
    `   • Só vira task o que alguém ASSUMIU explicitamente em voz ("eu faço", "pode deixar comigo", ` +
    `"vou mandar até sexta") — com dono claro e entregável concreto.\n` +
    `   • "Precisamos de X", "seria bom ver Y", ideia solta, tema pra próxima reunião: NÃO é task ` +
    `— vai para Pontos Principais ou fica de fora.\n` +
    `   • POSSE: o vault é do usuário — ação de TERCEIRO só vira task se envolver o usuário ` +
    `diretamente (ele pediu e a pessoa aceitou, ou a entrega é PARA ele). Combinado de terceiros ` +
    `entre si ("Fulano vai ajudar Ciclano") NÃO é task dele — registre como Ponto, se relevante.\n` +
    `   • MÁXIMO 5 tasks por reunião; se mais de 5 candidatas, escolha as 5 com dono+prazo mais ` +
    `claros. Na dúvida, corte.\n` +
    `   Na seção de action items, além da tabela, emita cada ação também no formato ` +
    `**Obsidian Tasks** (uma linha por ação, no fim da seção):\n` +
    `   - [ ] <descrição> 📅 YYYY-MM-DD #meeting/action\n` +
    `   • O 📅 YYYY-MM-DD SÓ entra quando um prazo foi mencionado na conversa ou é claramente ` +
    `inferível dela (converta "amanhã", "até sexta", "semana que vem" usando a data da reunião). ` +
    `Sem prazo → omita o 📅 inteiro, não invente data.\n` +
    `   • Responsável diferente do usuário que gravou → prefixe a descrição com **Nome:** ` +
    `(ex: \`- [ ] **Ana:** revisar contrato 📅 2026-08-07 #meeting/action\`). Se a ação é do próprio ` +
    `usuário, sem prefixo.\n` +
    `   • A tag #meeting/action é obrigatória em toda linha — é o que alimenta o dashboard Tasks.md do vault.\n` +
    `6. Sua ÚLTIMA mensagem deve conter APENAS a nota final no formato do contrato acima — ` +
    `sem preâmbulo, sem explicações, sem cercas de código em volta.\n` +
    `</workflow>\n\n` +
    (meta.length > 0 ? `<metadados>\n${meta.join('\n')}\n</metadados>\n` : '');

  const args = [
    '-p',
    '--output-format', 'json',
    '--model', config.claudeModel || 'claude-sonnet-5',
    '--max-turns', '25',
    // Sem settings do usuário: output styles globais (ex.: "Explanatory" com
    // blocos ★ Insight) vazavam pra dentro da nota e bagunçavam o título.
    '--setting-sources', 'project',
    // SEM Edit de propósito: a transcrição é entrada não confiável (prompt
    // injection por voz). Fechamentos de pendência saem como PROPOSTA no bloco
    // meeting-cli:fechar e são validados/aplicados por taskCloser.ts.
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
