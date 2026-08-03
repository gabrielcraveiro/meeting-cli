/**
 * EventSource nativo com reconexão controlada.
 *
 * O EventSource já reconecta sozinho em queda de rede, mas NÃO reconecta
 * quando o servidor responde 409 (sessão encerrada) ou fecha o handshake —
 * nesses casos ele dispara `error` com readyState CLOSED. Aqui tratamos os
 * dois casos com backoff.
 */

import { API_BASE } from './api';

export type SseHandlers = {
  /** nome do evento -> handler com o payload já parseado */
  events: Record<string, (data: unknown) => void>;
  onOpen?: () => void;
  /** chamado quando a conexão cai (antes de agendar reconexão) */
  onDisconnect?: () => void;
};

export function subscribeSse(path: string, handlers: SseHandlers): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    es = new EventSource(`${API_BASE}${path}`);

    es.onopen = () => {
      attempt = 0;
      handlers.onOpen?.();
    };

    for (const [name, fn] of Object.entries(handlers.events)) {
      es.addEventListener(name, (ev) => {
        const raw = (ev as MessageEvent).data;
        if (!raw) return;
        try {
          fn(JSON.parse(raw));
        } catch {
          // linha não-JSON (heartbeat, por ex.): ignora
        }
      });
    }

    es.onerror = () => {
      if (closed) return;
      // readyState CONNECTING = o próprio EventSource vai retentar
      if (es && es.readyState === EventSource.CONNECTING) return;
      es?.close();
      es = null;
      handlers.onDisconnect?.();
      const delay = Math.min(1000 * 2 ** attempt, 15000);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    es?.close();
    es = null;
  };
}
