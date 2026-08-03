// Session → daemon reporting channel (contrato: docs/app-api.md).
//
// The recording session (`meeting start --browser`) pushes its live state to the
// daemon so the desktop app can render the meeting in real time. EVERYTHING here
// is fire-and-forget and swallows errors: the daemon may be gone, busy or on
// another port — a recording must NEVER break because the app is not listening.

export interface ReportedLine { ts: number; speaker: string; text: string }

export type QueueItem =
  | { type: 'chat'; id: string; message: string }
  | { type: 'note'; ts: number; text: string };

const PORT = parseInt(process.env.MEETING_DAEMON_PORT || '') || 7899;
const BASE = `http://127.0.0.1:${PORT}`;

let enabled = false;

/** Enable reporting (only makes sense in --browser sessions spawned by the daemon). */
export function enableReporting(): void {
  enabled = true;
}

export function reportingEnabled(): boolean {
  return enabled;
}

async function post(route: string, body: unknown, timeoutMs = 4000): Promise<void> {
  if (!enabled) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await fetch(BASE + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // daemon offline / slow — silently ignore
  }
}

export function reportTranscript(lines: ReportedLine[]): void {
  if (!enabled || lines.length === 0) return;
  void post('/internal/transcript', { lines });
}

export function reportInsight(ts: number, text: string): void {
  if (!enabled || !text.trim()) return;
  void post('/internal/insight', { ts, text });
}

export function reportState(phase: 'idle' | 'recording' | 'finalizing', title?: string, elapsedSec?: number): void {
  if (!enabled) return;
  void post('/internal/state', { phase, title, elapsedSec });
}

export function reportChatReply(id: string, reply: string): void {
  if (!enabled) return;
  void post('/internal/chat-reply', { id, reply });
}

/**
 * Long-poll the daemon for items produced by the app (chat questions, notes).
 * Resolves with [] on timeout or any failure — never throws.
 */
export async function fetchQueue(timeoutMs = 27_000): Promise<QueueItem[]> {
  if (!enabled) return [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}/internal/chat-queue`, { signal: ctrl.signal });
      if (!res.ok) return [];
      const data = (await res.json()) as { items?: QueueItem[] };
      return Array.isArray(data.items) ? data.items : [];
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}
