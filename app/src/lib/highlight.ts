/**
 * Highlight client-side dos termos da busca dentro do snippet.
 *
 * O daemon devolve o snippet cru; marcar aqui evita confiar em HTML de fora e
 * permite ignorar acentos/caixa ("reuniao" acha "Reunião").
 */

export type Segment = { text: string; hit: boolean };

/** Remove diacríticos e baixa a caixa de um único caractere. */
function foldChar(ch: string): string {
  return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Versão "dobrada" de uma string inteira (para os termos da query). */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Termos úteis da query: ≥2 chars, sem pontuação de borda, sem repetição. */
export function queryTerms(query: string): string[] {
  const raw = fold(query)
    .split(/[\s,.;:!?()[\]{}"'“”…/\\|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return Array.from(new Set(raw));
}

/**
 * Quebra `text` em segmentos alternando trechos comuns e trechos que casam com
 * algum termo. Sempre devolve ao menos um segmento (possivelmente vazio).
 */
export function highlight(text: string, query: string): Segment[] {
  const terms = queryTerms(query);
  if (!text || terms.length === 0) return [{ text, hit: false }];

  // índice folded -> índice original (folding pode encolher/expandir o texto)
  let folded = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = foldChar(text[i]!);
    for (let k = 0; k < f.length; k++) origin.push(i);
    folded += f;
  }

  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at < 0) break;
      const start = origin[at];
      const last = origin[at + term.length - 1];
      if (start !== undefined && last !== undefined) ranges.push([start, last + 1]);
      from = at + term.length;
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  const out: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}
