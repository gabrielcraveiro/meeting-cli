import { useCallback, useEffect, useRef, useState } from 'react';
import { AnswerView } from '../components/AnswerView';
import { BriefingCard } from '../components/BriefingCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { ChecklistIcon, ChevronIcon, DocIcon, LayersIcon, PlusIcon, SparkIcon, TerminalIcon } from '../components/Icons';
import { SearchBar } from '../components/SearchBar';
import { SearchResults } from '../components/SearchResults';
import { api, friendlyError, type Meeting, type NoteSummary, type Status } from '../lib/api';
import { hhmm, participantsLabel, relativeDay } from '../lib/format';
import type { DaemonLauncher } from '../hooks/useDaemonLauncher';
import type { VaultSearch, VaultView } from '../hooks/useVaultSearch';

type Props = {
  status: Status | null;
  offline: boolean;
  launcher: DaemonLauncher;
  search: VaultSearch;
  onOpenNote: (note: NoteSummary, from: VaultView) => void;
  onEnterSession: () => void;
  onOpenDaemon: () => void;
  onOpenChat: () => void;
  onOpenTasks: () => void;
  onOpenTopics: () => void;
};

export function Home({
  status,
  offline,
  launcher,
  search,
  onOpenNote,
  onEnterSession,
  onOpenDaemon,
  onOpenChat,
  onOpenTasks,
  onOpenTopics,
}: Props) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  /** vencidas no vault — badge do ícone de Tarefas */
  const [overdueCount, setOverdueCount] = useState(0);
  /** menu de contexto (botão direito) sobre uma nota de Recentes */
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number; note: NoteSummary } | null>(null);

  useEffect(() => {
    if (!noteMenu) return;
    const close = () => setNoteMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close, { capture: true, once: true });
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close, { capture: true } as EventListenerOptions);
    };
  }, [noteMenu]);

  const deleteNote = async (n: NoteSummary) => {
    setNoteMenu(null);
    if (!window.confirm(`Deletar "${n.title || n.file}"?\nA nota vai para a lixeira do vault (.trash) — recuperável no Obsidian.`)) return;
    try {
      await api.noteDelete(n.file);
      setNotes((prev) => (prev ? prev.filter((x) => x.file !== n.file) : prev));
    } catch (err) {
      setError(friendlyError(err));
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** deslocamento da agenda em dias: 0 = hoje, -1 = ontem, +1 = amanhã… */
  const [dayOffset, setDayOffset] = useState(0);
  const [agendaNudge, setAgendaNudge] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      setNotes(await api.notesRecent(20));
    } catch (err) {
      setNotes([]);
      setError(friendlyError(err));
    }
  }, []);

  // Agenda do dia escolhido — hoje usa o cache quente do daemon; outros dias
  // consultam por data e cada evento vem com a nota da call casada.
  useEffect(() => {
    let alive = true;
    setMeetings(null);
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    const dateStr = d.toLocaleDateString('sv').slice(0, 10);
    const fetchAgenda = dayOffset === 0 ? api.meetingsToday() : api.meetingsForDay(dateStr);
    fetchAgenda
      .then((m) => alive && setMeetings(m))
      .catch(() => alive && setMeetings([]));
    return () => { alive = false; };
  }, [dayOffset, agendaNudge]);

  useEffect(() => {
    void load();
    // Badge de vencidas: busca fora do caminho crítico da Home (best-effort)
    api
      .tasksOpen()
      .then((r) => {
        const today = new Date().toLocaleDateString('sv').slice(0, 10);
        setOverdueCount((r.tasks ?? []).filter((t) => !!t.due && t.due < today).length);
      })
      .catch(() => {});
  }, [load]);

  // ao terminar uma gravação, a lista de recentes e a agenda ganham nota nova
  useEffect(() => {
    if (status?.phase === 'idle') {
      void load();
      setAgendaNudge((n) => n + 1);
    }
  }, [status?.phase, load]);

  // Ctrl/Cmd+K foca a busca; Esc fora do input também sai do modo busca
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (e.key === 'Escape' && search.view !== 'idle') {
        e.preventDefault();
        search.clear();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [search.view, search.clear]);

  const startManual = async () => {
    setStarting(true);
    setError(null);
    try {
      await api.start();
      onEnterSession();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setStarting(false);
    }
  };

  const recordingTitle = status?.recording ? status.title?.trim() : undefined;
  const view = search.view;

  return (
    <div className="screen home">
      <div className="search-slot">
        <div className="search-row">
          <SearchBar
            ref={inputRef}
            value={search.query}
            onChange={search.setQuery}
            onAsk={() => search.ask(search.query)}
            onClear={search.clear}
          />
          <button
            className="btn-ghost chat-entry"
            onClick={onOpenChat}
            title="Chat multi-turno com o vault"
            aria-label="Abrir chat"
          >
            <SparkIcon />
          </button>
          <button
            className="btn-ghost chat-entry"
            onClick={onOpenTopics}
            title="Notas macro por tema"
            aria-label="Abrir temas"
          >
            <LayersIcon />
          </button>
          <button
            className="btn-ghost chat-entry tasks-entry"
            onClick={onOpenTasks}
            title={overdueCount > 0 ? `Tarefas — ${overdueCount} vencida(s)` : 'Tarefas abertas de todas as reuniões'}
            aria-label="Abrir tarefas"
          >
            <ChecklistIcon />
            {overdueCount > 0 && <span className="tasks-badge">{overdueCount}</span>}
          </button>
        </div>
      </div>

      {view === 'results' && (
        <SearchResults
          query={search.query}
          results={search.results}
          searching={search.searching}
          error={search.searchError}
          onAsk={() => search.ask(search.query)}
          onOpen={(r) =>
            onOpenNote(
              { file: r.file, title: r.title, date: r.date, participants: [], tags: [] },
              'results',
            )
          }
        />
      )}

      {view === 'answer' && (
        <AnswerView
          question={search.question}
          asking={search.asking}
          answer={search.answer}
          error={search.answerError}
          onBack={search.backFromAnswer}
          onRetry={search.retryAsk}
          onOpenSource={(s) =>
            onOpenNote(
              { file: s.file, title: s.title, date: '', participants: [], tags: [] },
              'answer',
            )
          }
        />
      )}

      {view === 'idle' && (
        <>
          <BriefingCard
            onOpen={(file, title) =>
              onOpenNote({ file, title, date: '', participants: [], tags: [] }, 'idle')
            }
          />

          {offline &&
            (launcher.starting ? (
              <ErrorBanner message="Iniciando daemon…" />
            ) : (
              <ErrorBanner
                message={launcher.error ?? 'Daemon offline — nada de agenda nem notas.'}
                actionLabel="Iniciar daemon"
                onAction={() => void launcher.start()}
              />
            ))}
          {!offline && error && <ErrorBanner message={error} onRetry={load} />}

          <section className="group">
            <div className="agenda-nav">
              <button
                className="agenda-nav-btn"
                onClick={() => setDayOffset((d) => d - 1)}
                aria-label="Dia anterior"
              >
                <ChevronIcon size={13} className="chev-left" />
              </button>
              <h2 className="group-label agenda-nav-label">
                {dayOffset === 0
                  ? 'Hoje'
                  : dayOffset === -1
                    ? 'Ontem'
                    : dayOffset === 1
                      ? 'Amanhã'
                      : new Date(Date.now() + dayOffset * 86_400_000).toLocaleDateString('pt-BR', {
                          weekday: 'short',
                          day: '2-digit',
                          month: '2-digit',
                        })}
              </h2>
              <button
                className="agenda-nav-btn"
                onClick={() => setDayOffset((d) => d + 1)}
                aria-label="Próximo dia"
              >
                <ChevronIcon size={13} />
              </button>
              {dayOffset !== 0 && (
                <button className="agenda-today" onClick={() => setDayOffset(0)}>
                  hoje
                </button>
              )}
            </div>
            {meetings === null ? (
              <p className="muted pad">Carregando agenda…</p>
            ) : meetings.length === 0 ? (
              <p className="muted pad">
                {dayOffset === 0 ? 'Nada na agenda (ou ICS não configurado).' : 'Nada na agenda deste dia.'}
              </p>
            ) : (
              <ul className="agenda">
                {meetings.map((mt, i) => {
                  const live =
                    dayOffset === 0 &&
                    !!status?.recording &&
                    !!recordingTitle &&
                    mt.title.toLowerCase().includes(recordingTitle.toLowerCase());
                  const note = mt.note ?? null;
                  const clickable = live || !!note;
                  return (
                    <li key={`${mt.startIso}-${i}`}>
                      <button
                        className={`agenda-item ${live ? 'is-live' : ''} ${note ? 'has-note' : ''}`}
                        onClick={
                          live
                            ? onEnterSession
                            : note
                              ? () =>
                                  onOpenNote(
                                    { file: note.file, title: note.title, date: '', participants: [], tags: [] },
                                    'idle',
                                  )
                              : undefined
                        }
                        title={note ? `Abrir nota: ${note.title}` : undefined}
                        disabled={!clickable}
                      >
                        <span className={`dot ${live ? 'dot-live' : ''}`} aria-hidden />
                        <span className="agenda-time">{hhmm(mt.startIso)}</span>
                        <span className="agenda-title">{mt.title}</span>
                        {note && (
                          <span className="agenda-note-glyph" aria-label="Reunião tem nota">
                            <DocIcon size={13} />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="group">
            <h2 className="group-label">Recentes</h2>
            {notes === null ? (
              <p className="muted pad">Carregando notas…</p>
            ) : notes.length === 0 ? (
              <p className="muted pad">Nenhuma nota no vault ainda.</p>
            ) : (
              <ul className="notes">
                {notes.map((n) => (
                  <li key={n.file}>
                    <button
                      className="note-item"
                      onClick={() => onOpenNote(n, 'idle')}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setNoteMenu({ x: e.clientX, y: e.clientY, note: n });
                      }}
                    >
                      <span className="note-glyph" aria-hidden>
                        <DocIcon />
                      </span>
                      <span className="note-text">
                        <span className="note-title">{n.title || n.file}</span>
                        <span className="note-meta">
                          {relativeDay(n.date)}
                          {n.participants.length > 0 &&
                            ` · ${participantsLabel(n.participants)}`}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {noteMenu && (
            <div
              className="ctx-menu"
              style={{ left: Math.min(noteMenu.x, window.innerWidth - 150), top: Math.min(noteMenu.y, window.innerHeight - 90) }}
              role="menu"
            >
              <button
                role="menuitem"
                onClick={() => {
                  setNoteMenu(null);
                  onOpenNote(noteMenu.note, 'idle');
                }}
              >
                Abrir
              </button>
              <button
                role="menuitem"
                className="ctx-menu-danger"
                onClick={() => void deleteNote(noteMenu.note)}
              >
                Deletar…
              </button>
            </div>
          )}

          <footer className="home-footer">
            <button className="btn-primary" onClick={startManual} disabled={starting || offline}>
              <PlusIcon />
              {starting ? 'Iniciando…' : 'Nota manual'}
            </button>
            <button
              className="btn-ghost"
              title="Daemon e log"
              aria-label="Daemon"
              onClick={onOpenDaemon}
            >
              <TerminalIcon />
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
