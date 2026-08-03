import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { startDaemonHeadless } from '../lib/shell';

/** Quanto tempo esperamos o daemon responder /status depois do spawn. */
const WAIT_MS = 20_000;
const PROBE_MS = 1200;
/** Uma tentativa automática por abertura do app (sessionStorage = por janela). */
const AUTO_KEY = 'meeting.daemon.autoStartTried';

export type DaemonLauncher = {
  /** true enquanto o daemon está subindo (mostre "Iniciando daemon…"). */
  starting: boolean;
  /** mensagem amigável da última falha (null quando tudo bem) */
  error: string | null;
  /** dispara o spawn + retry; resolve true se o daemon respondeu */
  start: () => Promise<boolean>;
};

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Dono do ciclo de vida do daemon do lado do app: sobe em headless via comando
 * Rust e fica sondando /status até o daemon atender (ou desistir em 20s).
 *
 * Auto-start: na PRIMEIRA vez que detectamos offline depois de abrir o app,
 * tentamos subir sozinho uma única vez. Se falhar, o banner com o botão manual
 * assume — nunca entramos em loop de spawn.
 */
export function useDaemonLauncher(offline: boolean, loading: boolean): DaemonLauncher {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    if (busy.current) return false;
    busy.current = true;
    setStarting(true);
    setError(null);

    try {
      await startDaemonHeadless();
    } catch {
      busy.current = false;
      if (alive.current) {
        setStarting(false);
        setError('Não foi possível iniciar o daemon deste app.');
      }
      return false;
    }

    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(PROBE_MS);
      try {
        await api.status();
        busy.current = false;
        if (alive.current) setStarting(false);
        return true;
      } catch {
        /* ainda subindo */
      }
    }

    busy.current = false;
    if (alive.current) {
      setStarting(false);
      setError('O daemon não respondeu em 20s. Tente iniciar de novo.');
    }
    return false;
  }, []);

  useEffect(() => {
    if (loading || !offline || busy.current) return;
    if (sessionStorage.getItem(AUTO_KEY)) return;
    sessionStorage.setItem(AUTO_KEY, '1');
    void start();
  }, [loading, offline, start]);

  return { starting, error, start };
}
