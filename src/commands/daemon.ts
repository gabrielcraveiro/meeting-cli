import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import { writeBridge, updateBridgeParticipants, updateBridgeSpeech, updateBridgeSharing, updateBridgeTitle, requestBridgeStop, clearBridge, readBridge, SpeechSpan } from '../services/bridge';
import { notifyWindows } from '../services/notify';
import { loadConfig, saveConfig, Config } from '../config';
import { parseFrontmatter } from '../services/storage';
import { getUpcomingMeetings, getMeetingsForDay, CalendarEvent } from '../services/calendar';
import { refreshIfStale, search as searchVault, searchRelated as searchVaultRelated, tokenize as tokenizeVault, distinctiveTerms } from '../services/vaultIndex';
import { askVault } from '../services/claudeQuery';
import { askVaultFast } from '../services/quickAsk';
import { addGlossaryEntry, loadGlossary } from '../services/glossary';
import { generatePrepNote, isIgnoredMeeting, archiveStalePreps } from '../services/prep';
import { listOpenTasks, closeSingleTask } from '../services/taskCloser';
import { chatWithMeetings } from '../services/organizer';
import { buildTopicNote, listTopics, suggestTopics } from '../services/topicNotes';

// `meeting daemon` — HTTP bridge for the browser extension AND for the desktop app.
// Listens on localhost and spawns `meeting start --browser` when the extension
// reports that a call started. The recording TUI takes over this terminal;
// when the session ends the daemon resumes listening.
//
// The daemon also holds the LIVE SESSION STATE in memory (transcript, insights,
// user notes, chat queue) so the app can read the running meeting without
// touching disk. Contract: docs/app-api.md. State dies with the daemon.

const DEFAULT_PORT = 7899;
const CONFIG_DIR = path.join(os.homedir(), '.config', 'meeting-cli');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
const DAEMON_LOG_FILE = path.join(CONFIG_DIR, 'daemon.log');
const SSE_HEARTBEAT_MS = 15_000;
const CHAT_TIMEOUT_MS = 60_000;
const ENHANCE_TIMEOUT_MS = 120_000;
const QUEUE_POLL_TIMEOUT_MS = 25_000;
const MEETINGS_CACHE_MS = 5 * 60 * 1000;
/** Teto do handler /ask — folga sobre o timeout interno do claude (3 min). */
const ASK_TIMEOUT_MS = 3.5 * 60 * 1000;
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
  | { type: 'enhance'; id: string }
  | { type: 'note'; ts: number; text: string }
  | { type: 'context'; text: string };

interface LogLine { line: string; at: number }

interface SessionState {
  title?: string;
  phase: Phase;
  /** Identidade da sessão — muda a cada call. O app usa para resetar estado
   * por sessão (insights, cards) quando uma call emenda na outra. */
  key: number;
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
    key: Date.now(),
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
  const startedAt = Date.now();
  // mtime do binário no momento do boot: o app/`meeting daemon status` comparam com o
  // mtime atual do arquivo pra detectar "processo antigo rodando código velho".
  let binMtime = 0;
  try { binMtime = Math.floor(fs.statSync(cliPath).mtimeMs); } catch {}

