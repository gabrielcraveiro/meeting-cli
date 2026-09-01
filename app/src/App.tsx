import { useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { SideNotes } from './components/SideNotes';
import { mmss } from './lib/format';
import { useDaemonLauncher } from './hooks/useDaemonLauncher';
import { useStatus } from './hooks/useStatus';
import { useVaultSearch, type VaultView } from './hooks/useVaultSearch';
import type { NoteSummary } from './lib/api';
import { ChatScreen } from './screens/ChatScreen';
import { DaemonScreen } from './screens/DaemonScreen';
import { TasksScreen } from './screens/TasksScreen';
import { TopicsScreen } from './screens/TopicsScreen';
import { Home } from './screens/Home';
import { NoteReader } from './screens/NoteReader';
import { NoteSession } from './screens/NoteSession';

/**
 * `from` no leitor guarda a origem (lista normal, resultados de busca,
 * resposta da IA single-shot ou o chat multi-turno) para que "voltar"
 * reencontre a mesma tela.
 */
type Route =
  | { name: 'home' }
  | { name: 'session' }
  | { name: 'daemon' }
  | { name: 'chat' }
  | { name: 'tasks' }
  | { name: 'topics' }
  | { name: 'reader'; note: NoteSummary; from: VaultView | 'chat' | 'tasks' | 'topics' };

export default function App() {
  const { status, offline, loading } = useStatus();
  const launcher = useDaemonLauncher(offline, loading);
  const search = useVaultSearch();
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const wasRecording = useRef(false);
  /** já vimos gravação/finalização desde que entramos na sessão? */
  const sawLive = useRef(false);

  // Layout largo (janela redimensionada): lista de notas na lateral, como um
  // Obsidian enxuto. Abaixo de 900px o app volta a ser a coluna única do tray.
  const [wide, setWide] = useState(() => window.innerWidth >= 900);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Deep link meeting://note?file=… — clique numa notificação do Windows abre
  // o APP direto na nota (o Rust garante a janela visível; aqui roteamos).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/plugin-deep-link').then(({ onOpenUrl }) =>
      onOpenUrl((urls) => {
        for (const raw of urls) {
          try {
            const url = new URL(raw);
            if (url.protocol !== 'meeting:') continue;
            const file = url.searchParams.get('file');
            if (!file) continue;
            const title = file.replace(/^.*\//, '').replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2} - /, '');
            setRoute({
              name: 'reader',
              note: { file, title, date: '', participants: [], tags: [] },
              from: 'idle',
            });
          } catch {
            // URL malformada — ignora
          }
        }
      }).then((u) => { unlisten = u; }),
    ).catch(() => {});
    return () => unlisten?.();
  }, []);

  // gravação começou (por qualquer caminho: extensão, CLI, botão) → abre a Nota.
  // Só puxa pra sessão quem está na Home: se você navegou pro chat/reader/daemon
  // durante a call, a pill de gravação é o caminho de volta — nada de sequestrar
  // a tela no meio de uma pergunta.
  useEffect(() => {
    const rec = !!status?.recording;
    if (rec || status?.phase === 'finalizing') sawLive.current = true;
    if (rec && !wasRecording.current && route.name === 'home') setRoute({ name: 'session' });
    wasRecording.current = rec;
  }, [status?.recording, status?.phase, route.name]);

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
          : route.name === 'chat'
            ? 'Perguntar ao vault'
            : route.name === 'tasks'
              ? 'Tarefas'
              : route.name === 'topics'
                ? 'Temas'
              : 'Meeting';

  // Pill flutuante "gravando" — visível em qualquer tela fora da sessão
  // enquanto uma call roda; um clique volta pra ela sem perder onde você estava.
  const showRecPill =
    route.name !== 'session' && (!!status?.recording || status?.phase === 'finalizing');

  // A lateral acompanha o app em qualquer tela, menos na sessão de gravação
  // (lá a tela inteira é o bloco de notas + transcript).
  const showSide = wide && route.name !== 'session';

  return (
    <div className={`app ${showSide ? 'is-wide' : ''}`}>
      <TitleBar label={label} />
      {showRecPill && (
        <button className="rec-pill" onClick={() => setRoute({ name: 'session' })}>
          <span className="rec-dot" aria-hidden />
          <span className="rec-pill-title">{status?.title || 'Gravando'}</span>
          <span className="rec-pill-time">
            {status?.phase === 'finalizing' ? 'finalizando…' : mmss(status?.elapsedSec ?? 0)}
          </span>
        </button>
      )}
      <div className="app-body">
      {showSide && (
        <SideNotes
          activeFile={route.name === 'reader' ? route.note.file : undefined}
          onOpenNote={(note) => setRoute({ name: 'reader', note, from: 'idle' })}
        />
      )}
      <div className="app-main">
      {route.name === 'home' && (
        <Home
          status={status}
          offline={offline}
          launcher={launcher}
          search={search}
          onOpenNote={(note, from) => setRoute({ name: 'reader', note, from })}
          onEnterSession={() => setRoute({ name: 'session' })}
          onOpenDaemon={() => setRoute({ name: 'daemon' })}
          onOpenChat={() => setRoute({ name: 'chat' })}
          onOpenTasks={() => setRoute({ name: 'tasks' })}
          onOpenTopics={() => setRoute({ name: 'topics' })}
        />
      )}
      {route.name === 'topics' && (
        <TopicsScreen
          onBack={() => setRoute({ name: 'home' })}
          onOpenNote={(note) => setRoute({ name: 'reader', note, from: 'topics' })}
        />
      )}
      {route.name === 'tasks' && (
        <TasksScreen
          onBack={() => setRoute({ name: 'home' })}
          onOpenNote={(note) => setRoute({ name: 'reader', note, from: 'tasks' })}
        />
      )}
      {route.name === 'session' && (
        <NoteSession
          status={status}
          onStopped={() => setRoute({ name: 'home' })}
          onBack={() => setRoute({ name: 'home' })}
          onOpenTasks={() => setRoute({ name: 'tasks' })}
        />
      )}
      {route.name === 'daemon' && (
        <DaemonScreen
          status={status}
          offline={offline}
          launcher={launcher}
          onBack={() => setRoute({ name: 'home' })}
        />
      )}
      {route.name === 'chat' && (
        <ChatScreen
          onBack={() => setRoute({ name: 'home' })}
          onOpenNote={(file) =>
            setRoute({
              name: 'reader',
              note: { file, title: file, date: '', participants: [], tags: [] },
              from: 'chat',
            })
          }
        />
      )}
      {route.name === 'reader' && (
        <NoteReader
          note={route.note}
          onBack={() => {
            if (route.from === 'chat') setRoute({ name: 'chat' });
            else if (route.from === 'tasks') setRoute({ name: 'tasks' });
            else if (route.from === 'topics') setRoute({ name: 'topics' });
            else {
              search.restore(route.from);
              setRoute({ name: 'home' });
            }
          }}
        />
      )}
      </div>
      </div>
    </div>
  );
}
