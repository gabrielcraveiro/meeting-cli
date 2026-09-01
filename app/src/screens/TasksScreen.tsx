import { useCallback, useEffect, useState } from 'react';
import { BackIcon } from '../components/Icons';
import { api, friendlyError, type NoteSummary, type OpenTask } from '../lib/api';
import { relativeDay } from '../lib/format';

type Props = {
  onBack: () => void;
  onOpenNote: (note: NoteSummary) => void;
};

const taskKey = (t: OpenTask) => `${t.file}|${t.line}`;
/** tempo do risco no texto antes do item sair da lista */
const CLOSE_ANIM_MS = 450;

/** Agregado dos action items abertos de todas as reuniões. "Com você" vem
 * primeiro (tarefa sem dono = sua, convenção do organizador); delegadas
 * agrupadas por responsável. Marcar o checkbox grava `- [x] … ✅ hoje` na
 * nota de origem — o Obsidian Tasks vê o mesmo estado. */
export function TasksScreen({ onBack, onOpenNote }: Props) {
  const [tasks, setTasks] = useState<OpenTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** flip em andamento — item fica riscado até sair da lista */
  const [closing, setClosing] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.tasksOpen();
      setTasks(r.tasks ?? []);
      setClosing(new Set());
    } catch (err) {
      setTasks([]);
      setError(friendlyError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const close = async (t: OpenTask) => {
    const key = taskKey(t);
    if (closing.has(key)) return;
    setClosing((prev) => new Set(prev).add(key));
    try {
      await api.taskClose(t.file, t.line);
      // risca por um instante, depois sai — feedback antes da remoção
      setTimeout(() => {
        setTasks((prev) => (prev ? prev.filter((x) => taskKey(x) !== key) : prev));
      }, CLOSE_ANIM_MS);
    } catch (err) {
      setError(friendlyError(err));
      setClosing((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const today = new Date().toLocaleDateString('sv').slice(0, 10);
  const mine = (tasks ?? []).filter((t) => t.mine);
  const others = (tasks ?? []).filter((t) => !t.mine);
  const overdueCount = (tasks ?? []).filter((t) => !!t.due && t.due < today).length;

  // Delegadas agrupadas por responsável, quem tem mais tarefas primeiro
  const byOwner = new Map<string, OpenTask[]>();
  for (const t of others) {
    const key = t.owner ?? 'Sem responsável';
    byOwner.set(key, [...(byOwner.get(key) ?? []), t]);
  }
  const ownerGroups = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);

  const renderItem = (t: OpenTask, showOwner: boolean) => {
    const key = taskKey(t);
    const overdue = !!t.due && t.due < today;
    const isClosing = closing.has(key);
    return (
      <li key={key} className={`task-item ${overdue ? 'is-overdue' : ''} ${isClosing ? 'is-closing' : ''}`}>
        <input
          type="checkbox"
          className="task-check"
          checked={isClosing}
          disabled={isClosing}
          onChange={() => void close(t)}
          aria-label={`Concluir: ${t.text}`}
        />
        <div className="task-main">
          <span className="task-text">{t.text}</span>
          <span className="task-meta">
            {t.due && (
              <span className={`task-due ${overdue ? 'is-overdue' : ''}`}>
                {overdue ? '⚠ venceu ' : '📅 '}
                {relativeDay(t.due)}
              </span>
            )}
            {showOwner && t.owner && <span className="task-owner">{t.owner}</span>}
            <button
              className="task-note"
              onClick={() =>
                onOpenNote({
                  file: t.file,
                  title: t.noteTitle,
                  date: t.noteDate,
                  participants: [],
                  tags: [],
                })
              }
              title={t.file}
            >
              {t.noteTitle}
            </button>
          </span>
        </div>
      </li>
    );
  };

  return (
    <div className="screen tasks-screen">
      <header className="chat-head">
        <button className="btn-ghost" onClick={onBack} aria-label="Voltar">
          <BackIcon />
        </button>
        <h1 className="chat-title">Tarefas</h1>
        {tasks !== null && tasks.length > 0 && (
          <span className="tasks-count">
            {tasks.length} abertas{overdueCount > 0 ? ` · ${overdueCount} vencidas` : ''}
          </span>
        )}
      </header>

      <div className="tasks-body">
        {error && <p className="chat-error">{error}</p>}

        {tasks === null ? (
          <p className="muted pad">Varrendo as notas do vault…</p>
        ) : tasks.length === 0 && !error ? (
          <div className="tasks-empty">
            <span className="tasks-empty-glyph" aria-hidden>☀</span>
            <p>Nenhuma tarefa aberta — tudo em dia.</p>
          </div>
        ) : (
          <>
            <section className="task-group">
              <h2 className="task-group-label task-group-mine">
                Com você <span className="task-group-count">{mine.length}</span>
              </h2>
              {mine.length === 0 ? (
                <p className="muted task-group-empty">Nada na sua fila. 🎉</p>
              ) : (
                <ul className="tasks-list">{mine.map((t) => renderItem(t, false))}</ul>
              )}
            </section>

            {ownerGroups.map(([owner, list]) => (
              <section className="task-group" key={owner}>
                <h2 className="task-group-label">
                  {owner} <span className="task-group-count">{list.length}</span>
                </h2>
                <ul className="tasks-list">{list.map((t) => renderItem(t, false))}</ul>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