  let session = emptySession();
  // Troca de reunião: a call nova chega enquanto a anterior ainda finaliza a
  // nota. Guardamos o /start e BUFFERIZAMOS legendas/roster da call nova até o
  // filho sair — como legendas são o transcript primário, nada se perde.
  let pendingStart: StartPayload | null = null;
  let pendingSpans: SpeechSpan[] = [];
  let pendingParticipants: string[] = [];
  // Cancelamento manual (stop pelo app com reason:'user'): a extensão continua
  // vendo a call e pode redetectá-la — o mesmo título fica bloqueado pra
  // auto-start até o TTL vencer. Título diferente grava normal.
  const DISMISS_TTL_MS = 3 * 60 * 60 * 1000;
  let dismissed: { title: string; until: number } | null = null;
  // Pausa global (toggle do app): enquanto true, nenhuma call detectada pela
  // extensão é gravada. Inicializa do config (sobrevive a restart) e é a
  // fonte-da-verdade em memória — o /recording-toggle atualiza aqui e persiste.
  let recordingPaused = loadConfig()?.recordingPaused ?? false;
  // Sufixo entre parênteses fora da comparação: o Teams alterna
  // "Reunião (Externo)" ↔ "Reunião" na MESMA call — a graça de reconexão e o
  // bloqueio de regravação precisam tratá-los como o mesmo título.
  const normTitle = (t: string | undefined | null) =>
    (t ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  // Lame-duck stop: call/transcrição pode CAIR e voltar em ~1 min (rejoin do
  // Teams, rede). Ao receber CALL_ENDED da extensão, esperamos GRACE antes de
  // finalizar — se a MESMA call reaparecer, a sessão segue e a nota não fatia
  // (caso real: reunião da NF virou 2 notas, 13:46 + 13:51). Na reconexão, a
  // extensão zera o buffer de legendas e o relógio — carry + offset preservam
  // o que veio antes da queda com os tempos corrigidos.
  const STOP_GRACE_MS = 75_000;
  let graceStop: NodeJS.Timeout | null = null;
  let graceTitle = '';
  let speechCarry: SpeechSpan[] = [];
  let speechOffset = 0;
  function clearGrace(): void {
    if (graceStop) { clearTimeout(graceStop); graceStop = null; }
    graceTitle = '';
  }
  // Presença do app desktop (lastAppSeen abaixo): extensão só auto-grava com
  // app "vivo" (config autoRecordRequiresApp, default true) — mais controlável.
  // 5 min, NÃO segundos: com a janela oculta no tray, o WebView2 estrangula os
  // timers do app para ~1/min (background throttling) — janela de 10s marcava
  // "app fechado" com o app ABERTO e calls reais foram ignoradas (17/08).
  const APP_ALIVE_MS = 5 * 60_000;
  /** último toast "call ignorada, app fechado" — throttle de 30min */
  let lastOfflineNudge = 0;
  /** último alerta "legendas mortas na call" — throttle de 10min */
  let lastCaptionsStaleNudge = 0;
  /** single-flight da geração de tema — evita duas chamadas simultâneas */
  let topicBuilding = false;
  /** "fio da meada" da call atual — computado 1x por sessão (luna) */
  let callCtxCache: { key: number; value: string | null } | null = null;
  /** App chat questions waiting for the session to answer via /internal/chat-reply. */
  const pendingChats = new Map<string, { deliver: (reply: string | null) => void; timer: NodeJS.Timeout }>();
  /** Sessions long-polling /internal/chat-queue, released as soon as an item shows up. */
  const queueWaiters = new Set<(items: QueueItem[]) => void>();
  let chatSeq = 0;
  /** Single-flight de POST /ask — uma pergunta agêntica por vez (custa dinheiro). */
  let askInFlight = false;

  // ── Preparação pré-reunião ───────────────────────────────────────────
  // Última vez que uma requisição do app (Tauri) chegou — o loop de prep só
  // roda com o app aberto (senão o usuário nem vê o toast/nota gerados).
  let lastAppSeen = 0;
  /** Single-flight do gerador de prep — evita duas notas em paralelo se o timer atrasar. */
  let preppingNow = false;
  /** `${title}|${startIso}` já preparados nesta execução do daemon — evita duplicar a nota. */
  const preppedEvents = new Set<string>();

  function resetSession(title?: string): void {
    clearGrace();          // timer de graça de uma sessão nunca vaza pra próxima
    speechCarry = [];
    speechOffset = 0;
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
      if (pendingStart) {
        const next = pendingStart;
        const spans = pendingSpans;
        if (pendingParticipants.length > 0) next.participants = pendingParticipants;
        pendingStart = null;
        pendingSpans = [];
        pendingParticipants = [];
        startSession(next);
        if (spans.length > 0) updateBridgeSpeech(spans);
        logLine(chalk.green(`  ⏭ Call em fila iniciada${spans.length ? ` (${spans.length} falas preservadas do buffer)` : ''}`));
      }
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

  // Origem da extensão é PINADA na primeira vez (TOFU) e persistida: aceitar
  // qualquer `moz-extension://` deixava QUALQUER extensão do browser conversar
  // com o daemon — ler notas (conteúdo corporativo sensível), apagá-las,
  // iniciar gravação e gastar chamadas de IA. O UUID do Firefox é sorteado por
  // instalação, então não dá para embutir no código: pina-se o primeiro visto.
  const EXT_PIN_FILE = path.join(CONFIG_DIR, 'extension-origin.json');
  let pinnedExtOrigin: string | null | undefined;  // undefined = ainda não lido

  function readPinnedOrigin(): string | null {
    if (pinnedExtOrigin !== undefined) return pinnedExtOrigin;
    const fromConfig = cfg()?.extensionOrigin;
    if (fromConfig) return (pinnedExtOrigin = fromConfig);
    try {
      const saved = JSON.parse(fs.readFileSync(EXT_PIN_FILE, 'utf-8'))?.origin;
      pinnedExtOrigin = typeof saved === 'string' && saved ? saved : null;
    } catch {
      pinnedExtOrigin = null;
    }
    return pinnedExtOrigin;
  }

  let lastExtRejectNudge = 0;
  function isExtensionOriginTrusted(origin: string): boolean {
    const pinned = readPinnedOrigin();
    if (!pinned) {
      pinnedExtOrigin = origin;
      try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(EXT_PIN_FILE, JSON.stringify({ origin, pinnedAt: Date.now() }, null, 2));
      } catch {}
      logLine(chalk.cyan(`  🔒 Extensão confiada (fixada): ${origin}`));
      return true;
    }
    if (pinned === origin) return true;
    // Reinstalar a extensão troca o UUID no Firefox — falha silenciosa aqui
    // sairia caro (gravação para de acontecer sem aviso). Avisa e ensina.
    if (Date.now() - lastExtRejectNudge > 10 * 60_000) {
      lastExtRejectNudge = Date.now();
      notifyWindows(
        '⚠ Extensão não reconhecida',
        'Uma extensão diferente tentou falar com o Meeting. Se você reinstalou a extensão, apague extension-origin.json em ~/.config/meeting-cli e reinicie o daemon.',
      );
    }
    logLine(chalk.yellow(`  ⚠ Extensão recusada (esperada ${pinned}): ${origin}`));
    return false;
  }

  function isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;   // no Origin header = local tool (curl), not a browser
    if (origin === 'null') return false;     // sandboxed iframe / file:// — untrusted
    if (APP_ORIGINS.has(origin)) {
      lastAppSeen = Date.now();  // usado pelo loop de prep pré-reunião: só roda com o app aberto
      return true;
    }
    if (origin.startsWith('moz-extension://') || origin.startsWith('chrome-extension://')) {
      return isExtensionOriginTrusted(origin);
    }
    return false;
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

    // Nomes começam com "YYYY-MM-DD HH-mm" — ordenar por nome já é ordenar por
    // data. Só os `limit` mais recentes são abertos, e só o head do arquivo
    // (frontmatter) é lido: em vault no /mnt/c (drvfs lento), ler 96 notas
    // inteiras (transcrições de 40KB+) a cada Home segurava a tela em
    // "carregando notas".
    const newest = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit * 2);  // folga: nomes fora do padrão de data caem pro fim

    const notes = newest
      .map(fileName => {
        try {
          const fd = fs.openSync(path.join(dir, fileName), 'r');
          const buf = Buffer.alloc(4096);
          const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          const meta = parseFrontmatter(buf.toString('utf-8', 0, bytes));
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

  /** Casa um evento da agenda com a nota da reunião: mesmo dia + horário do
   * arquivo (YYYY-MM-DD HH-mm) a até 30min do início do evento. */
  function matchNoteForEvent(config: Config, dateStr: string, evStart: Date): { file: string; title: string } | null {
    const dir = path.join(config.vaultPath, 'Meetings');
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter(f =>
        f.endsWith('.md') && f.startsWith(dateStr) && !f.includes('(prep)'));
    } catch { return null; }
    const evMin = evStart.getHours() * 60 + evStart.getMinutes();
    let best: { file: string; title: string; diff: number } | null = null;
    for (const f of files) {
      const m = f.match(/^\d{4}-\d{2}-\d{2} (\d{2})-(\d{2}) - (.+)\.md$/);
      if (!m) continue;
      const diff = Math.abs(+m[1] * 60 + +m[2] - evMin);
      if (diff <= 30 && (!best || diff < best.diff)) {
        best = { file: `Meetings/${f}`, title: m[3], diff };
      }
    }
    return best ? { file: best.file, title: best.title } : null;
  }

  /** Agenda de um dia qualquer (navegação ‹ ›), com nota casada por evento.
   * Cache curto por data — dia passado não muda, mas nota nova pode chegar. */
  const dayMeetingsCache = new Map<string, { at: number; data: unknown[] }>();
  async function meetingsForDayCached(dateStr: string): Promise<unknown[]> {
    const cached = dayMeetingsCache.get(dateStr);
    if (cached && Date.now() - cached.at < 2 * 60_000) return cached.data;
    const config = cfg();
    if (!config?.icsUrl) return [];
    const [y, mo, d] = dateStr.split('-').map(Number);
    let events: CalendarEvent[] = [];
    try {
      events = await getMeetingsForDay(config.icsUrl, new Date(y, mo - 1, d));
    } catch {
      return cached?.data ?? [];
    }
    const data = events.map(e => ({
      title: e.title,
      startIso: e.start.toISOString(),
      endIso: e.end.toISOString(),
      attendees: e.attendees,
    }));
    dayMeetingsCache.set(dateStr, { at: Date.now(), data });
    return data;
  }

  /** Casa a nota de cada evento NA HORA DE SERVIR (nunca no cache): o arquivo
   * placeholder vira nota definitiva com outro nome minutos depois da call, e
   * um match cacheado apontaria pra arquivo morto. Evento cancelado não casa. */
  function attachNotes(events: unknown[]): unknown[] {
    const config = cfg();
    if (!config) return events;
    return (events as Array<{ title: string; startIso: string }>).map(e => {
      if (/^cancelad/i.test(e.title.trim())) return { ...e, note: null };
      const start = new Date(e.startIso);
      const dateStr = start.toLocaleDateString('sv').slice(0, 10);
      return { ...e, note: matchNoteForEvent(config, dateStr, start) };
    });
  }
  async function meetingsToday(): Promise<unknown[]> {
    if (meetingsCache && Date.now() - meetingsCache.at < MEETINGS_CACHE_MS) return meetingsCache.data;
    // Stale-while-revalidate: com cache vencido, devolve o velho NA HORA e
    // atualiza em background — a Home nunca espera o download do ICS do
    // Outlook (segundos), que era o "carregando agenda" após cada call.
    if (meetingsCache) {
      void refreshMeetingsCache();
      return meetingsCache.data;
    }
    return refreshMeetingsCache();
  }

  let refreshingMeetings = false;
  async function refreshMeetingsCache(): Promise<unknown[]> {
    if (refreshingMeetings) return meetingsCache?.data ?? [];
    refreshingMeetings = true;
    try {
      const config = cfg();
      if (!config?.icsUrl) return [];

      const now = new Date();
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      const windowHours = Math.max(0.5, (endOfDay.getTime() - now.getTime()) / 3_600_000);

      let events: CalendarEvent[] = [];
      try {
        events = await getUpcomingMeetings(config.icsUrl, windowHours);
      } catch {
        return meetingsCache?.data ?? [];  // calendar is best-effort — never fail the app over it
      }
      // Nota NÃO entra no cache: notas nascem/renomeiam mais rápido que a
      // agenda muda (placeholder → nota organizada) — o casamento é feito na
      // hora de SERVIR, em attachNotes().
      const data = events.map(e => ({
        title: e.title,
        startIso: e.start.toISOString(),
        endIso: e.end.toISOString(),
        attendees: e.attendees,
      }));
      meetingsCache = { at: Date.now(), data };
      return data;
    } finally {
      refreshingMeetings = false;
    }
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
    if (origin && APP_ORIGINS.has(origin)) lastAppSeen = Date.now();

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
          recordingPaused,
          title: session.title,
          sessionKey: session.key,
          elapsedSec: session.elapsedSec,
          sharing: bridge?.sharing === true,
          phase: child !== null ? session.phase : 'idle',
          pid: process.pid,
          headless,
          startedAt,
          binMtime,
        }, origin);
      }

