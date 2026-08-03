/**
 * Frontmatter YAML das notas do vault: no Obsidian ele vira "Properties";
 * aqui, cru, é ruído. Separamos o bloco e destilamos só o que interessa ao
 * leitor humano — o resto (modelos, tokens, flags) fica de fora.
 */

export type NoteMeta = {
  title?: string;
  date?: string;
  time?: string;
  participants: string[];
  tags: string[];
  durationLabel?: string;   // "27 min"
  costLabel?: string;       // "$0.41"
};

export function splitFrontmatter(markdown: string): { meta: NoteMeta | null; body: string } {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: null, body: markdown };

  const raw: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) raw[kv[1]] = kv[2].trim();
  }

  const list = (v?: string) =>
    (v ?? '')
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);

  const secs = parseFloat(raw.audio_seconds ?? '');
  const cost = parseFloat(raw.estimated_cost_usd ?? '');

  const meta: NoteMeta = {
    title: raw.title?.replace(/^["']|["']$/g, '') || undefined,
    date: raw.date,
    time: raw.time,
    participants: list(raw.participants),
    tags: list(raw.tags).filter((t) => t !== 'meeting'), // "meeting" está em todas — ruído
    durationLabel: Number.isFinite(secs) && secs > 0 ? `${Math.round(secs / 60)} min` : undefined,
    costLabel: Number.isFinite(cost) && cost > 0 ? `$${cost.toFixed(2)}` : undefined,
  };

  return { meta, body: markdown.slice(m[0].length) };
}
