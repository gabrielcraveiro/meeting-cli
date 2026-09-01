/**
 * Cliente HTTP do daemon do meeting-cli (contrato: docs/app-api.md).
 * Base fixa em 127.0.0.1:7899 — o daemon libera CORS para localhost:1420
 * (dev) e tauri://localhost (prod).
 */

export const API_BASE = 'http://127.0.0.1:7899';

export class DaemonOfflineError extends Error {
  constructor() {
    super('daemon offline');
    this.name = 'DaemonOfflineError';
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Mensagem amigável em PT-BR para qualquer erro vindo daqui. */
export function friendlyError(err: unknown): string {
  if (err instanceof DaemonOfflineError) {
    return 'Daemon offline — abra o Meeting Daemon para continuar.';
  }
  if (err instanceof ApiError) {
    if (err.status === 409) return 'Nenhuma reunião sendo gravada agora.';
    if (err.status === 404) return 'Nada por aqui ainda.';
    return `O daemon respondeu ${err.status}.`;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return 'A requisição demorou demais. Tentando de novo…';
  }
  return 'Algo deu errado. Tente novamente.';
}

/**
 * `/ask` tem semântica própria para 409 (fila ocupada) e 504 (timeout do lado
 * do daemon), então não reaproveita o mapa genérico de `friendlyError`.
 */
export function askError(err: unknown): string {
  if (err instanceof DaemonOfflineError) {
    return 'Daemon offline — abra o Meeting Daemon para perguntar ao vault.';
  }
  if (err instanceof ApiError) {
    if (err.status === 409) return 'Já existe uma pergunta em andamento — aguarde.';
    if (err.status === 504) return 'A pergunta passou do tempo limite. Tente de novo.';
    if (err.status === 400) return 'Pergunta vazia ou inválida.';
    return `O daemon respondeu ${err.status}.`;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return 'A pergunta demorou demais (mais de 3 minutos). Tente de novo.';
  }
  return 'Não foi possível responder agora. Tente de novo.';
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = 8000 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // fetch só rejeita por rede/abort — em ambos os casos o daemon está
    // inalcançável do ponto de vista do usuário.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new DaemonOfflineError();
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const txt = await res.text();
      if (txt) detail = txt.slice(0, 200);
    } catch {
      /* ignora */
    }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Retry suave: 2 tentativas extras com backoff curto, só para GETs. */
async function getWithRetry<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await request<T>(path, opts);
    } catch (err) {
      lastErr = err;
      // erros de contrato (4xx) não melhoram com retry
      if (err instanceof ApiError) throw err;
      if (attempt < 2) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- tipos

export type Phase = 'idle' | 'recording' | 'finalizing';

export type Status = {
  recording: boolean;
  /** Pausa global: quando true, calls detectadas pela extensão não são gravadas. */
  recordingPaused?: boolean;
  title?: string;
  /** Identidade da sessão no daemon — muda a cada call (troca emendada inclusive). */
  sessionKey?: number;
  elapsedSec?: number;
  sharing: boolean;
  phase: Phase;
};

export type OpenTask = {
  file: string;
  line: string;
  text: string;
  owner?: string;
  /** true = tarefa do próprio usuário (sem dono ou dono = config.userName) */
  mine: boolean;
  due?: string;
  noteTitle: string;
  noteDate: string;
};

export type Meeting = {
  title: string;
  startIso: string;
  endIso: string;
  attendees: string[];
  /** nota da reunião casada por horário, quando a call foi gravada */
  note?: { file: string; title: string } | null;
};

export type NoteSummary = {
  file: string;
  title: string;
  date: string;
  time?: string;
  participants: string[];
  tags: string[];
};

/** Item de `/search` — busca léxica no vault. */
export type SearchResult = {
  file: string;
  title: string;
  date: string;
  snippet: string;
  score: number;
};

/** Fonte citada por `/ask`. */
export type AskSource = { file: string; title: string };

export type AskResponse = {
  answer: string;
  sources: AskSource[];
  costUsd?: number;
};

/** Turno de conversa enviado como contexto em follow-ups de `/ask` (máx. 12
 * itens aceitos pelo daemon). */
export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type TranscriptLine = { ts: number; speaker: string; text: string };
/**
 * Linha de log do daemon (`/daemon/logs`). `at` é epoch ms no contrato atual —
 * aceitamos string também para não quebrar se virar ISO.
 */
export type LogLine = { line: string; at?: number | string };
export type Insight = { ts: number; text: string };
export type SessionNote = { ts: number; text: string };

// ---------------------------------------------------------------- endpoints

export const api = {
  status: (signal?: AbortSignal) =>
    request<Status>('/status', { timeoutMs: 4000, signal }),

  meetingsToday: () => getWithRetry<Meeting[]>('/meetings/today'),

  /** Agenda de um dia específico (navegação ‹ › na Home), com nota por evento. */
  meetingsForDay: (date: string) =>
    getWithRetry<Meeting[]>(`/meetings/today?date=${encodeURIComponent(date)}`),

  notesRecent: (limit = 20) =>
    getWithRetry<NoteSummary[]>(`/notes/recent?limit=${limit}`),

  noteContent: (file: string) =>
    getWithRetry<{ markdown: string }>(
      `/notes/content?file=${encodeURIComponent(file)}`,
    ),

  briefingToday: () => request<{ markdown: string }>('/briefing/today'),

  /**
   * Busca léxica no vault. `q` com menos de 1 char faz o daemon responder 400 —
   * quem chama garante o mínimo (2 chars na UI).
   */
  search: (q: string, limit = 20, signal?: AbortSignal) =>
    request<{ results: SearchResult[] }>(
      `/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      { timeoutMs: 12000, signal },
    ).then((r) => r?.results ?? []),

  /**
   * Pergunta ao vault. mode 'fast' (default) = RAG numa chamada só (~5-10s);
   * 'deep' = claude agêntico pesquisando o vault (~40s+, mais minucioso).
   * 409 quando já há uma pergunta em andamento no daemon, 504 no timeout dele.
   */
  ask: (question: string, history?: ChatTurn[], signal?: AbortSignal, mode: 'fast' | 'deep' = 'fast') =>
    request<AskResponse>('/ask', {
      method: 'POST',
      body: {
        question,
        mode,
        ...(history && history.length > 0 ? { history } : {}),
      },
      timeoutMs: 210000,
      signal,
    }),

  /** Prep da reunião atual — vira o esqueleto inicial do notepad. 404 = sem prep. */
  sessionPrep: () =>
    request<{ file: string; markdown: string }>('/session/prep', { timeoutMs: 15000 }),

  /** Pauta da call ao vivo: "fio da meada" do tema + pendências topicais + notas relacionadas. */
  sessionPauta: () =>
    request<{
      context: string | null;
      tasks: OpenTask[];
      related: Array<{ file: string; title: string; date: string }>;
    }>('/session/pauta', { timeoutMs: 30000 }),

  /** Notas macro por tema (Temas/) + sugestões de cluster. Só leitura local. */
  topics: () =>
    request<{
      topics: Array<{ file: string; title: string; updated: string; sources: number }>;
      suggestions: Array<{ topic: string; notes: number }>;
    }>('/topics', { timeoutMs: 20000 }),

  /** Gera/atualiza a nota macro de um tema (1 chamada de modelo, incremental). */
  topicBuild: (topic: string) =>
    request<{ file: string; added: number; skipped: boolean }>('/topics/build', {
      method: 'POST',
      body: { topic },
      timeoutMs: 180000,
    }),

  /** Salva o markdown editado de uma nota (escrita atômica no daemon). */
  noteSave: (file: string, markdown: string) =>
    request<{ ok: boolean }>('/notes/save', {
      method: 'POST',
      body: { file, markdown },
      timeoutMs: 20000,
    }),

  /** Move uma nota pra .trash/ do vault (recuperável no Obsidian). */
  noteDelete: (file: string) =>
    request<{ ok: boolean }>('/notes/delete', {
      method: 'POST',
      body: { file },
      timeoutMs: 15000,
    }),

  /** Corrige um termo em TODAS as ocorrências de uma nota (retro-fix do glossário). */
  noteReplace: (file: string, from: string, to: string) =>
    request<{ ok: boolean; replaced: number }>('/notes/replace', {
      method: 'POST',
      body: { file, from, to },
      timeoutMs: 15000,
    }),

  /** Action items abertos agregados de todas as notas de reunião. */
  tasksOpen: () => request<{ tasks: OpenTask[] }>('/tasks/open', { timeoutMs: 20000 }),

  /** Conclui uma tarefa (flip `- [ ]` → `- [x] ✅ hoje` na nota de origem). */
  taskClose: (file: string, line: string) =>
    request<{ ok: boolean }>('/tasks/close', {
      method: 'POST',
      body: { file, line },
      timeoutMs: 15000,
    }),

  start: (title?: string) =>
    request<unknown>('/start', {
      method: 'POST',
      body: title ? { title } : {},
      timeoutMs: 20000,
    }),

  // Pausa global de gravação automática. Persiste no daemon (sobrevive a
  // restart) — nenhuma call detectada pela extensão é gravada enquanto pausado.
  setRecordingPaused: (paused: boolean) =>
    request<{ ok: boolean; recordingPaused: boolean }>('/recording-toggle', {
      method: 'POST',
      body: { paused },
      timeoutMs: 15000,
    }),

  // reason 'user' marca cancelamento manual: o daemon não regrava esta call
  // se a extensão redetectá-la (você parou de propósito, continua na reunião).
  stop: () =>
    request<unknown>('/stop', { method: 'POST', body: { reason: 'user' }, timeoutMs: 30000 }),

  postSessionNote: (text: string) =>
    request<{ ok: boolean; ts: number }>('/session/notes', {
      method: 'POST',
      body: { text },
    }),

  sessionNotes: () => request<{ notes: SessionNote[] }>('/session/notes'),

  /** Contexto extra pós-reunião (janela de ~45s). 409 = janela perdida. */
  sessionContext: (text: string) =>
    request<unknown>('/session/context', {
      method: 'POST',
      body: { text },
      timeoutMs: 10000,
    }),

  daemonLogs: () => request<{ lines: LogLine[] }>('/daemon/logs', { timeoutMs: 6000 }),

  chat: (message: string) =>
    request<{ reply: string }>('/session/chat', {
      method: 'POST',
      body: { message },
      // o daemon avisa que pode levar 5-15s; damos folga
      timeoutMs: 60000,
    }),

  /**
   * Glossário de correções (meeting-glossario.md no vault): "termo errado" →
   * "forma correta", aplicado a toda transcrição dali em diante.
   */
  glossaryAdd: (from: string, to: string) =>
    request<{ ok: boolean; entries: Array<{ from: string; to: string }> }>('/glossary', {
      method: 'POST',
      body: { from, to },
      timeoutMs: 8000,
    }),

  /** Enhance ao vivo (Granola durante a call): prévia das notas aprimoradas. */
  enhance: () =>
    request<{ markdown: string }>('/session/enhance', {
      method: 'POST',
      body: {},
      timeoutMs: 125000,
    }),
};
