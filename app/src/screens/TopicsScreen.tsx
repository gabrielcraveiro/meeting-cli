import { useCallback, useEffect, useState } from 'react';
import { BackIcon, PlusIcon } from '../components/Icons';
import { api, friendlyError, type NoteSummary } from '../lib/api';
import { relativeDay } from '../lib/format';

type Props = {
  onBack: () => void;
  onOpenNote: (note: NoteSummary) => void;
};

type Topic = { file: string; title: string; updated: string; sources: number };

/** Notas macro por tema: a fonte única sobre um assunto que se espalhou por
 * dezenas de reuniões. Gerar é 1 chamada ao modelo barato e é incremental —
 * atualizar um tema sem reunião nova custa zero. */
export function TopicsScreen({ onBack, onOpenNote }: Props) {
  const [topics, setTopics] = useState<Topic[] | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ topic: string; notes: number }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.topics();
      setTopics(r.topics ?? []);
      setSuggestions(r.suggestions ?? []);
    } catch (err) {
      setTopics([]);
      setError(friendlyError(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const build = async (topic: string) => {
    if (busy) return;
    setBusy(topic);
    setError(null);
    setMsg(null);
    try {
      const r = await api.topicBuild(topic);
      setMsg(r.skipped
        ? `"${topic}" já estava atualizado — nenhuma chamada gasta.`
        : `"${topic}": ${r.added} nota(s) incorporada(s).`);
      await load();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const open = (t: Topic) =>
    onOpenNote({ file: t.file, title: t.title, date: '', participants: [], tags: [] });

  return (
    <div className="screen tasks-screen">
      <header className="chat-head">
        <button className="btn-ghost" onClick={onBack} aria-label="Voltar">
          <BackIcon />
        </button>
        <h1 className="chat-title">Temas</h1>
      </header>

      <div className="tasks-body">
        {error && <p className="chat-error">{error}</p>}
        {msg && <p className="topic-msg">{msg}</p>}

        {topics === null ? (
          <p className="muted pad">Carregando temas…</p>
        ) : (
          <>
            {topics.length > 0 && (
              <section className="task-group">
                <h2 className="task-group-label task-group-mine">
                  Seus temas <span className="task-group-count">{topics.length}</span>
                </h2>
                <ul className="tasks-list">
                  {topics.map((t) => (
                    <li key={t.file} className="task-item">
                      <div className="task-main">
                        <button className="topic-open" onClick={() => open(t)}>
                          {t.title}
                        </button>
                        <span className="task-meta">
                          {t.sources} reuniõe(s)
                          {t.updated && ` · atualizado ${relativeDay(t.updated)}`}
                        </span>
                      </div>
                      <button
                        className="topic-refresh"
                        onClick={() => void build(t.title)}
                        disabled={!!busy}
                        title="Incorporar reuniões novas (incremental)"
                      >
                        {busy === t.title ? '…' : '↻'}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {suggestions.length > 0 && (
              <section className="task-group">
                <h2 className="task-group-label">
                  Sugestões <span className="task-group-count">{suggestions.length}</span>
                </h2>
                <p className="muted topic-hint">
                  Assuntos que voltaram em várias reuniões e ainda não têm nota macro.
                </p>
                <ul className="tasks-list">
                  {suggestions.map((s) => (
                    <li key={s.topic} className="task-item">
                      <div className="task-main">
                        <span className="task-text">{s.topic}</span>
                        <span className="task-meta">{s.notes} reuniões</span>
                      </div>
                      <button
                        className="topic-create"
                        onClick={() => void build(s.topic)}
                        disabled={!!busy}
                      >
                        {busy === s.topic ? 'gerando…' : <><PlusIcon size={12} /> gerar</>}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {topics.length === 0 && suggestions.length === 0 && !error && (
              <p className="muted pad">
                Nenhum tema ainda — grave algumas reuniões do mesmo assunto e as sugestões aparecem aqui.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
