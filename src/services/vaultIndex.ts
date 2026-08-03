import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../config';
import { parseFrontmatter } from './storage';

// Índice léxico em memória do vault (Meetings/ + Briefings/).
//
// Por que scoring próprio e não minisearch: o vault é pequeno (dezenas/centenas de
// notas) e o que realmente decide a qualidade aqui é (a) normalização pt-BR sem
// perder índices para o snippet e (b) peso por campo + recência. Com minisearch eu
// ainda escreveria a normalização, o strip de markdown e o snippet posicional na
// mão — a única coisa herdada seria o BM25, que em ~150 linhas sai igual e sem
// dependência nova no bundle esbuild. Rebuild completo é barato: sem incremental.

const STALE_MS = 5 * 60 * 1000;
const INDEXED_DIRS = ['Meetings', 'Briefings'];

/** Peso por campo — título e tags valem mais que corpo. */
const FIELD_WEIGHT = { title: 5, tags: 3, participants: 2, body: 1 } as const;
type Field = keyof typeof FIELD_WEIGHT;

export interface SearchHit {
  file: string;
  title: string;
  date: string;
  snippet: string;
  score: number;
}

interface Doc {
  file: string;
  title: string;
  date: string;
  /** Corpo já limpo de frontmatter e markdown pesado (usado no snippet). */
  body: string;
  /** Mesma string do body com diacríticos removidos e lowercase, ÍNDICES PRESERVADOS. */
  bodyNorm: string;
  /** term → contagem, por campo. */
  freq: Record<Field, Map<string, number>>;
  /** Timestamp (ms) da nota, para boost de recência. */
  time: number;
}

interface Index {
  docs: Doc[];
  /** Todos os termos vistos (ordenado) — varredura para prefix search. */
  terms: string[];
  /** term → nº de docs que o contêm (idf). */
  df: Map<string, number>;
  builtAt: number;
  signature: string;
  newestTime: number;
}

let index: Index | null = null;

// ── Normalização pt-BR ───────────────────────────────────────────────────

/**
 * lowercase + remoção de diacríticos preservando o comprimento da string
 * (char a char) — necessário para localizar o offset do match no body original.
 */
export function normalizePreservingLength(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    out += base.length === 1 ? base : ch;  // ligaduras/emoji: mantém o char original
  }
  return out;
}

