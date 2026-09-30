import type { SpeechSpan } from './bridge';

// O ASR do Teams reescreve a legenda enquanto a pessoa fala ("Bel." →
// "Beleza, Ana, é." → "Beleza, Ana, é eu."). A extensão às vezes perde a
// âncora entre uma amostra e outra e grava cada versão como fala nova — o
// transcript sai com a mesma frase 2-3 vezes, crescendo. Aqui juntamos essas
// versões numa fala só, ficando com a mais completa.

/** Revisões chegam a cada amostra da extensão (~2s). Acima disso é fala nova,
 * mesmo que comece igual ("Isso." … 20s depois … "Isso aí, mas…"). */
const MAX_REVISION_GAP_SEC = 6;
/** Fração das palavras da versão anterior que precisa reaparecer, em ordem,
 * no começo da seguinte. Não é 1.0 porque o ASR troca palavras no meio
 * ("gente, pode colo" → "a gente pode colocar"). */
const MIN_WORD_OVERLAP = 0.7;
/** A versão nova pode sair um pouco MAIS CURTA quando o ASR reescreve a frase
 * inteira ("Bora voltar na sua marcinha a 74892." → "agora voltar na sua
 * marcinha 74892"). Mais curta que isso já não é revisão. */
const MIN_LENGTH_RATIO = 0.8;
/** Folga de palavras que a versão nova pode ter inserido antes do fim da antiga. */
const HEAD_SLACK_WORDS = 4;

function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Palavra cortada no meio conta como igual ("colo" ≈ "colocar", "bel" ≈ "beleza"). */
function sameWord(partial: string, full: string): boolean {
  return full === partial || (partial.length >= 2 && full.startsWith(partial));
}

/** Tamanho da maior subsequência comum entre `a` e o começo de `b`. */
function orderedOverlap(a: string[], b: string[]): number {
  const head = b.slice(0, a.length + HEAD_SLACK_WORDS);
  const dp: number[] = new Array(head.length + 1).fill(0);
  for (const wa of a) {
    let diag = 0;
    for (let j = 1; j <= head.length; j++) {
      const up = dp[j];
      dp[j] = sameWord(wa, head[j - 1]) ? diag + 1 : Math.max(dp[j], dp[j - 1]);
      diag = up;
    }
  }
  return dp[head.length];
}

/** True quando `next` é uma versão reescrita de `prev` (em geral mais longa). */
export function isCaptionRevision(prev: SpeechSpan, next: SpeechSpan): boolean {
  if (prev.who !== next.who) return false;
  if (next.start - prev.end > MAX_REVISION_GAP_SEC) return false;
  const a = words(prev.text ?? '');
  const b = words(next.text ?? '');
  if (a.length === 0 || b.length < a.length * MIN_LENGTH_RATIO) return false;
  return orderedOverlap(a, b) / a.length >= MIN_WORD_OVERLAP;
}

/**
 * Collapse consecutive caption revisions into one span.
 *
 * Contract: the input is the ordered span list from the bridge. The output
 * keeps the order. Each output span keeps the `start` of the first version,
 * the `end` of the last version, and the text of the last version. The input
 * is not mutated. Spans without text are dropped.
 *
 * @example
 * collapseCaptionRevisions([
 *   { who: 'Ana', start: 29, end: 29, text: 'Bel.' },
 *   { who: 'Ana', start: 31, end: 33, text: 'Beleza, Ana, é eu.' },
 * ]) // → [{ who: 'Ana', start: 29, end: 33, text: 'Beleza, Ana, é eu.' }]
 */
export function collapseCaptionRevisions(spans: SpeechSpan[]): SpeechSpan[] {
  const out: SpeechSpan[] = [];
  for (const sp of spans) {
    if (!sp.text || !sp.text.trim()) continue;
    const last = out[out.length - 1];
    if (last && isCaptionRevision(last, sp)) {
      out[out.length - 1] = { ...sp, start: last.start, end: Math.max(last.end, sp.end) };
    } else {
      out.push({ ...sp });
    }
  }
  return out;
}