      case '/meetings/today': {
        // ?date=YYYY-MM-DD navega a agenda por dia (passado incluso); cada
        // evento vem com a NOTA da reunião casada por horário, quando existe.
        const dateParam = parsed.searchParams.get('date');
        if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
          return json(res, 200, attachNotes(await meetingsForDayCached(dateParam)), origin);
        }
        return json(res, 200, attachNotes(await meetingsToday()), origin);
      }

      case '/glossary': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        return json(res, 200, { entries: loadGlossary(config) }, origin);
      }

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

      // Busca léxica no vault (índice em memória, sem IA e sem custo).
      case '/search': {
        const q = (parsed.searchParams.get('q') || '').trim();
        if (!q) return json(res, 400, { error: 'q obrigatório' }, origin);
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        const limit = Math.min(50, Math.max(1, parseInt(parsed.searchParams.get('limit') || '20') || 20));
        refreshIfStale(config);
        return json(res, 200, { results: searchVault(q, limit) }, origin);
      }

      // Agregado dos action items abertos de TODAS as notas de reunião —
      // alimenta a tela de tarefas do app.
      case '/tasks/open': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        return json(res, 200, { tasks: listOpenTasks(config) }, origin);
      }

      // Prep da reunião ATUAL (nota "(prep)" gerada 10min antes): o app usa
      // como esqueleto inicial do notepad quando a call começa. Casa por
      // título-base OU por horário (evento até 40min atrás / 15min à frente).
      case '/session/prep': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        if (!child) return json(res, 409, { error: 'não gravando' }, origin);
        const dir = path.join(config.vaultPath, 'Meetings');
        const today = new Date().toLocaleDateString('sv').slice(0, 10);
        let files: string[] = [];
        try {
          files = fs.readdirSync(dir).filter(f => f.startsWith(today) && f.endsWith('(prep).md'));
        } catch { return json(res, 404, { error: 'sem prep' }, origin); }
        const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
        const sessTitle = normTitle(session.title);
        let best: { file: string; score: number } | null = null;
        for (const f of files) {
          const m = f.match(/^\d{4}-\d{2}-\d{2} (\d{2})-(\d{2}) - (.+) \(prep\)\.md$/);
          if (!m) continue;
          const evMin = +m[1] * 60 + +m[2];
          const delta = nowMin - evMin;                 // >0 = evento já começou
          const timeOk = delta >= -15 && delta <= 40;
          const titleOk = !!sessTitle && normTitle(m[3]) === sessTitle;
          if (!timeOk && !titleOk) continue;
          const score = (titleOk ? 100 : 0) - Math.abs(delta);
          if (!best || score > best.score) best = { file: f, score };
        }
        if (!best) return json(res, 404, { error: 'sem prep' }, origin);
        const markdown = fs.readFileSync(path.join(dir, best.file), 'utf-8');
        return json(res, 200, { file: `Meetings/${best.file}`, markdown }, origin);
      }

      // Pauta sugerida DURANTE a call — redesenhada após uso real ("vem tasks
      // nada a ver"): o protagonista agora é o CONTEXTO ("fio da meada" das
      // reuniões anteriores do MESMO tema, gerado 1x por sessão via luna e
      // cacheado); tarefas só entram se topicais E de alguém presente.
      case '/session/pauta': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        if (!child) return json(res, 409, { error: 'não gravando' }, origin);

        const participants = (readBridge()?.participants ?? []).map(p => p.trim()).filter(Boolean);
        const firsts = new Set(participants.map(p => p.split(/\s+/)[0].toLowerCase()));
        const today = new Date().toLocaleDateString('sv').slice(0, 10);
        // Relevância > completude, em TRÊS réguas (aprendidas no uso real):
        //  1. recência — nota >21 dias é débito antigo (briefing/faxina), não pauta;
        //  2. teto de 3 por dono — backlog de uma pessoa não monopoliza o card;
        //  3. AFINIDADE DE TEMA — tarefa de terceiro só entra se compartilhar
        //     assunto com o título da call (call "crise" não recebe cobrança
        //     sobre "acessos do Valter" só porque o dono está presente).
        //     As SUAS vencidas dispensam tema: são lembrete pessoal.
        const cutoff = new Date(Date.now() - 21 * 86_400_000).toLocaleDateString('sv').slice(0, 10);
        // Termos DISTINTIVOS (mesma régua da busca estrita): sem isso, palavra
        // comum do vault ("epharma", "reunião") casava qualquer tarefa e o card
        // virava lista aleatória quando o tema não tinha histórico.
        refreshIfStale(config);
        const titleTokens = new Set(distinctiveTerms(session.title ?? ''));
        const isTopical = (text: string) =>
          titleTokens.size > 0 && tokenizeVault(text).some(tok => titleTokens.has(tok));
        const perOwner = new Map<string, number>();
        const hints = listOpenTasks(config)
          .filter(t => {
            if (t.noteDate && t.noteDate < cutoff) return false;     // velha demais pra pauta
            const ownerFirst = t.owner?.trim().split(/\s+/)[0]?.toLowerCase();
            // SÓ topical + de alguém presente. As "suas vencidas" saíram daqui
            // de propósito: entravam sem filtro de tema e eram a maior fonte
            // de ruído — elas já vivem no briefing e no badge de Tarefas.
            if (ownerFirst && firsts.has(ownerFirst)) {
              if (!isTopical(`${t.text} ${t.noteTitle}`)) return false;
              const n = perOwner.get(ownerFirst) ?? 0;
              if (n >= 3) return false;
              perOwner.set(ownerFirst, n + 1);
              return true;                                           // pendência recente E do assunto
            }
            if (t.mine && isTopical(`${t.text} ${t.noteTitle}`)) return true;  // sua E do assunto
            return false;
          })
          .slice(0, 6);
        void today;

        const relatedHits = (session.title ? searchVaultRelated(session.title, 8) : [])
          .filter(r => !/\(prep\)/.test(r.file))
          .filter(r => isTopical(r.title));  // busca fraca não vira "relacionada"
        const related = relatedHits
          .slice(0, 3)
          .map(r => ({ file: r.file, title: r.title, date: r.date }));

        // "Fio da meada": resumo de onde o TEMA parou nas reuniões anteriores.
        // 1x por sessão (cache por session.key); luna, ~5s, centavos.
        let context: string | null = null;
        if (callCtxCache && callCtxCache.key === session.key) {
          context = callCtxCache.value;
        } else if (relatedHits.length > 0) {
          try {
            const blocks: string[] = [];
            for (const h of relatedHits.slice(0, 4)) {
              try {
                const raw = fs.readFileSync(path.join(config.vaultPath, h.file), 'utf-8');
                const body = raw.split('## Transcricao')[0].replace(/^---[\s\S]*?---\n/, '').slice(0, 3500);
                if (body.trim()) blocks.push(`### ${h.title} (${h.date})\n${body}`);
              } catch {}
            }
            if (blocks.length > 0) {
              context = (await chatWithMeetings([
                { role: 'system', content:
                  'Voce prepara o "fio da meada" para uma reuniao que esta COMECANDO AGORA, a partir ' +
                  'das notas de reunioes anteriores fornecidas. Escreva NO MAXIMO 4 bullets de 1 linha ' +
                  'cada, PT-BR: onde a conversa parou / ultima decisao; o que ficou explicitamente em ' +
                  'aberto; o que provavelmente sera retomado hoje. Use SOMENTE notas do MESMO assunto ' +
                  'do titulo da reuniao — ignore nota que so compartilha uma palavra solta. ' +
                  'Sem preambulo, sem headers, so os bullets.' },
                { role: 'user', content: `Reuniao comecando agora: "${session.title ?? ''}"\n\n# Notas anteriores\n${blocks.join('\n\n')}` },
              ], config)).trim() || null;
            }
          } catch {
            context = null;  // contexto é best-effort — o card degrada pra tasks/links
          }
          callCtxCache = { key: session.key, value: context };
        }

        return json(res, 200, { context, tasks: hints, related }, origin);
      }

      // Notas macro por tema (Temas/): lista + sugestões de cluster. Tudo
      // local — nenhuma chamada de modelo aqui.
      case '/topics': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        return json(res, 200, { topics: listTopics(config), suggestions: suggestTopics(config) }, origin);
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
      case '/recording-toggle': {
        // Liga/desliga a pausa global. Atualiza a flag em memória (efeito
        // imediato, sem esperar o cache de cfg()) e persiste no config.json.
        const paused = payload?.paused === true;
        recordingPaused = paused;
        try {
          const current = loadConfig();
          if (current) saveConfig({ ...current, recordingPaused: paused });
          cachedConfig = null;  // invalida o cache pra próxima leitura refletir
        } catch (err) {
          logLine(chalk.yellow(`  ⚠ Não consegui persistir recordingPaused: ${err}`));
        }
        logLine(paused
          ? chalk.yellow('  ⏸ Gravação automática PAUSADA — nenhuma call será gravada até religar')
          : chalk.green('  ▶ Gravação automática RELIGADA'));
        return json(res, 200, { ok: true, recordingPaused }, origin);
      }

      case '/start': {
        // Gravação automática (extensão) só com o app desktop aberto — o app
        // renova lastAppSeen a cada poll de /status (~3s). Start manual (app,
        // curl, CLI) passa sempre. Desligável via autoRecordRequiresApp: false.
        const fromExtension = !!origin && /^(moz|chrome)-extension:/.test(origin);
        // Pausa global ligada: ignora a auto-gravação da extensão. Start manual
        // (app/CLI) passa — clicar "gravar" é intenção explícita, escape hatch.
        if (fromExtension && recordingPaused) {
          logLine(chalk.gray(`  ⏸ Gravação pausada${payload?.title ? ` — "${payload.title}"` : ''} não será gravada (religue no app)`));
          return json(res, 200, { ok: true, ignored: 'recording-paused' }, origin);
        }
        if (fromExtension && (cfg()?.autoRecordRequiresApp ?? true)
            && Date.now() - lastAppSeen > APP_ALIVE_MS) {
          logLine(chalk.gray(`  ⏸ Call detectada${payload?.title ? ` ("${payload.title}")` : ''} mas o app está fechado — gravação automática ignorada`));
          // Ignorar em silêncio custou 3 calls num dia — avisa (com throttle).
          if (Date.now() - lastOfflineNudge > 30 * 60_000) {
            lastOfflineNudge = Date.now();
            notifyWindows(
              '⏸ Call detectada — Meeting fechado',
              `${payload?.title ? `"${payload.title}" ` : ''}não será gravada. Abra o app Meeting para gravar automaticamente.`,
            );
          }
          return json(res, 200, { ok: true, ignored: 'app-offline' }, origin);
        }
        // Call cancelada manualmente pelo usuário: a extensão pode redetectar a
        // MESMA reunião (você parou a gravação mas continua na call) — não
        // regrava. Título diferente = call nova de verdade, grava normal.
        const startTitle = normTitle(typeof payload.title === 'string' ? payload.title : '');
        // Reconexão dentro da janela de graça: mesma call voltou — cancela o
        // stop pendente e a gravação segue na MESMA nota. As legendas de antes
        // da queda entram no carry (a extensão zera buffer e relógio ao
        // reconectar; o offset realinha os tempos novos ao relógio da sessão).
        if (graceStop && child && startTitle && startTitle === graceTitle) {
          clearGrace();
          speechCarry = (readBridge()?.speech ?? []).filter(sp => sp.text && sp.text.trim());
          speechOffset = session.elapsedSec;
          logLine(chalk.green(`  🔁 "${payload.title}" reconectou — gravação continua na mesma nota (${speechCarry.length} falas preservadas)`));
          return json(res, 200, { ok: true, resumed: true }, origin);
        }
        if (graceStop) {
          // Call DIFERENTE chegou durante a graça: finaliza a antiga já.
          clearGrace();
          requestBridgeStop();
        }
        // Título de VIEW do Teams = detecção falsa (ex.: botão "Sair" do convite
        // na tela de Calendário, sem call nenhuma). Nunca é reunião real.
        const VIEW_TITLES = /^(calendar|calend[aá]rio|chat|activity|atividade|teams|equipes|calls?|chamadas?|files|arquivos)$/;
        if (fromExtension && VIEW_TITLES.test(startTitle)) {
          logLine(chalk.gray(`  ⏸ "${payload.title}" é tela do Teams, não call — detecção ignorada`));
          return json(res, 200, { ok: true, ignored: 'view-title' }, origin);
        }
        if (dismissed && startTitle && startTitle === dismissed.title && Date.now() < dismissed.until) {
          logLine(chalk.gray(`  ⏸ "${payload.title}" foi cancelada pelo usuário — ignorando redetecção`));
          return json(res, 200, { ok: true, ignored: 'user-cancelled' }, origin);
        }
        if (child) {
          // Troca de reunião: a anterior ainda está finalizando. Enfileira a
          // nova e apressa a antiga; o exit do filho dispara a próxima sessão.
          pendingStart = payload;
          pendingSpans = [];
          pendingParticipants = Array.isArray(payload.participants)
            ? payload.participants.map((p: unknown) => String(p).trim()).filter(Boolean)
            : [];
          requestBridgeStop();
          logLine(chalk.yellow(`  ⏭ Nova call na fila${payload?.title ? `: ${payload.title}` : ''} — aguardando a nota da anterior`));
          return json(res, 200, { ok: true, queued: true }, origin);
        }
        startSession(payload);
        return json(res, 200, { ok: true }, origin);
      }

      case '/participants': {
        if (!Array.isArray(payload.participants)) {
          return json(res, 400, { error: 'participants must be an array' }, origin);
        }
        if (pendingStart) {
          for (const p of payload.participants) {
            const name = String(p).trim();
            if (name && !pendingParticipants.includes(name)) pendingParticipants.push(name);
          }
          return json(res, 200, { ok: true, buffered: true, total: pendingParticipants.length }, origin);
        }
        const state = updateBridgeParticipants(payload.participants);
        return json(res, 200, { ok: true, total: state.participants.length }, origin);
      }

      case '/sharing':
        updateBridgeSharing(payload.active === true);
        return json(res, 200, { ok: true }, origin);

      // Constrói/atualiza a nota macro de um tema. UMA chamada ao luna, e
      // incremental: sem nota nova, responde skipped sem gastar nada.
      case '/topics/build': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        const topic = typeof payload.topic === 'string' ? payload.topic.trim() : '';
        if (topic.length < 3 || topic.length > 60) {
          return json(res, 400, { error: 'topic deve ter 3-60 caracteres' }, origin);
        }
        if (topicBuilding) return json(res, 409, { error: 'já existe um tema sendo gerado' }, origin);
        topicBuilding = true;
        try {
          const r = await buildTopicNote(config, topic);
          logLine(r.skipped
            ? chalk.gray(`  ≡ tema "${topic}" já estava atualizado (0 chamadas)`)
            : chalk.green(`  ✚ tema "${topic}" atualizado com ${r.added} nota(s)`));
          if (!r.skipped) {
            notifyWindows(`✅ Tema atualizado: ${topic}`,
              `${r.added} nota(s) incorporada(s) — clique para abrir`,
              `meeting://note?file=${encodeURIComponent(r.file)}`);
          }
          return json(res, 200, r, origin);
        } catch (err) {
          logLine(chalk.red(`  ✗ tema "${topic}" falhou: ${(err as Error).message}`));
          return json(res, 500, { error: (err as Error).message }, origin);
        } finally {
          topicBuilding = false;
        }
      }

      // Edição de nota pelo app (modo ✎ no leitor). Escrita atômica via tmp +
      // rename: o Obsidian pode estar com o arquivo aberto e o vault vive num
      // drvfs lento — meia-escrita corromperia a nota.
      case '/notes/save': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        const file = typeof payload.file === 'string' ? payload.file : '';
        const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';
        const target = file ? resolveInVault(file) : null;
        if (!target || !target.endsWith('.md') || !fs.existsSync(target)) {
          return json(res, 404, { error: 'nota não encontrada' }, origin);
        }
        if (!markdown.trim()) return json(res, 400, { error: 'conteúdo vazio' }, origin);
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, markdown, 'utf-8');
        fs.renameSync(tmp, target);
        logLine(chalk.green(`  ✎ nota salva: ${path.basename(target)} (${markdown.length} chars)`));
        return json(res, 200, { ok: true }, origin);
      }

      // Deleção de nota pelo app (botão direito → Deletar, com confirmação lá).
      // Nunca apaga de verdade: move pra .trash/ do vault, padrão do Obsidian —
      // recuperável a qualquer momento.
      case '/notes/delete': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        const file = typeof payload.file === 'string' ? payload.file : '';
        const target = file ? resolveInVault(file) : null;
        if (!target || !target.endsWith('.md') || !fs.existsSync(target)) {
          return json(res, 404, { error: 'nota não encontrada' }, origin);
        }
        const trashDir = path.join(config.vaultPath, '.trash');
        fs.mkdirSync(trashDir, { recursive: true });
        let dest = path.join(trashDir, path.basename(target));
        if (fs.existsSync(dest)) dest = path.join(trashDir, `${Date.now()}-${path.basename(target)}`);
        fs.renameSync(target, dest);
        logLine(chalk.yellow(`  🗑 nota movida pra .trash: ${path.basename(target)}`));
        return json(res, 200, { ok: true }, origin);
      }

      // Correção de termo direto na nota (dicionário retroativo): troca todas
      // as ocorrências do termo errado no arquivo — o glossário cuida das
      // PRÓXIMAS transcrições, isto conserta a nota que já existe.
      case '/notes/replace': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        const file = typeof payload.file === 'string' ? payload.file : '';
        const from = typeof payload.from === 'string' ? payload.from.trim() : '';
        const to = typeof payload.to === 'string' ? payload.to.trim() : '';
        if (!file || from.length < 2 || from.length > 60 || !to || to.length > 60) {
          return json(res, 400, { error: 'file, from (2-60 chars) e to (1-60) obrigatórios' }, origin);
        }
        const target = resolveInVault(file);
        if (!target || !target.endsWith('.md') || !fs.existsSync(target)) {
          return json(res, 404, { error: 'nota não encontrada' }, origin);
        }
        const raw = fs.readFileSync(target, 'utf-8');
        const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(esc, 'gi');
        const replaced = (raw.match(re) || []).length;
        if (replaced > 0) fs.writeFileSync(target, raw.replace(re, to), 'utf-8');
        logLine(chalk.green(`  ✎ nota corrigida: "${from}" → "${to}" (${replaced}x em ${path.basename(target)})`));
        return json(res, 200, { ok: true, replaced }, origin);
      }

      // Checkbox da tela de tarefas: flip validado `- [ ]` → `- [x] … ✅ hoje`.
      // Mesmas validações duras do fechamento proposto pelo organizador.
      case '/tasks/close': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        const file = typeof payload.file === 'string' ? payload.file : '';
        const line = typeof payload.line === 'string' ? payload.line : '';
        if (!file || !line) return json(res, 400, { error: 'file e line obrigatórios' }, origin);
        const today = new Date().toLocaleDateString('sv').slice(0, 10);
        const ok = closeSingleTask(config, file, line, today);
        if (!ok) return json(res, 409, { error: 'tarefa não encontrada (nota mudou?) — recarregue a lista' }, origin);
        logLine(chalk.green(`  ☑ tarefa concluída: ${line.slice(0, 80)}`));
        return json(res, 200, { ok: true }, origin);
      }

      // Legendas mortas durante a gravação (extensão detectou 60s+ sem fala na
      // TELA da call): alerta o usuário — com a política anti-Deepgram, legenda
      // desligada é o único jeito de perder conteúdo. Toast + marcador no
      // transcript ao vivo do app. Throttle de 10min (silêncio real existe).
      case '/captions-stale': {
        if (!child) return json(res, 200, { ok: true, note: 'not recording' }, origin);
        const sinceSec = Number.isFinite(payload.sinceSec) ? Math.round(payload.sinceSec) : 0;
        logLine(chalk.yellow(`  ⚠ legendas sem atividade há ${sinceSec}s — extensão tentando reativar`));
        if (Date.now() - lastCaptionsStaleNudge > 10 * 60_000) {
          lastCaptionsStaleNudge = Date.now();
          notifyWindows(
            '⚠ Legendas do Teams sem atividade',
            `Há ${sinceSec}s sem legenda na call — confira se as legendas (CC) continuam ligadas. O áudio segue gravado.`,
          );
          const marker = {
            ts: session.elapsedSec,
            speaker: '',
            text: `⚠ Legendas sem atividade há ${sinceSec}s — confira o CC no Teams (áudio segue gravado; Deepgram assume se persistir)`,
          };
          session.transcript.push(marker);
          broadcast(session.sseTranscript, sseEvent('line', marker));
        }
        return json(res, 200, { ok: true }, origin);
      }

      // Correção de título mid-session: a extensão descobriu o título real da
      // reunião (o inicial era nome de participante raspado do document.title).
      case '/title': {
        const title = typeof payload.title === 'string' ? payload.title.trim() : '';
        if (!title) return json(res, 400, { error: 'title must be a non-empty string' }, origin);
        if (pendingStart) {
          pendingStart.title = title;  // corrige a call em fila, não a que finaliza
          return json(res, 200, { ok: true, buffered: true }, origin);
        }
        updateBridgeTitle(title);
        session.title = title;
        logLine(chalk.gray(`  ✎ Título corrigido: ${title}`));
        return json(res, 200, { ok: true }, origin);
      }

      case '/speech': {
        if (!Array.isArray(payload.spans)) {
          return json(res, 400, { error: 'spans must be an array' }, origin);
        }
        if (pendingStart) {
          // Falas da call NOVA não podem contaminar o bridge que a sessão
          // antiga vai ler no finalize — ficam em buffer até a troca real.
          pendingSpans.push(...(payload.spans as SpeechSpan[]));
          return json(res, 200, { ok: true, buffered: true, total: pendingSpans.length }, origin);
        }
        // Pós-reconexão: preserva as falas de antes da queda e realinha os
        // tempos das novas (o relógio da extensão zerou; o da sessão, não).
        const incoming = (payload.spans as SpeechSpan[]);
        const merged = speechCarry.length > 0 || speechOffset > 0
          ? [
              ...speechCarry,
              ...incoming.map(sp => ({ ...sp, start: sp.start + speechOffset, end: sp.end + speechOffset })),
            ]
          : incoming;
        updateBridgeSpeech(merged);
        return json(res, 200, { ok: true, total: merged.length }, origin);
      }

      case '/stop': {
        // Stop manual (app, reason:'user') com a call ainda rolando no browser:
        // marca o título pra não regravar quando a extensão redetectar.
        if (payload.reason === 'user') {
          clearGrace();  // stop deliberado ignora a janela de reconexão
          const t = normTitle(readBridge()?.title || session.title);
          if (t) {
            dismissed = { title: t, until: Date.now() + DISMISS_TTL_MS };
            logLine(chalk.gray(`  ⏸ Cancelamento manual — "${t}" não será regravada automaticamente`));
          }
        } else if (child && !pendingStart) {
          // Fim reportado pela extensão: janela de graça — quedas curtas de
          // call/transcrição reconectam sem fatiar a nota.
          if (graceStop) return json(res, 200, { ok: true, note: 'grace pending' }, origin);
          graceTitle = normTitle(readBridge()?.title || session.title);
          logLine(chalk.yellow(`  ⏳ Call terminou no browser — aguardando ${STOP_GRACE_MS / 1000}s por reconexão antes de finalizar`));
          graceStop = setTimeout(() => {
            graceStop = null;
            graceTitle = '';
            requestBridgeStop();
          }, STOP_GRACE_MS);
          return json(res, 200, { ok: true, graceful: true }, origin);
        }
        if (pendingStart) {
          // O usuário também saiu da call que estava na fila.
          pendingStart = null;
          pendingSpans = [];
          pendingParticipants = [];
          logLine(chalk.gray('  ⏭ Call em fila cancelada (usuário saiu)'));
          return json(res, 200, { ok: true, note: 'queued call cancelled' }, origin);
        }
        if (!child) return json(res, 200, { ok: true, note: 'not recording' }, origin);
        requestBridgeStop();
        return json(res, 200, { ok: true }, origin);
      }

      // Glossário de correções de transcrição (meeting-glossario.md no vault).
      // O app manda {from, to} quando o usuário seleciona um termo errado; a
      // correção vale imediatamente (a sessão relê o arquivo por mtime).
      case '/glossary': {
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);
        const from = typeof payload.from === 'string' ? payload.from : '';
        const to = typeof payload.to === 'string' ? payload.to : '';
        try {
          addGlossaryEntry(config, from, to);
          const entries = loadGlossary(config);
          logLine(chalk.gray(`  📖 glossário: "${from.trim()}" -> "${to.trim()}" (${entries.length} termos)`));
          return json(res, 200, { ok: true, entries }, origin);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message }, origin);
        }
      }

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

      // Pergunta ao vault. mode:'fast' (default) = RAG numa chamada ao endpoint
      // de chat (~5-10s); mode:'deep' = claude headless agêntico (~40s, pesquisa
      // iterativa). Independe de gravação. UMA por vez — cada chamada custa dinheiro.
      case '/ask': {
        const question = typeof payload.question === 'string' ? payload.question.trim() : '';
        if (!question) return json(res, 400, { error: 'question obrigatória' }, origin);
        const deep = payload.mode === 'deep';
        if (askInFlight) return json(res, 409, { error: 'pergunta em andamento' }, origin);
        const config = cfg();
        if (!config) return json(res, 404, { error: 'config não encontrada' }, origin);

        // Follow-up multi-turno: só aceita entradas bem formadas — o resto é
        // silenciosamente descartado (o /ask segue funcionando sem histórico).
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = Array.isArray(payload.history)
          ? payload.history
              .filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
              .slice(0, 12)
              .map((h: any) => ({ role: h.role, content: String(h.content).slice(0, 4000) }))
          : [];

        askInFlight = true;
        const startedAt = Date.now();
        logLine(chalk.cyan(`  ❓ /ask${deep ? ' (profundo)' : ''}: ${question.slice(0, 120)}`));

        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          logLine(chalk.yellow(`  ⚠ /ask excedeu ${Math.round(ASK_TIMEOUT_MS / 1000)}s — 504`));
          json(res, 504, { error: 'pergunta excedeu o tempo limite' }, origin);
        }, ASK_TIMEOUT_MS);

        try {
          const answer = deep
            ? await askVault(question, config, history)
            : await askVaultFast(question, config, history);
          const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
          logLine(chalk.cyan(`  ✓ /ask respondida em ${secs}s — $${answer.costUsd.toFixed(4)} — `
            + `${answer.sources.length} fonte(s)`));
          if (settled) return;  // handler já respondeu 504; resposta descartada
          settled = true;
          clearTimeout(timer);
          return json(res, 200, answer, origin);
        } catch (err) {
          logLine(chalk.red(`  ✗ /ask falhou: ${(err as Error).message}`));
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          return json(res, 500, { error: (err as Error).message }, origin);
        } finally {
          askInFlight = false;
        }
      }

      case '/session/chat': {
        if (!child) return json(res, 409, { error: 'não gravando' }, origin);
        if (session.phase === 'finalizing') {
          // A sessão está ocupada gerando a nota e não puxa a fila — responder
          // rápido é melhor UX que deixar o app pendurado 60s até o 504.
          return json(res, 409, { error: 'finalizando a nota — pergunte de novo em ~1 min (ou use a busca do vault)' }, origin);
        }
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

      case '/session/enhance': {
        // Enhance ao vivo (fluxo Granola durante a call): a sessão pega as
        // anotações do usuário + transcript até agora e devolve a prévia
        // aprimorada. Mesma mecânica request/reply do chat.
        if (!child) return json(res, 409, { error: 'não gravando' }, origin);
        const id = `e${++chatSeq}-${Date.now()}`;
        let settled = false;
        const deliver = (reply: string | null) => {
          if (settled) return;
          settled = true;
          pendingChats.delete(id);
          if (reply === null) return json(res, 504, { error: 'sessão não respondeu no tempo' }, origin);
          return json(res, 200, { markdown: reply }, origin);
        };
        const timer = setTimeout(() => deliver(null), ENHANCE_TIMEOUT_MS);
        pendingChats.set(id, { deliver, timer });
        enqueue({ type: 'enhance', id });
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
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port, headless, startedAt }));
    } catch {}
    logLine(chalk.bold('\n  Meeting Daemon') + chalk.gray(` — escutando em http://127.0.0.1:${port}`)
      + (headless ? chalk.gray(' (headless)') : ''));
    logLine(chalk.gray('  Aguardando a extensão do browser sinalizar entrada em uma call...'));
    logLine(chalk.gray('  Ctrl+C para encerrar.\n'));
    resumeOrphanOrganizeJobs();

    // Preps de dias anteriores viram ruído em Recentes/busca — faxina no boot
    // e a cada 6h (vão pra .trash, nunca apagadas de verdade).
    const sweepPreps = () => {
      const config = cfg();
      if (!config) return;
      try {
        const n = archiveStalePreps(config);
        if (n > 0) logLine(chalk.gray(`  🧹 ${n} prep(s) de dias anteriores arquivada(s) em .trash`));
      } catch {}
    };
    sweepPreps();
    setInterval(sweepPreps, 6 * 60 * 60_000).unref?.();
  });

  // Jobs de organização órfãos (worker morreu no meio — restart do daemon,
  // queda do WSL): o job-*.json fica em disco até o worker concluir, então no
  // boot qualquer um parado há >10min é retomado. Notas nunca ficam presas no
  // placeholder "organizando em segundo plano".
  function resumeOrphanOrganizeJobs(): void {
    const jobsDir = path.join(os.homedir(), '.config', 'meeting-cli', 'organize-jobs');
    let jobs: string[] = [];
    try { jobs = fs.readdirSync(jobsDir).filter(f => /^job-.*\.json$/.test(f)); } catch { return; }
    for (const f of jobs) {
      const jobPath = path.join(jobsDir, f);
      try {
        if (Date.now() - fs.statSync(jobPath).mtimeMs < 10 * 60_000) continue;  // worker pode estar vivo
        // renova o mtime ANTES de spawnar — outro boot em <10min não duplica
        fs.utimesSync(jobPath, new Date(), new Date());
        const logFd = fs.openSync(path.join(jobsDir, 'organize.log'), 'a');
        const worker = spawn(process.execPath, [cliPath, 'organize-job', jobPath], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
        });
        worker.unref();
        fs.closeSync(logFd);
        logLine(chalk.yellow(`  ♻ retomando organização órfã: ${f}`));
      } catch {}
    }
  }

  // ── Loop de preparação pré-reunião ───────────────────────────────────
  // A cada 60s: se o app está aberto (heartbeat via Origin nas últimas 5min) e
  // há um icsUrl configurado, olha a agenda e gera a nota de prep pros eventos
  // que começam em até 10min. Best-effort: qualquer erro fica só no log, nunca
  // derruba o daemon.
  const PREP_CHECK_INTERVAL_MS = 60_000;
  const PREP_LOOKAHEAD_MS = 10 * 60_000;
  const APP_SEEN_WINDOW_MS = 5 * 60_000;

  async function runPrepCheck(): Promise<void> {
    const config = cfg();
    if (!config?.icsUrl) return;
    if (Date.now() - lastAppSeen >= APP_SEEN_WINDOW_MS) return;  // requisito: só com o app aberto
    if (preppingNow) return;

    let events: CalendarEvent[];
    try {
      events = await getUpcomingMeetings(config.icsUrl, 1);
    } catch (err) {
      logLine(chalk.yellow(`  ⚠ prep: falha ao ler calendário — ${(err as Error).message}`));
      return;
    }

    const now = Date.now();
    const due = events.filter(e => {
      const startsInMs = e.start.getTime() - now;
      if (startsInMs < 0 || startsInMs > PREP_LOOKAHEAD_MS) return false;
      if (isIgnoredMeeting(e.title, config)) return false;
      return !preppedEvents.has(`${e.title}|${e.start.toISOString()}`);
    });
    if (due.length === 0) return;

    preppingNow = true;
    try {
      for (const event of due) {
        const key = `${event.title}|${event.start.toISOString()}`;
        preppedEvents.add(key);  // marca antes de gerar — nunca tenta a mesma reunião 2x
        try {
          const notePath = await generatePrepNote(config, {
            title: event.title,
            start: event.start,
            attendees: event.attendees,
          });
          if (!notePath) continue;
          logLine(chalk.cyan(`  📋 prep gerado: "${event.title}" — ${notePath}`));
          const noteRelFile = path.relative(config.vaultPath, notePath).replace(/\\/g, '/');
          const appUri = `meeting://note?file=${encodeURIComponent(noteRelFile)}`;
          // O toast pré-reunião carrega as pendências que importam pra ESTA
          // call: dos convidados (match por primeiro nome) + suas vencidas.
          let taskLine = '';
          try {
            const firsts = new Set(event.attendees.map(a => a.trim().split(/\s+/)[0].toLowerCase()).filter(Boolean));
            const today = new Date().toLocaleDateString('sv').slice(0, 10);
            const cutoff = new Date(Date.now() - 21 * 86_400_000).toLocaleDateString('sv').slice(0, 10);
            const relevant = listOpenTasks(config).filter(t => {
              if (t.noteDate && t.noteDate < cutoff) return false;  // débito antigo não é pauta
              const ownerFirst = t.owner?.trim().split(/\s+/)[0]?.toLowerCase();
              if (ownerFirst && firsts.has(ownerFirst)) return true;
              return t.mine && !!t.due && t.due <= today;
            });
            const mineCount = relevant.filter(t => t.mine).length;
            if (relevant.length > 0) {
              taskLine = ` · ${relevant.length} pendência(s) relevante(s)${mineCount ? ` (${mineCount} sua${mineCount > 1 ? 's' : ''})` : ''}`;
            }
          } catch {}
          notifyWindows(
            `📋 Reunião em breve: ${event.title}`,
            `Prep pronto${taskLine} — clique para abrir`,
            appUri,
          );
        } catch (err) {
          logLine(chalk.red(`  ✗ prep falhou para "${event.title}": ${(err as Error).message}`));
        }
      }
    } finally {
      preppingNow = false;
    }
  }

  setInterval(() => { void runPrepCheck(); }, PREP_CHECK_INTERVAL_MS);

  function removePidFile(): void {
    try {
      const info = JSON.parse(fs.readFileSync(PID_FILE, 'utf-8')) as { pid?: number };
      if (info.pid === process.pid) fs.unlinkSync(PID_FILE);
    } catch {}
  }

  function shutdown(): void {
    removePidFile();
    if (child) {
      // Let the recording session handle its own shutdown; just stop accepting new calls
      requestBridgeStop();
      logLine(chalk.yellow('\n  Sinalizando parada para a sessão ativa...'));
      setTimeout(() => process.exit(0), 5000);
    } else {
      clearBridge();
      process.exit(0);
    }
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);  // `meeting daemon stop/restart` derruba via SIGTERM
}

