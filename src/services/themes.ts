import fs from 'fs';
import path from 'path';
import type { Config } from '../config';

// Vocabulário FECHADO de temas, mantido pelo usuário dentro do vault (editável
// no Obsidian, como o glossário). O organizador classifica cada reunião
// escolhendo desta lista — e só dela. Casar palavras do título não funcionava:
// o Pix tinha 21 notas com 8 títulos diferentes e nada ligava umas às outras,
// enquanto "Mudanças" casava o comitê de RDMs com o benefício de academia.

const FILE_NAME = 'meeting-temas.md';

/** Teto de temas por reunião: uma reunião que "é de tudo" não é de nada. */
export const MAX_THEMES_PER_NOTE = 2;

const TEMPLATE = `# Temas do meeting-cli

Cada reunião recebe até ${MAX_THEMES_PER_NOTE} temas desta lista (campo \`temas:\` da nota) e
alimenta o hub \`Temas/<Tema>.md\`. Formato: \`- Nome: o que entra\`. A descrição
ajuda a IA a decidir; o nome é o que aparece na nota. Reunião que não se
encaixa fica sem tema — melhor que tema errado.

Temas de pessoas (desligamento, avaliação, headcount) ficam de fora de
propósito: um hub juntaria tudo numa página só. Isso mora em Pessoas/.

- Pix: Pix no App, pagamento e conciliação Pix, Transfeera, Celcoin, saldo, antifraude transacional
- Cashback: portal e protótipos de Cashback, vales, programas de benefício via Cashback
- Autorizador: Autorizador 1.0/2.0, WS Autorizador, incidentes e performance, squad Cônia, RD/DPSP
- Conciliação e NSU: reabertura de NSU e de autorizações, MVP de conciliação
- Elegibilidade e Checkout PDV: API Sale, chicote, InterPlayers, elegibilidade de plano no PDV
- Bots e Mensageria: bots, WhatsApp, Meta, Blip, webhooks
- Memed: integração Memed, pré-cadastro, PSP vs PBM
- iFood e 99: PBM no iFood e no 99 Compras, KT para o time da China
- Reposição: reposição gerenciada, worker Python da reposição
- Arquitetura e Padrões: processo de arquitetura de soluções, Backstage, Upstream, Auto MVP, chassi, gitflow, CI/CD
- Infra e Custos: tenant/AKS, clusters, FinOps, Oracle, DR, APIs críticas
- Segurança e Compliance: auditoria SOC, vulnerabilidades, Keycloak, plano de contingência
- Observabilidade: DataDog, Grafana, telemetria, alertas para o NOC
- QA e Testes: guilda de QA, estratégia de testes, automação de testes
- IA na Engenharia: Claude Code, AI Factory, plataforma de agentes
- Planejamento 2027: missões inegociáveis, OKR, jogadas e orçamento de 2027
- Jira e Métricas Ágeis: Time Tracker, story points, sprint planning, reports do Jira
`;

export interface Theme {
  name: string;
  /** o que entra no tema — só orienta a classificação */
  hint: string;
}

let cache: { mtimeMs: number; themes: Theme[] } | null = null;

function parse(raw: string): Theme[] {
  const out: Theme[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*[-*]\s*([^:]+?)\s*:\s*(.*)$/);
    if (m && m[1].trim()) out.push({ name: m[1].trim(), hint: m[2].trim() });
  }
  return out;
}

/**
 * Read the theme vocabulary from the vault.
 *
 * Contract: returns the themes of `meeting-temas.md`, cached by mtime. On the
 * first call, creates the file with the default list. Returns [] if the vault
 * is not readable.
 */
export function loadThemes(config: Config): Theme[] {
  const file = path.join(config.vaultPath, FILE_NAME);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    try { fs.writeFileSync(file, TEMPLATE, 'utf-8'); } catch { return []; }
    return parse(TEMPLATE);
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.themes;
  try {
    cache = { mtimeMs: stat.mtimeMs, themes: parse(fs.readFileSync(file, 'utf-8')) };
  } catch {
    return [];
  }
  return cache.themes;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Keep only names that exist in the vocabulary, with the vocabulary spelling.
 *
 * @example
 * resolveThemes(['pix', 'Inventado'], themes) // → ['Pix']
 */
export function resolveThemes(names: string[], themes: Theme[]): string[] {
  const byNorm = new Map(themes.map(t => [norm(t.name), t.name]));
  const out: string[] = [];
  for (const n of names) {
    const hit = byNorm.get(norm(n));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out.slice(0, MAX_THEMES_PER_NOTE);
}

/** Temas gravados no frontmatter de uma nota (`temas: [Pix, Cashback]`). */
export function noteThemes(frontmatter: string): string[] | null {
  const m = frontmatter.match(/^temas:\s*\[(.*)\]\s*$/m);
  if (!m) return null;  // null = nota sem classificação (antiga)
  return m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}