export function tokenize(s: string): string[] {
  return normalizePreservingLength(s)
    .split(/[^a-z0-9çà-ÿ_]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

// ── Preparo do documento ─────────────────────────────────────────────────

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

/** Remove markdown pesado mantendo o texto legível para o snippet. */
function cleanBody(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')          // blocos de código
    .replace(/!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')  // wikilinks
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // links markdown
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')       // headings
    .replace(/\*\*|__|\*|`|~~/g, '')          // ênfases
    .replace(/^\s*[-*+]\s+/gm, '')            // bullets
    .replace(/^\s*\|/gm, ' ')                 // tabelas
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function parseListValue(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function countInto(map: Map<string, number>, tokens: string[]): void {
  for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1);
}

function buildDoc(relFile: string, content: string): Doc {
  const meta = parseFrontmatter(content);
  const fileName = path.basename(relFile);
  const title = (meta['title'] || fileName.replace(/\.md$/, '')).replace(/^["']|["']$/g, '');
  const date = meta['date'] || '';
  const time = meta['time'] || '';
  const body = cleanBody(stripFrontmatter(content));

  const freq = {
    title: new Map<string, number>(),
    tags: new Map<string, number>(),
    participants: new Map<string, number>(),
    body: new Map<string, number>(),
  };
  countInto(freq.title, tokenize(title));
  countInto(freq.tags, tokenize(parseListValue(meta['tags']).join(' ')));
  countInto(freq.participants, tokenize(parseListValue(meta['participants']).join(' ')));
  countInto(freq.body, tokenize(body));

  const parsed = Date.parse(`${date || '1970-01-01'}T${/^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : '00:00'}:00`);

  return {
    file: relFile,
    title,
    date,
    body,
    bodyNorm: normalizePreservingLength(body),
    freq,
    time: Number.isFinite(parsed) ? parsed : 0,
  };
}

// ── Build / refresh ──────────────────────────────────────────────────────

/** Assinatura de frescor: mtime dos diretórios indexados (criação/remoção de nota). */
function dirSignature(config: Config): string {
  return INDEXED_DIRS.map(d => {
    try {
      return `${d}:${fs.statSync(path.join(config.vaultPath, d)).mtimeMs}`;
    } catch {
      return `${d}:-`;
    }
  }).join('|');
}

export function buildIndex(config: Config): Index {
  const docs: Doc[] = [];
  for (const dir of INDEXED_DIRS) {
    const abs = path.join(config.vaultPath, dir);
    let files: string[] = [];
    try { files = fs.readdirSync(abs).filter(f => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      try {
        docs.push(buildDoc(`${dir}/${f}`, fs.readFileSync(path.join(abs, f), 'utf-8')));
      } catch { /* nota ilegível não derruba o índice */ }
    }
  }

  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const field of Object.keys(doc.freq) as Field[]) {
      for (const term of doc.freq[field].keys()) seen.add(term);
    }
    for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
  }

  index = {
    docs,
    terms: [...df.keys()].sort(),
    df,
    builtAt: Date.now(),
    signature: dirSignature(config),
    newestTime: docs.reduce((max, d) => Math.max(max, d.time), 0),
  };
  return index;
}

/** Reconstrói se passou o TTL ou se os diretórios do vault mudaram. */
export function refreshIfStale(config: Config): void {
  if (!index) return void buildIndex(config);
  if (Date.now() - index.builtAt > STALE_MS) return void buildIndex(config);
  if (dirSignature(config) !== index.signature) return void buildIndex(config);
}

export function indexSize(): number {
  return index?.docs.length ?? 0;
}

// ── Busca ────────────────────────────────────────────────────────────────

/** Termos do índice que casam exatamente ou por prefixo (digitação parcial). */
function expand(term: string, terms: string[]): Array<{ term: string; exact: boolean }> {
  const out: Array<{ term: string; exact: boolean }> = [];
  for (const t of terms) {
    if (t === term) out.push({ term: t, exact: true });
    else if (term.length >= 3 && t.startsWith(term)) out.push({ term: t, exact: false });
  }
  return out;
}

export function search(q: string, limit = 20): SearchHit[] {
  if (!index || index.docs.length === 0) return [];
  const queryTerms = tokenize(q);
  if (queryTerms.length === 0) return [];

  const n = index.docs.length;
  const scored: SearchHit[] = [];

  for (const doc of index.docs) {
    let score = 0;
    let matched = 0;

    for (const qt of queryTerms) {
      let best = 0;
      for (const { term, exact } of expand(qt, index.terms)) {
        const idf = Math.log(1 + n / (index.df.get(term) ?? 1));
        let termScore = 0;
        for (const field of Object.keys(FIELD_WEIGHT) as Field[]) {
          const tf = doc.freq[field].get(term) ?? 0;
          if (tf === 0) continue;
          // tf saturado: 5 ocorrências não valem 5x uma
          termScore += FIELD_WEIGHT[field] * (tf / (tf + 1.2)) * idf;
        }
        if (!exact) termScore *= 0.6;  // prefixo vale menos que match exato
        if (termScore > best) best = termScore;
      }
      if (best > 0) { score += best; matched++; }
    }

    if (matched === 0) continue;
    // Cobertura: doc que casa todos os termos ganha muito de quem casa um só
    score *= Math.pow(matched / queryTerms.length, 2);
    // Recência: até +30% para a nota mais nova, decaindo em ~120 dias
    if (doc.time > 0 && index.newestTime > 0) {
      const ageDays = (index.newestTime - doc.time) / 86_400_000;
      score *= 1 + 0.3 * Math.max(0, 1 - ageDays / 120);
    }

    scored.push({
      file: doc.file,
      title: doc.title,
      date: doc.date,
      snippet: snippetFor(doc, queryTerms),
      score: Math.round(score * 1000) / 1000,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  return scored.slice(0, limit);
}

const SNIPPET_LEN = 160;

/** ~160 chars centrados na primeira ocorrência de um termo (ou início do corpo). */
function snippetFor(doc: Doc, queryTerms: string[]): string {
  let at = -1;
  for (const qt of queryTerms) {
    const i = doc.bodyNorm.indexOf(qt);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }

  if (at === -1) return truncate(doc.body.slice(0, SNIPPET_LEN + 40));

  let start = Math.max(0, at - Math.floor((SNIPPET_LEN - 20) / 2));
  // não corta palavra ao meio no início
  if (start > 0) {
    const space = doc.body.indexOf(' ', start);
    if (space !== -1 && space - start < 20) start = space + 1;
  }
  const raw = doc.body.slice(start, start + SNIPPET_LEN).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + truncate(raw) + (start + SNIPPET_LEN < doc.body.length ? '…' : '');
}

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_LEN ? flat.slice(0, SNIPPET_LEN).replace(/\s\S*$/, '') : flat;
}