// ---------------------------------------------------------------------------
// Controle do daemon: `meeting daemon status | stop | restart`
// Roda num processo NOVO e conversa com o daemon existente via pidfile + HTTP.
// ---------------------------------------------------------------------------

interface PidInfo { pid: number; port: number; headless: boolean; startedAt: number }

interface StatusInfo {
  recording: boolean; title: string | null; phase: string;
  pid?: number; headless?: boolean; startedAt?: number; binMtime?: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function fetchStatus(port: number): Promise<StatusInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json() as StatusInfo;
  } catch { return null; }
}

/** Descobre o daemon vivo: pidfile primeiro, /status como fallback (pidfile perdido). */
async function findDaemon(port: number): Promise<PidInfo | null> {
  try {
    const info = JSON.parse(fs.readFileSync(PID_FILE, 'utf-8')) as Partial<PidInfo>;
    if (info.pid && isAlive(info.pid)) {
      return { pid: info.pid, port: info.port ?? port, headless: info.headless !== false, startedAt: info.startedAt ?? 0 };
    }
  } catch {}
  const status = await fetchStatus(port);
  if (status?.pid && isAlive(status.pid)) {
    return { pid: status.pid, port, headless: status.headless !== false, startedAt: status.startedAt ?? 0 };
  }
  return null;
}

