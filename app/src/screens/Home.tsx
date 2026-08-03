import { useCallback, useEffect, useState } from 'react';
import { BriefingCard } from '../components/BriefingCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { DocIcon, PlusIcon, TerminalIcon } from '../components/Icons';
import { api, friendlyError, type Meeting, type NoteSummary, type Status } from '../lib/api';
import { hhmm, participantsLabel, relativeDay } from '../lib/format';
import type { DaemonLauncher } from '../hooks/useDaemonLauncher';

type Props = {
  status: Status | null;
  offline: boolean;
  launcher: DaemonLauncher;
  onOpenNote: (note: NoteSummary) => void;
  onEnterSession: () => void;
  onOpenDaemon: () => void;
};

export function Home({
  status,
  offline,
  launcher,
  onOpenNote,
  onEnterSession,
  onOpenDaemon,
}: Props) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

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

  return (
    <div className="screen home">
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
                <button className="note-item" onClick={() => onOpenNote(n)}>
                  <span className="note-glyph" aria-hidden>
                    <DocIcon />
                  </span>
                  <span className="note-text">
                    <span className="note-title">{n.title || n.file}</span>
                    <span className="note-meta">
                      {relativeDay(n.date)}
                      {n.participants.length > 0 && ` · ${participantsLabel(n.participants)}`}
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
    </div>
  );
}
