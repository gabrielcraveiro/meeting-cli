import fs from 'fs';
import path from 'path';
import { Config } from '../config';

// Glossário de correções de transcrição, mantido pelo usuário DENTRO do vault
// (editável no Obsidian, sem UI extra). Cada linha `- errado -> certo` vira uma
// substituição case-insensitive aplicada a toda legenda/transcrição que chegar.
// Ex.: "light llm -> LiteLLM" conserta o erro clássico do reconhecimento de voz
// com nomes de produto.

const FILE_NAME = 'meeting-glossario.md';

const TEMPLATE = `# Glossário do meeting-cli

Termos que a transcrição costuma errar. Formato: \`- errado -> certo\`, um por
linha, sem diferenciar maiúsculas. Vale para as legendas do Teams e para o
Deepgram — a correção é aplicada na hora, em tudo que chega.

- light llm -> LiteLLM
- lite llm -> LiteLLM
`;

interface CacheEntry {
  mtimeMs: number;
  rules: Array<{ re: RegExp; to: string }>;
  corrections: Array<{ from: string; to: string }>;
}

let cache: CacheEntry | null = null;

function glossaryFile(config: Config): string {
  return path.join(config.vaultPath, FILE_NAME);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lê (e cacheia por mtime) o glossário do vault. Cria o arquivo com um template
 * na primeira vez — assim o usuário descobre o formato abrindo o Obsidian.
 */
export function loadGlossary(config: Config): Array<{ from: string; to: string }> {
  const file = glossaryFile(config);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    try { fs.writeFileSync(file, TEMPLATE, 'utf-8'); } catch { /* vault indisponível */ }
    cache = null;
    return parseAndCache(TEMPLATE, 0).corrections;
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.corrections;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  return parseAndCache(raw, stat.mtimeMs).corrections;
}

function parseAndCache(raw: string, mtimeMs: number): CacheEntry {
  const corrections: Array<{ from: string; to: string }> = [];
  const rules: Array<{ re: RegExp; to: string }> = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*[-*]\s*(.+?)\s*(?:->|=>|→)\s*(.+?)\s*$/);
    if (!m) continue;
    const from = m[1].replace(/^`|`$/g, '').trim();
    const to = m[2].replace(/^`|`$/g, '').trim();
    if (!from || !to || from === to) continue;  // "litellm -> LiteLLM" (só caixa) vale
    corrections.push({ from, to });
    // Fronteira unicode-aware: \b falha com acentos ("versão"), lookaround não.
    try {
      rules.push({
        re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(from)}(?![\\p{L}\\p{N}])`, 'giu'),
        to,
      });
    } catch { /* termo com sintaxe impossível — ignora a regra, mantém no prompt */ }
  }
  cache = { mtimeMs, rules, corrections };
  return cache;
}

/** Aplica todas as correções do glossário a um texto (legendas ou Deepgram). */
export function applyGlossary(text: string, config: Config): string {
  if (!text) return text;
  loadGlossary(config);
  if (!cache || cache.rules.length === 0) return text;
  let out = text;
  for (const { re, to } of cache.rules) out = out.replace(re, to);
  return out;
}

/**
 * Adiciona (ou atualiza) uma correção — usado pelo endpoint /glossary do daemon
 * quando o usuário seleciona um termo errado no app. Se o termo já existe,
 * a linha é atualizada em vez de duplicada.
 */
export function addGlossaryEntry(config: Config, from: string, to: string): void {
  const clean = (s: string) => s.replace(/[\r\n`|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const f = clean(from);
  const t = clean(to);
  if (!f || !t) throw new Error('informe o termo errado e a forma correta');
  if (f === t) throw new Error('os dois termos são iguais');

  const file = glossaryFile(config);
  if (!fs.existsSync(file)) fs.writeFileSync(file, TEMPLATE, 'utf-8');

  const raw = fs.readFileSync(file, 'utf-8');
  const lineRe = /^\s*[-*]\s*(.+?)\s*(?:->|=>|→)\s*(.+?)\s*$/;
  let replaced = false;
  const updated = raw.split('\n').map(line => {
    const m = line.match(lineRe);
    if (m && m[1].replace(/^`|`$/g, '').trim().toLowerCase() === f.toLowerCase()) {
      replaced = true;
      return `- ${f} -> ${t}`;
    }
    return line;
  }).join('\n');

  if (replaced) {
    fs.writeFileSync(file, updated, 'utf-8');
  } else {
    fs.writeFileSync(file, raw.replace(/\n*$/, '\n') + `- ${f} -> ${t}\n`, 'utf-8');
  }
  cache = null;  // força reload no próximo applyGlossary
}

/**
 * Bloco de contexto pro organizador: as grafias CORRETAS. Cobre variantes que a
 * substituição literal não pegou ("laitelem") — a IA normaliza pelo glossário.
 */
export function glossaryPromptBlock(config: Config): string | null {
  const entries = loadGlossary(config);
  if (entries.length === 0) return null;
  const seen = new Set<string>();
  const terms = entries.map(e => e.to).filter(t => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  return '# Glossário de termos (grafias corretas)\n'
    + 'A transcrição pode conter variantes erradas destes termos — use SEMPRE a grafia correta na nota:\n'
    + terms.map(t => `- ${t}`).join('\n');
}
