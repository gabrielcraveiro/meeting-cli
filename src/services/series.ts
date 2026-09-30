// Identidade de série de uma reunião recorrente.
//
// O organizador reescreve o título da nota a cada ocorrência ("TAB - Comitê de
// Mudanças" virou "Aprovação de RDMs — Janela de Deploy"), então o título da
// nota não serve para achar as irmãs da série. O título do calendário/Teams,
// sim: é o mesmo toda semana. Gravamos ele normalizado no frontmatter.

/**
 * Normalize a calendar or Teams title into a stable series key.
 *
 * Contract: removes a trailing parenthetical (Teams toggles "(Externo)" in the
 * SAME call), lowercases, and collapses spaces. Returns '' for an empty title.
 * Same rule as `normTitle` in daemon.ts.
 *
 * @example
 * seriesKey('TAB - Comitê de Mudanças (Externo)') // → 'tab - comitê de mudanças'
 */
export function seriesKey(title: string | undefined | null): string {
  return (title ?? '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
