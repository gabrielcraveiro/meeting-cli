import { useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { useStatus } from './hooks/useStatus';
import type { NoteSummary } from './lib/api';
import { Home } from './screens/Home';
import { NoteReader } from './screens/NoteReader';
import { NoteSession } from './screens/NoteSession';

type Route =
  | { name: 'home' }
  | { name: 'session' }
  | { name: 'reader'; note: NoteSummary };

export default function App() {
  const { status, offline } = useStatus();
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const wasRecording = useRef(false);

  // gravação começou (por qualquer caminho: extensão, CLI, botão) → abre a Nota
  useEffect(() => {
    const rec = !!status?.recording;
    if (rec && !wasRecording.current) setRoute({ name: 'session' });
    if (!rec && wasRecording.current && status?.phase === 'idle') {
      setRoute({ name: 'home' });
    }
    wasRecording.current = rec;
  }, [status?.recording, status?.phase]);

  const label =
    route.name === 'session'
      ? status?.title || 'Gravando'
      : route.name === 'reader'
        ? route.note.title
        : 'Meeting';

  return (
    <div className="app">
      <TitleBar label={label} />
      {route.name === 'home' && (
        <Home
          status={status}
          offline={offline}
          onOpenNote={(note) => setRoute({ name: 'reader', note })}
          onEnterSession={() => setRoute({ name: 'session' })}
        />
      )}
      {route.name === 'session' && (
        <NoteSession status={status} onStopped={() => setRoute({ name: 'home' })} />
      )}
      {route.name === 'reader' && (
        <NoteReader note={route.note} onBack={() => setRoute({ name: 'home' })} />
      )}
    </div>
  );
}
