import { useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { useDaemonLauncher } from './hooks/useDaemonLauncher';
import { useStatus } from './hooks/useStatus';
import type { NoteSummary } from './lib/api';
import { DaemonScreen } from './screens/DaemonScreen';
import { Home } from './screens/Home';
import { NoteReader } from './screens/NoteReader';
import { NoteSession } from './screens/NoteSession';

type Route =
  | { name: 'home' }
  | { name: 'session' }
  | { name: 'daemon' }
  | { name: 'reader'; note: NoteSummary };

export default function App() {
  const { status, offline, loading } = useStatus();
  const launcher = useDaemonLauncher(offline, loading);
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const wasRecording = useRef(false);
  /** já vimos gravação/finalização desde que entramos na sessão? */
  const sawLive = useRef(false);

  // gravação começou (por qualquer caminho: extensão, CLI, botão) → abre a Nota
  useEffect(() => {
    const rec = !!status?.recording;
    if (rec || status?.phase === 'finalizing') sawLive.current = true;
    if (rec && !wasRecording.current) setRoute({ name: 'session' });
    wasRecording.current = rec;
  }, [status?.recording, status?.phase]);

  // a nota acabou de ser gerada (phase volta a idle) → Home, que recarrega os
  // recentes. Depende de sawLive para não expulsar quem acabou de abrir a nota
  // manual (o /status leva até 3s para virar `recording`).
  useEffect(() => {
    if (route.name !== 'session') return;
    if (status?.phase === 'idle' && !status.recording && sawLive.current) {
      sawLive.current = false;
      setRoute({ name: 'home' });
    }
  }, [route.name, status?.phase, status?.recording]);

  const label =
    route.name === 'session'
      ? status?.title || 'Gravando'
      : route.name === 'reader'
        ? route.note.title
        : route.name === 'daemon'
          ? 'Daemon'
          : 'Meeting';

  return (
    <div className="app">
      <TitleBar label={label} />
      {route.name === 'home' && (
        <Home
          status={status}
          offline={offline}
          launcher={launcher}
          onOpenNote={(note) => setRoute({ name: 'reader', note })}
          onEnterSession={() => setRoute({ name: 'session' })}
          onOpenDaemon={() => setRoute({ name: 'daemon' })}
        />
      )}
      {route.name === 'session' && (
        <NoteSession status={status} onStopped={() => setRoute({ name: 'home' })} />
      )}
      {route.name === 'daemon' && (
        <DaemonScreen
          status={status}
          offline={offline}
          launcher={launcher}
          onBack={() => setRoute({ name: 'home' })}
        />
      )}
      {route.name === 'reader' && (
        <NoteReader note={route.note} onBack={() => setRoute({ name: 'home' })} />
      )}
    </div>
  );
}