async function stopDaemon(port: number, force: boolean): Promise<PidInfo | null> {
  const info = await findDaemon(port);
  if (!info) {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return null;
  }
  const status = await fetchStatus(port);
  if (status?.recording && !force) {
    throw new Error(`daemon está GRAVANDO ("${status.title ?? 'reunião'}") — finalize a call ou use --force`);
  }
  process.kill(info.pid, 'SIGTERM');
  for (let i = 0; i < 60 && isAlive(info.pid); i++) await sleep(150);  // sessão ativa leva ~5s
  if (isAlive(info.pid)) process.kill(info.pid, 'SIGKILL');
  try { fs.unlinkSync(PID_FILE); } catch {}
  return info;
}

function spawnDaemonDetached(port: number, headless: boolean): void {
  const cliPath = path.resolve(process.argv[1]);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const out = fs.openSync(DAEMON_LOG_FILE, 'a');
  // process.execPath = node atual — imune ao problema do fnm fora do PATH
  const proc = spawn(process.execPath, [
    cliPath, 'daemon', '-p', String(port), ...(headless ? ['--headless'] : []),
  ], { detached: true, stdio: ['ignore', out, out] });
  proc.unref();
  fs.closeSync(out);
}

export async function cmdDaemonCtl(action: string, opts: { port?: string; force?: boolean } = {}): Promise<void> {
  const port = parseInt(opts.port || '') || DEFAULT_PORT;

  switch (action) {
    case 'status': {
      const status = await fetchStatus(port);
      if (!status) {
        console.log(chalk.yellow(`  Nenhum daemon escutando em 127.0.0.1:${port}.`));
        console.log(chalk.gray('  Inicie com: meeting daemon restart'));
        return;
      }
      const upMin = status.startedAt ? Math.round((Date.now() - status.startedAt) / 60000) : null;
      console.log(chalk.bold('\n  Meeting Daemon'));
      console.log(`  PID ${status.pid}${status.headless ? chalk.gray(' (headless)') : ''}`
        + (upMin !== null ? chalk.gray(` — no ar há ${upMin} min`) : ''));
      console.log(`  Estado: ${status.recording ? chalk.green(`gravando "${status.title}"`) : chalk.gray('ocioso')}`);
      try {
        const currentMtime = Math.floor(fs.statSync(path.resolve(process.argv[1])).mtimeMs);
        if (status.binMtime && currentMtime > status.binMtime) {
          console.log(chalk.yellow('  ⚠ Binário atualizado depois do boot — rode: meeting daemon restart'));
        }
      } catch {}
      console.log();
      return;
    }

    case 'stop': {
      const info = await stopDaemon(port, opts.force === true);
      console.log(info
        ? chalk.green(`  Daemon parado (PID ${info.pid}).`)
        : chalk.gray('  Nenhum daemon rodando.'));
      return;
    }

    case 'restart': {
      const prev = await findDaemon(port);
      const headless = prev ? prev.headless : true;  // padrão moderno: headless (app/tray)
      const stopped = await stopDaemon(port, opts.force === true);
      if (stopped) console.log(chalk.gray(`  Daemon anterior parado (PID ${stopped.pid}).`));
      spawnDaemonDetached(port, headless);
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const status = await fetchStatus(port);
        if (status) {
          console.log(chalk.green(`  Daemon no ar (PID ${status.pid}${headless ? ', headless' : ''}) — http://127.0.0.1:${port}`));
          console.log(chalk.gray(`  Logs: ${DAEMON_LOG_FILE}`));
          return;
        }
      }
      throw new Error(`daemon não subiu em 10s — veja ${DAEMON_LOG_FILE}`);
    }

    default:
      throw new Error(`ação desconhecida "${action}" — use status, stop ou restart`);
  }
}
