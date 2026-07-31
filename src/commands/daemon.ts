import http from 'http';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import { writeBridge, updateBridgeParticipants, updateBridgeSpeech, updateBridgeSharing, requestBridgeStop, clearBridge } from '../services/bridge';
import { notifyWindows } from '../services/notify';

// `meeting daemon` — HTTP bridge for the browser extension.
// Listens on localhost and spawns `meeting start --browser` when the extension
// reports that a call started. The recording TUI takes over this terminal;
// when the session ends the daemon resumes listening.

const DEFAULT_PORT = 7899;

interface StartPayload {
  title?: string;
  platform?: string;
  url?: string;
  participants?: string[];
  template?: string;
}

export async function cmdDaemon(opts: { port?: string } = {}): Promise<void> {
  const port = parseInt(opts.port || '') || DEFAULT_PORT;
  let child: ChildProcess | null = null;

  const cliPath = path.resolve(process.argv[1]);

  function startSession(payload: StartPayload): void {
    writeBridge({
      title: payload.title,
      platform: payload.platform,
      participants: (payload.participants ?? []).map(p => p.trim()).filter(Boolean),
      stopRequested: false,
      updatedAt: Date.now(),
    });

    // Title reaches the session via the bridge file (read in --browser mode), never
    // via argv — a DOM-scraped title starting with "-" would smuggle flags into commander.
    const args = [cliPath, 'start', '--browser'];
    if (payload.template && /^[a-z0-9_-]+$/i.test(payload.template)) {
      args.push('--template', payload.template);
    }

    console.log(chalk.green(`\n▶ Call detectada${payload.title ? `: ${payload.title}` : ''} — iniciando gravação...\n`));
    notifyWindows('🎙 Meeting CLI — gravando', payload.title || 'Call detectada no browser');
    child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => {
      child = null;
      clearBridge();
      console.log(chalk.gray(`\n  Sessão finalizada (exit ${code ?? 0}). Aguardando próxima call...\n`));
    });
  }

  // CSRF guard: any webpage can fetch() localhost, and browsers always attach an
  // Origin header to cross-origin POSTs. Only extension origins (moz-extension://,
  // chrome-extension://) and origin-less local tools (curl) are allowed — http(s)
  // origins mean a webpage is probing the daemon.
  function isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;   // no Origin header = local tool (curl), not a browser
    if (origin === 'null') return false;     // sandboxed iframe / file:// — untrusted
    return origin.startsWith('moz-extension://') || origin.startsWith('chrome-extension://');
  }

  function json(res: http.ServerResponse, status: number, body: unknown, origin?: string): void {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (origin && isAllowedOrigin(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;  // reflect only trusted extension origins
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;

    if (!isAllowedOrigin(origin)) {
      console.log(chalk.yellow(`  ⚠ Requisição rejeitada de origem não confiável: ${origin}`));
      return json(res, 403, { error: 'forbidden origin' });
    }

    if (req.method === 'OPTIONS') return json(res, 204, {}, origin);

    if (req.method === 'GET' && req.url === '/status') {
      return json(res, 200, { recording: child !== null }, origin);
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, origin);

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
    req.on('end', () => {
      let payload: any = {};
      try { payload = body ? JSON.parse(body) : {}; } catch {
        return json(res, 400, { error: 'invalid JSON' }, origin);
      }

      switch (req.url) {
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

        default:
          return json(res, 404, { error: 'not found' }, origin);
      }
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(chalk.red(`Porta ${port} já em uso — outro daemon rodando? (meeting daemon --port <n>)`));
      process.exit(1);
    }
    throw err;
  });

  clearBridge();  // stale file from a crashed daemon would confuse the next session

  server.listen(port, '127.0.0.1', () => {
    console.log(chalk.bold('\n  Meeting Daemon') + chalk.gray(` — escutando em http://127.0.0.1:${port}`));
    console.log(chalk.gray('  Aguardando a extensão do browser sinalizar entrada em uma call...'));
    console.log(chalk.gray('  Ctrl+C para encerrar.\n'));
  });

  process.on('SIGINT', () => {
    if (child) {
      // Let the recording session handle its own shutdown; just stop accepting new calls
      requestBridgeStop();
      console.log(chalk.yellow('\n  Sinalizando parada para a sessão ativa...'));
      setTimeout(() => process.exit(0), 5000);
    } else {
      clearBridge();
      process.exit(0);
    }
  });
}
