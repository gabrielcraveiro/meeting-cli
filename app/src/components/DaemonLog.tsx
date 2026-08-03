import { useEffect, useRef, useState } from 'react';
import { api, type LogLine } from '../lib/api';
import { subscribeSse } from '../lib/sse';

/** Teto de linhas no DOM — log de daemon cresce sem limite. */
const MAX_LINES = 500;
const POLL_MS = 3000;

/** Aceita `{line, at}`, string crua ou lixo — sempre devolve algo renderizável. */
function toLine(raw: unknown): LogLine | null {
  if (typeof raw === 'string') return raw ? { line: raw } : null;
  if (raw && typeof raw === 'object') {
    const o = raw as { line?: unknown; at?: unknown };
    if (typeof o.line === 'string') {
      const at = typeof o.at === 'number' || typeof o.at === 'string' ? o.at : undefined;
      return at === undefined ? { line: o.line } : { line: o.line, at };
    }
  }
  return null;
}

function toLines(raw: unknown): LogLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(toLine).filter((l): l is LogLine => l !== null);
}

function cap(lines: LogLine[]): LogLine[] {
  return lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines;
}

/** hh:mm:ss de epoch ms (ou ISO) — sem data, o log é sempre "agora". */
function clock(at?: number | string): string {
  if (at === undefined || at === '') return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour12: false });
}

/**
 * Log ao vivo do daemon. Caminho feliz: SSE `/daemon/logs/stream` (snapshot +
 * evento `log`). Se o SSE nunca abrir (daemon antigo sem o endpoint, proxy
 * engraçado), cai para poll de `GET /daemon/logs` a cada 3s.
 */
export function DaemonLog() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [mode, setMode] = useState<'sse' | 'poll'>('sse');
  const [connected, setConnected] = useState(false);
  const [empty, setEmpty] = useState(false);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // ---------------------------------------------------------------- SSE
  useEffect(() => {
    if (mode !== 'sse') return;
    let opened = false;

    const stop = subscribeSse('/daemon/logs/stream', {
      onOpen: () => {
        opened = true;
        setConnected(true);
      },
      onDisconnect: () => {
        setConnected(false);
        // nunca abriu → endpoint provavelmente não existe: vai de poll
        if (!opened) setMode('poll');
      },
      events: {
        snapshot: (data) => {
          const d = data as { lines?: unknown };
          setLines(cap(toLines(d?.lines)));
          setEmpty(true);
        },
        log: (data) => {
          const l = toLine(data);
          if (!l) return;
          setLines((prev) => cap([...prev, l]));
        },
      },
    });

    return stop;
  }, [mode]);

  // --------------------------------------------------------------- poll
  useEffect(() => {
    if (mode !== 'poll') return;
    let alive = true;

    const tick = async () => {
      try {
        const r = await api.daemonLogs();
        if (!alive) return;
        setLines(cap(toLines(r?.lines)));
        setConnected(true);
      } catch {
        if (alive) setConnected(false);
      } finally {
        if (alive) setEmpty(true);
      }
    };

    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mode]);

  // autoscroll só quando o usuário está "colado" no fim (igual ao transcript)
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !pinnedRef.current) return;
    box.scrollTop = box.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    pinnedRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  };

  return (
    <section className="logbox">
      <header className="logbox-head">
        <span>Log do daemon</span>
        {mode === 'poll' && <span className="logbox-mode">poll 3s</span>}
        <span
          className={`conn ${connected ? 'conn-on' : ''}`}
          title={connected ? 'recebendo log' : 'sem conexão com o log'}
        />
      </header>
      <div className="logbox-body" ref={boxRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <p className="muted">
            {empty ? 'Nenhuma linha de log ainda.' : 'Conectando ao log…'}
          </p>
        ) : (
          lines.map((l, i) => {
            const at = clock(l.at);
            return (
              <p className="logline" key={`${i}-${l.at ?? ''}`}>
                {at && <span className="logline-at">{at}</span>}
                <span className="logline-text">{l.line}</span>
              </p>
            );
          })
        )}
      </div>
    </section>
  );
}
