import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import { writeBridge, updateBridgeParticipants, updateBridgeSpeech, updateBridgeSharing, requestBridgeStop, clearBridge, readBridge } from '../services/bridge';
import { notifyWindows } from '../services/notify';
import { loadConfig, Config } from '../config';
import { parseFrontmatter } from '../services/storage';
import { getUpcomingMeetings, CalendarEvent } from '../services/calendar';

// `meeting daemon` — HTTP bridge for the browser extension AND for the desktop app.
// Listens on localhost and spawns `meeting start --browser` when the extension
// reports that a call started. The recording TUI takes over this terminal;
// when the session ends the daemon resumes listening.
//
// The daemon also holds the LIVE SESSION STATE in memory (transcript, insights,
// user notes, chat queue) so the app can read the running meeting without
// touching disk. Contract: docs/app-api.md. State dies with the daemon.

const DEFAULT_PORT = 7899;
const SSE_HEARTBEAT_MS = 15_000;
const CHAT_TIMEOUT_MS = 60_000;
const QUEUE_POLL_TIMEOUT_MS = 25_000;
const MEETINGS_CACHE_MS = 5 * 60 * 1000;
const LOG_BUFFER_MAX = 500;
/** SGR/CSI sequences — logs go to the app as plain text. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

interface StartPayload {
  title?: string;
  platform?: string;
  url?: string;
  participants?: string[];
  template?: string;
}

type Phase = 'idle' | 'recording' | 'finalizing';

interface TranscriptLine { ts: number; speaker: string; text: string }
interface Stamped { ts: number; text: string }

/** Item awaiting delivery to the recording session via /internal/chat-queue. */
type QueueItem =
  | { type: 'chat'; id: string; message: string }
  | { type: 'note'; ts: number; text: string }
  | { type: 'context'; text: string };

interface LogLine { line: string; at: number }

interface SessionState {
  title?: string;
  phase: Phase;
  elapsedSec: number;
  transcript: TranscriptLine[];
  insights: Stamped[];
  userNotes: Stamped[];
  chatQueue: QueueItem[];
  sseTranscript: Set<http.ServerResponse>;
  sseInsights: Set<http.ServerResponse>;
}

function emptySession(title?: string): SessionState {
  return {
    title,
    phase: 'idle',
    elapsedSec: 0,
    transcript: [],
    insights: [],
    userNotes: [],
    chatQueue: [],
    sseTranscript: new Set(),
    sseInsights: new Set(),
  };
}

