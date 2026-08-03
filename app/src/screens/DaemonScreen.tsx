import { useState } from 'react';
import { DaemonLog } from '../components/DaemonLog';
import { BackIcon, StopIcon, TerminalIcon } from '../components/Icons';
import { api, friendlyError, type Status } from '../lib/api';
import { mmss } from '../lib/format';
import type { DaemonLauncher } from '../hooks/useDaemonLauncher';

type Props = {
  status: Status | null;
  offline: boolean;
  launcher: DaemonLauncher;
  onBack: () => void;
};

/**
 * Tela de serviço: estado do daemon + log ao vivo. Não existe "reiniciar" —
 * o daemon não expõe kill; o que dá para fazer daqui é subir (headless) e
 * encerrar uma gravação presa.
 */
export function DaemonScreen({ status, offline, launcher, onBack }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const recording = !!status?.recording;
  const finalizing = status?.phase === 'finalizing';

  const state = offline
    ? { label: 'offline', tone: 'off' }
    : recording
      ? { label: `gravando · ${mmss(status?.elapsedSec ?? 0)}`, tone: 'live' }
      : finalizing
        ? { label: 'finalizando nota', tone: 'live' }
        : { label: 'online', tone: 'on' };

  const stopRecording = async () => {
    if (!window.confirm('Encerrar a gravação em andamento e gerar a nota?')) return;
    setStopping(true);
    setError(null);
    try {
      await api.stop();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="screen daemon">
      <header className="daemon-head">
        <button className="btn-ghost" onClick={onBack} aria-label="Voltar">
          <BackIcon />
        </button>
        <div className="daemon-id">
          <h1 className="daemon-title">Daemon</h1>
          <span className="daemon-port">127.0.0.1:7899</span>
        </div>
        <span className={`daemon-state state-${state.tone}`}>
          <span className="dot-state" aria-hidden />
          {launcher.starting ? 'iniciando…' : state.label}
        </span>
      </header>

      <div className="daemon-actions">
        {offline && (
          <button
            className="btn-primary"
            onClick={() => void launcher.start()}
            disabled={launcher.starting}
          >
            <TerminalIcon />
            {launcher.starting ? 'Iniciando daemon…' : 'Iniciar daemon'}
          </button>
        )}
        {!offline && recording && (
          <button className="btn-danger" onClick={() => void stopRecording()} disabled={stopping}>
            <StopIcon />
            {stopping ? 'Encerrando…' : 'Parar gravação'}
          </button>
        )}
        {!offline && !recording && !finalizing && (
          <p className="muted daemon-hint">
            Daemon de pé. A extensão e a agenda já podem falar com ele.
          </p>
        )}
        {!offline && finalizing && (
          <p className="muted daemon-hint">Gerando a nota final — não feche o daemon.</p>
        )}
      </div>

      {(error || launcher.error) && <p className="daemon-error">{error ?? launcher.error}</p>}

      <DaemonLog />
    </div>
  );
}
