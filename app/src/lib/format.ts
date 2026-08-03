/** Formatação de tempo e datas em PT-BR. */

export function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** "hoje" / "ontem" / "30/07" — para a lista de recentes. */
export function relativeDay(dateStr: string): string {
  const d = parseLooseDate(dateStr);
  if (!d) return dateStr;
  const today = startOfDay(new Date());
  const diffDays = Math.round((today.getTime() - startOfDay(d).getTime()) / 86400000);
  if (diffDays === 0) return 'hoje';
  if (diffDays === 1) return 'ontem';
  if (diffDays > 1 && diffDays < 7) return `${diffDays} dias`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function parseLooseDate(value: string): Date | null {
  if (!value) return null;
  // "2026-08-03" ou "2026-08-03 14:30" ou ISO completo
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) return d;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

/** "Maria, João e +2" — participantes no estilo Granola. */
export function participantsLabel(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length <= 3) return clean.join(', ');
  return `${clean.slice(0, 2).join(', ')} e +${clean.length - 2}`;
}

/**
 * Nome do vault = último segmento do path absoluto configurado. Para quando o
 * daemon passar a expor o path do vault (hoje o nome vem do localStorage).
 *
 * A URI `obsidian://` em si é montada no Rust (`open_obsidian`), não aqui.
 */
export function vaultNameFromPath(vaultPath: string): string {
  const segments = vaultPath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return segments[segments.length - 1] ?? '';
}