export async function cmdDaemon(opts: { port?: string; headless?: boolean } = {}): Promise<void> {
  const port = parseInt(opts.port || '') || DEFAULT_PORT;
  const headless = opts.headless === true;
  let child: ChildProcess | null = null;

  // Daemon log tail — lives OUTSIDE the session state (survives resetSession) so the
  // app can attach at any moment and see what the daemon/session has been doing.
  const daemonLogs: LogLine[] = [];
  const sseLogs = new Set<http.ServerResponse>();

  function pushLog(raw: string): void {
    const line = raw.replace(ANSI_RE, '').replace(/\r$/, '');
    const entry: LogLine = { line, at: Date.now() };
    daemonLogs.push(entry);
    if (daemonLogs.length > LOG_BUFFER_MAX) daemonLogs.splice(0, daemonLogs.length - LOG_BUFFER_MAX);
    broadcast(sseLogs, sseEvent('log', entry));
  }

  /** console.log + tail buffer + SSE. Use instead of console.log inside the daemon. */
  function logLine(msg: string): void {
    console.log(msg);
    for (const l of String(msg).split('\n')) pushLog(l);
  }

  /** Feed a child stdout/stderr chunk stream into the tail buffer, line by line. */
  function pipeChildLogs(stream: NodeJS.ReadableStream | null | undefined): void {
    if (!stream) return;
    let pending = '';
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) pushLog(l);
      if (pending.length > 8192) { pushLog(pending); pending = ''; }
    });
    stream.on('end', () => { if (pending.trim()) pushLog(pending); pending = ''; });
    stream.on('error', () => {});
  }

  const cliPath = path.resolve(process.argv[1]);

  let session = emptySession();
  /** App chat questions waiting for the session to answer via /internal/chat-reply. */
  const pendingChats = new Map<string, { deliver: (reply: string | null) => void; timer: NodeJS.Timeout }>();
  /** Sessions long-polling /internal/chat-queue, released as soon as an item shows up. */
  const queueWaiters = new Set<(items: QueueItem[]) => void>();
  let chatSeq = 0;

  function resetSession(title?: string): void {
    for (const res of [...session.sseTranscript, ...session.sseInsights]) {
      try { res.end(); } catch {}
    }
    for (const [, pending] of pendingChats) {
      clearTimeout(pending.timer);
      pending.deliver(null);
    }
    pendingChats.clear();
    for (const w of queueWaiters) w([]);
    queueWaiters.clear();
    session = emptySession(title);
  }

  function enqueue(item: QueueItem): void {
    session.chatQueue.push(item);
    flushQueueWaiters();
  }

  function flushQueueWaiters(): void {
    if (session.chatQueue.length === 0 || queueWaiters.size === 0) return;
    const items = session.chatQueue.splice(0, session.chatQueue.length);
    const waiter = [...queueWaiters][0];
    queueWaiters.delete(waiter);
    waiter(items);
  }

  function startSession(payload: StartPayload): void {
    writeBridge({
      title: payload.title,
      platform: payload.platform,
      participants: (payload.participants ?? []).map(p => p.trim()).filter(Boolean),
      stopRequested: false,
      updatedAt: Date.now(),
    });

    resetSession(payload.title);
    session.phase = 'recording';

    // Title reaches the session via the bridge file (read in --browser mode), never
    // via argv — a DOM-scraped title starting with "-" would smuggle flags into commander.
    const args = [cliPath, 'start', '--browser'];
    if (payload.template && /^[a-z0-9_-]+$/i.test(payload.template)) {
      args.push('--template', payload.template);
    }
    // Headless daemon: the session has no terminal — no TUI, no prompts, and its
    // output is captured here instead of being written to this terminal.
    if (headless) args.push('--headless');

    logLine(chalk.green(`\n▶ Call detectada${payload.title ? `: ${payload.title}` : ''} — iniciando gravação...\n`));
    notifyWindows('🎙 Meeting CLI — gravando', payload.title || 'Call detectada no browser');
    child = spawn(process.execPath, args, {
      stdio: headless ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      // The session reports back to this very daemon — tell it where to POST.
      env: { ...process.env, MEETING_DAEMON_PORT: String(port) },
    });
    if (headless) {
      pipeChildLogs(child.stdout);
      pipeChildLogs(child.stderr);
    }
    child.on('exit', (code) => {
      child = null;
      clearBridge();
      resetSession();
      logLine(chalk.gray(`\n  Sessão finalizada (exit ${code ?? 0}). Aguardando próxima call...\n`));
    });
  }

  // CSRF guard: any webpage can fetch() localhost, and browsers always attach an
  // Origin header to cross-origin POSTs. Only extension origins (moz-extension://,
  // chrome-extension://), the desktop app (Tauri dev server / tauri://localhost)
  // and origin-less local tools (curl) are allowed — any other http(s) origin
  // means a random webpage is probing the daemon.
  const APP_ORIGINS = new Set([
    'http://localhost:1420', 'http://127.0.0.1:1420',  // tauri dev (vite)
    'tauri://localhost',                                // tauri prod (macOS/Linux)
    'http://tauri.localhost', 'https://tauri.localhost' // tauri prod (Windows WebView2)
  ]);

  function isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;   // no Origin header = local tool (curl), not a browser
    if (origin === 'null') return false;     // sandboxed iframe / file:// — untrusted
    if (APP_ORIGINS.has(origin)) return true;
    return origin.startsWith('moz-extension://') || origin.startsWith('chrome-extension://');
  }

  function corsHeaders(origin?: string): Record<string, string> {
    if (!origin || !isAllowedOrigin(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,  // reflect only trusted origins
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
  }

  function json(res: http.ServerResponse, status: number, body: unknown, origin?: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
    res.end(JSON.stringify(body));
  }

  // ── Vault helpers ────────────────────────────────────────────────────

  let cachedConfig: Config | null = null;
  let cachedConfigAt = 0;
  function cfg(): Config | null {
    if (!cachedConfig || Date.now() - cachedConfigAt > 30_000) {
      cachedConfig = loadConfig();
      cachedConfigAt = Date.now();
    }
    return cachedConfig;
  }

  function parseListValue(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }

  function recentNotes(limit: number): Array<{ file: string; title: string; date: string; time: string; participants: string[]; tags: string[] }> {
    const config = cfg();
    if (!config) return [];
    const dir = path.join(config.vaultPath, 'Meetings');
    if (!fs.existsSync(dir)) return [];

    const notes = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(fileName => {
        try {
          const meta = parseFrontmatter(fs.readFileSync(path.join(dir, fileName), 'utf-8'));
          return {
            file: `Meetings/${fileName}`,
            title: (meta['title'] || fileName.replace(/\.md$/, '')).replace(/^["']|["']$/g, ''),
            date: meta['date'] || '',
            time: meta['time'] || '',
            participants: parseListValue(meta['participants']),
            tags: parseListValue(meta['tags']),
          };
        } catch {
          return null;
        }
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);

    notes.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
    return notes.slice(0, limit);
  }

  /** Resolve a vault-relative path, refusing anything that escapes the vault. */
  function resolveInVault(relPath: string): string | null {
    const config = cfg();
    if (!config) return null;
    const vault = path.resolve(config.vaultPath);
    const target = path.resolve(vault, relPath);
    if (target !== vault && !target.startsWith(vault + path.sep)) return null;
    return target;
  }

  let meetingsCache: { at: number; data: unknown[] } | null = null;
  async function meetingsToday(): Promise<unknown[]> {
    if (meetingsCache && Date.now() - meetingsCache.at < MEETINGS_CACHE_MS) return meetingsCache.data;
    const config = cfg();
    if (!config?.icsUrl) return [];

    const now = new Date();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const windowHours = Math.max(0.5, (endOfDay.getTime() - now.getTime()) / 3_600_000);

    let events: CalendarEvent[] = [];
    try {
      events = await getUpcomingMeetings(config.icsUrl, windowHours);
    } catch {
      return [];  // calendar is best-effort — never fail the app over it
    }
    const data = events.map(e => ({
      title: e.title,
      startIso: e.start.toISOString(),
      endIso: e.end.toISOString(),
      attendees: e.attendees,
    }));
    meetingsCache = { at: Date.now(), data };
    return data;
  }

  // ── SSE ──────────────────────────────────────────────────────────────

  function openSse(res: http.ServerResponse, clients: Set<http.ServerResponse>, origin: string | undefined, snapshot: () => string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(origin),
    });
    clients.add(res);
    res.write(snapshot());

    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, SSE_HEARTBEAT_MS);

    const close = () => {
      clearInterval(hb);
      clients.delete(res);
    };
    res.on('close', close);
    res.on('error', close);
  }

  function sseEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function broadcast(clients: Set<http.ServerResponse>, payload: string): void {
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  }

  // ── Request handling ─────────────────────────────────────────────────

  function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;

    if (!isAllowedOrigin(origin)) {
      logLine(chalk.yellow(`  ⚠ Requisição rejeitada de origem não confiável: ${origin}`));
      return json(res, 403, { error: 'forbidden origin' });
    }

    if (req.method === 'OPTIONS') return json(res, 204, {}, origin);

    const parsed = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const route = parsed.pathname;

    // Internal routes belong to the recording session (a local process, no Origin).
    // A browser can never omit the Origin header on cross-origin requests, so this
    // keeps the app and any webpage out of the session's private channel.
    if (route.startsWith('/internal/')) {
      if (origin !== undefined) return json(res, 403, { error: 'internal endpoint' }, origin);
      return handleInternal(req, res, route);
    }

    if (req.method === 'GET') return handleGet(req, res, route, parsed, origin);
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, origin);

    let payload: any;
    try { payload = await readBody(req); } catch {
      return json(res, 400, { error: 'invalid JSON' }, origin);
    }
    return handlePost(res, route, payload, origin);
  });

  async function handleGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    parsed: URL,
    origin: string | undefined,
  ): Promise<void> {
    switch (route) {
      case '/status': {
        const bridge = readBridge();
        return json(res, 200, {
          recording: child !== null,
          title: session.title,
          elapsedSec: session.elapsedSec,
          sharing: bridge?.sharing === true,
          phase: child !== null ? session.phase : 'idle',
        }, origin);
      }

      case '/meetings/today':
        return json(res, 200, await meetingsToday(), origin);

      case '/notes/recent': {
        const limit = Math.min(200, Math.max(1, parseInt(parsed.searchParams.get('limit') || '20') || 20));
        return json(res, 200, recentNotes(limit), origin);
      }

      case '/notes/content': {
        const file = parsed.searchParams.get('file') || '';
        if (!file) return json(res, 400, { error: 'file obrigatório' }, origin);
        const target = resolveInVault(file);
        if (!target) return json(res, 403, { error: 'caminho fora do vault' }, origin);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          return json(res, 404, { error: 'nota não encontrada' }, origin);
        }
        return json(res, 200, { markdown: fs.readFileSync(target, 'utf-8') }, origin);
      }

      case '/briefing/today': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        const today = new Date().toLocaleDateString('sv').slice(0, 10);
        const file = path.join(config.vaultPath, 'Briefings', `${today}.md`);
        if (!fs.existsSync(file)) return json(res, 404, { error: 'sem briefing hoje' }, origin);
        return json(res, 200, { markdown: fs.readFileSync(file, 'utf-8') }, origin);
      }

      case '/session/transcript/stream':
        if (!child) return json(res, 409, { error: 'não gravando' }, origin);
        return openSse(res, session.sseTranscript, origin, () =>
          sseEvent('snapshot', { lines: session.transcript }));

      case '/session/insights/stream':
        if (!child) return json(res, 409, { error: 'não gravando' }, origin);
        return openSse(res, session.sseInsights, origin, () =>
          sseEvent('snapshot', { insights: session.insights }));

      case '/session/notes':
        if (!child) return json(res, 409, { error: 'não gravando' }, origin);
        return json(res, 200, { notes: session.userNotes }, origin);

      // Logs do daemon + da sessão (headless) — disponíveis mesmo fora de sessão.
      case '/daemon/logs':
        return json(res, 200, { lines: daemonLogs }, origin);

      case '/daemon/logs/stream':
        return openSse(res, sseLogs, origin, () => sseEvent('snapshot', { lines: daemonLogs }));

      default:
        return json(res, 404, { error: 'not found' }, origin);
    }
  }

  async function handlePost(res: http.ServerResponse, route: string, payload: any, origin: string | undefined): Promise<void> {
    switch (route) {
      case '/start':
        if (child) return json(res, 409, { error: 'already recording' }, origin);
        startSession(payload);
        return json(res, 200, { ok: true }, origin);

      case '/participants': {
        if (!Array.isArray(payload.participants)) {
          return json(res, 400, { error: 'participants must be an array' }, origin);
        }
        const state = updateBridgeParticipants(payload.participants);
        return json(res, 200, { ok: true, total: state.participants.length }, origin);
      }

      case '/sharing':
        updateBridgeSharing(payload.active === true);
        return json(res, 200, { ok: true }, origin);

      case '/speech':
        if (!Array.isArray(payload.spans)) {
          return json(res, 400, { error: 'spans must be an array' }, origin);
        }
        updateBridgeSpeech(payload.spans);
        return json(res, 200, { ok: true, total: payload.spans.length }, origin);

      case '/stop':
        if (!child) return json(res, 200, { ok: true, note: 'not recording' }, origin);
        requestBridgeStop();
        return json(res, 200, { ok: true }, origin);

      case '/session/notes': {
        if (!child) return json(res, 409, { error: 'não gravando' }, origin);
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) return json(res, 400, { error: 'text obrigatório' }, origin);
        const ts = session.elapsedSec;
        session.userNotes.push({ ts, text });
        enqueue({ type: 'note', ts, text });  // session keeps it for the final enhance
        return json(res, 200, { ok: true, ts }, origin);
      }

      // Contexto pós-reunião vindo do app — substitui o prompt "Contexto extra
      // para a nota?" quando a sessão roda headless. Aceito durante a gravação
      // (pré-digitado) e durante o finalizing (janela de 45s da sessão).
      case '/session/context': {
        if (!child || (session.phase !== 'recording' && session.phase !== 'finalizing')) {
          return json(res, 409, { error: 'sem sessão ativa para receber contexto' }, origin);
        }
        if (typeof payload.text !== 'string') {
          return json(res, 400, { error: 'text obrigatório (string; vazia = "sem contexto, prossiga")' }, origin);
        }
        // Empty string is a valid answer: "no context" — ends the 45s finalize window early.
        enqueue({ type: 'context', text: payload.text.trim().slice(0, 8000) });
        return json(res, 200, { ok: true }, origin);
      }

      case '/session/chat': {
        if (!child) return json(res, 409, { error: 'não gravando' }, origin);
        const message = typeof payload.message === 'string' ? payload.message.trim() : '';
        if (!message) return json(res, 400, { error: 'message obrigatória' }, origin);

        const id = `c${++chatSeq}-${Date.now()}`;
        let settled = false;
        const deliver = (reply: string | null) => {
          if (settled) return;
          settled = true;
          pendingChats.delete(id);
          if (reply === null) return json(res, 504, { error: 'sessão não respondeu no tempo' }, origin);
          return json(res, 200, { reply }, origin);
        };
        const timer = setTimeout(() => deliver(null), CHAT_TIMEOUT_MS);
        pendingChats.set(id, { deliver, timer });
        enqueue({ type: 'chat', id, message });
        return;
      }

      default:
        return json(res, 404, { error: 'not found' }, origin);
    }
  }

  async function handleInternal(req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<void> {
    // Long-poll: held open until the app enqueues something (or 25s elapse).
    if (route === '/internal/chat-queue' && req.method === 'GET') {
      if (session.chatQueue.length > 0) {
        const items = session.chatQueue.splice(0, session.chatQueue.length);
        return json(res, 200, { items });
      }
      let settled = false;
      const waiter = (items: QueueItem[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        queueWaiters.delete(waiter);
        json(res, 200, { items });
      };
      const timer = setTimeout(() => waiter([]), QUEUE_POLL_TIMEOUT_MS);
      queueWaiters.add(waiter);
      res.on('close', () => { settled = true; clearTimeout(timer); queueWaiters.delete(waiter); });
      return;
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

    let payload: any;
    try { payload = await readBody(req); } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }

    switch (route) {
      case '/internal/transcript': {
        if (!Array.isArray(payload.lines)) return json(res, 400, { error: 'lines must be an array' });
        const lines: TranscriptLine[] = payload.lines
          .filter((l: any) => l && typeof l.text === 'string')
          .map((l: any) => ({
            ts: Number.isFinite(l.ts) ? Math.round(l.ts) : 0,
            speaker: typeof l.speaker === 'string' ? l.speaker : '',
            text: String(l.text).slice(0, 4000),
          }));
        for (const line of lines) {
          session.transcript.push(line);
          broadcast(session.sseTranscript, sseEvent('line', line));
        }
        return json(res, 200, { ok: true, total: session.transcript.length });
      }

      case '/internal/insight': {
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (!text.trim()) return json(res, 400, { error: 'text obrigatório' });
        const item = { ts: Number.isFinite(payload.ts) ? Math.round(payload.ts) : session.elapsedSec, text };
        session.insights.push(item);
        broadcast(session.sseInsights, sseEvent('insight', item));
        return json(res, 200, { ok: true });
      }

      case '/internal/state': {
        if (typeof payload.phase === 'string' && ['idle', 'recording', 'finalizing'].includes(payload.phase)) {
          session.phase = payload.phase as Phase;
        }
        if (typeof payload.title === 'string' && payload.title.trim()) session.title = payload.title.trim();
        if (Number.isFinite(payload.elapsedSec)) session.elapsedSec = Math.round(payload.elapsedSec);
        return json(res, 200, { ok: true });
      }

      case '/internal/chat-reply': {
        const pending = payload.id ? pendingChats.get(String(payload.id)) : undefined;
        if (!pending) return json(res, 404, { error: 'pergunta desconhecida ou expirada' });
        clearTimeout(pending.timer);
        pending.deliver(typeof payload.reply === 'string' ? payload.reply : '');
        return json(res, 200, { ok: true });
      }

      default:
        return json(res, 404, { error: 'not found' });
    }
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(chalk.red(`Porta ${port} já em uso — outro daemon rodando? (meeting daemon --port <n>)`));
      process.exit(1);
    }
    throw err;
  });

  clearBridge();  // stale file from a crashed daemon would confuse the next session

  server.listen(port, '127.0.0.1', () => {
    logLine(chalk.bold('\n  Meeting Daemon') + chalk.gray(` — escutando em http://127.0.0.1:${port}`)
      + (headless ? chalk.gray(' (headless)') : ''));
    logLine(chalk.gray('  Aguardando a extensão do browser sinalizar entrada em uma call...'));
    logLine(chalk.gray('  Ctrl+C para encerrar.\n'));
  });

  process.on('SIGINT', () => {
    if (child) {
      // Let the recording session handle its own shutdown; just stop accepting new calls
      requestBridgeStop();
      logLine(chalk.yellow('\n  Sinalizando parada para a sessão ativa...'));
      setTimeout(() => process.exit(0), 5000);
    } else {
      clearBridge();
      process.exit(0);
    }
  });
}
