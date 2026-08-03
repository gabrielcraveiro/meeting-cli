import { useCallback, useEffect, useRef, useState } from 'react';
import { AnswerView } from '../components/AnswerView';
import { BriefingCard } from '../components/BriefingCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { DocIcon, PlusIcon, TerminalIcon } from '../components/Icons';
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
};

export function Home({
  status,
  offline,
  launcher,
  search,
  onOpenNote,
  onEnterSession,
  onOpenDaemon,
}: Props) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    const [m, n] = await Promise.allSettled([api.meetingsToday(), api.notesRecent(20)]);
    if (m.status === 'fulfilled') setMeetings(m.value);
    else setMeetings([]);
    if (n.status === 'fulfilled') setNotes(n.value);
    else {
      setNotes([]);
      setError(friendlyError(n.reason));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ao terminar uma gravação, a lista de recentes tem uma nota nova
  useEffect(() => {
    if (status?.phase === 'idle') void load();
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
        <SearchBar
          ref={inputRef}
          value={search.query}
          onChange={search.setQuery}
          onAsk={() => search.ask(search.query)}
          onClear={search.clear}
        />
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
          <BriefingCard />

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
            <h2 className="group-label">Hoje</h2>
            {meetings === null ? (
              <p className="muted pad">Carregando agenda…</p>
            ) : meetings.length === 0 ? (
              <p className="muted pad">Nada na agenda (ou ICS não configurado).</p>
            ) : (
              <ul className="agenda">
                {meetings.map((mt, i) => {
                  const live =
                    !!status?.recording &&
                    !!recordingTitle &&
                    mt.title.toLowerCase().includes(recordingTitle.toLowerCase());
                  return (
                    <li key={`${mt.startIso}-${i}`}>
                      <button
                        className={`agenda-item ${live ? 'is-live' : ''}`}
                        onClick={live ? onEnterSession : undefined}
                      >
                        <span className={`dot ${live ? 'dot-live' : ''}`} aria-hidden />
                        <span className="agenda-time">{hhmm(mt.startIso)}</span>
                        <span className="agenda-title">{mt.title}</span>
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
                    <button className="note-item" onClick={() => onOpenNote(n, 'idle')}>
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
