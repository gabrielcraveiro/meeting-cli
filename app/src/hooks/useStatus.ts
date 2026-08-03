import { useEffect, useRef, useState } from 'react';
import { api, type Status } from '../lib/api';

const POLL_MS = 3000;

export type StatusState = {
  status: Status | null;
  offline: boolean;
  /** true até a primeira resposta (evita piscar "offline" na abertura) */
  loading: boolean;
  refresh: () => void;
};

/** Poll de /status a cada 3s — fonte única de verdade do estado da sessão. */
export function useStatus(): StatusState {
  const [status, setStatus] = useState<Status | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const misses = useRef(0);
  const tick = useRef(0);
  const [nudge, setNudge] = useState(0);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();

    const poll = async () => {
      try {
        const s = await api.status(ctrl.signal);
        if (!alive) return;
        misses.current = 0;
        setStatus(s);
        setOffline(false);
      } catch {
        if (!alive) return;
        misses.current += 1;
        // tolera uma falha isolada antes de declarar offline
        if (misses.current >= 2) setOffline(true);
      } finally {
        if (alive) setLoading(false);
      }
    };

    void poll();
    tick.current = window.setInterval(poll, POLL_MS);

    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(tick.current);
    };
  }, [nudge]);

  return { status, offline, loading, refresh: () => setNudge((n) => n + 1) };
}
