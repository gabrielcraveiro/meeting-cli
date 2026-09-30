import { useCallback, useEffect, useState } from 'react';
import { BackIcon } from '../components/Icons';
import { api, friendlyError, type NoteSummary, type OpenTask, type OpenTopic } from '../lib/api';
import { relativeDay } from '../lib/format';

type Props = {
  onBack: () => void;
  onOpenNote: (note: NoteSummary) => void;
};

const taskKey = (t: { file: string; line: string }) => `${t.file}|${t.line}`;
const NO_THEME = 'Sem tema';

type Tab = 'assuntos' | 'acoes';
/** tempo do risco no texto antes do item sair da lista */
const CLOSE_ANIM_MS = 450;
/** Tarefa de reunião com mais de 14 dias e sem prazo pela frente quase sempre
 * já foi feita (ou morreu) sem ninguém marcar. Ela sai da lista principal e vai
 * para "Antigas", onde dá para fechar tudo de uma vez. Não somem do vault. */
const STALE_DAYS = 14;

function isStale(t: OpenTask, today: string, cutoff: string): boolean {
  const upcoming = !!t.due && t.due >= today;
  return !upcoming && !!t.noteDate && t.noteDate < cutoff;
}

/** Pendências de todas as reuniões, em duas abas.
 * - Assuntos (padrão): o que ficou sem desfecho, agrupado por tema. É o que
 *   o usuário acompanha de fato — assunto atravessa reuniões, action solta não.
 * - Minhas ações: action items. "Com você" primeiro; delegadas antigas (de
 *   antes do organizador parar de criá-las) agrupadas por responsável.
 * Marcar o checkbox grava `- [x] … ✅ hoje` na nota de origem — o Obsidian
 * vê o mesmo estado. */
export function TasksScreen({ onBack, onOpenNote }: Props) {
  const [tab, setTab] = useState<Tab>('assuntos');
  const [tasks, setTasks] = useState<OpenTask[] | null>(null);
  const [topics, setTopics] = useState<OpenTopic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** flip em andamento — item fica riscado até sair da lista */
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const [showStale, setShowStale] = useState(false);
  /** 1º clique arma, 2º confirma — fechar em lote grava em várias notas */
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, t] = await Promise.all([
        api.tasksOpen(),
        // daemon antigo não tem a rota: sem assuntos, a aba de ações segue
        api.openTopics().catch(() => ({ topics: [] as OpenTopic[] })),
      ]);
      setTasks(r.tasks ?? []);
      setTopics(t.topics ?? []);
      setClosing(new Set());
    } catch (err) {
      setTasks([]);
      setTopics([]);
      setError(friendlyError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const close = async (t: { file: string; line: string }) => {
    const key = taskKey(t);
    if (closing.has(key)) return;
    setClosing((prev) => new Set(prev).add(key));
    try {
      await api.taskClose(t.file, t.line);
      // risca por um instante, depois sai — feedback antes da remoção
      setTimeout(() => {
        setTasks((prev) => (prev ? prev.filter((x) => taskKey(x) !== key) : prev));
        setTopics((prev) => (prev ? prev.filter((x) => taskKey(x) !== key) : prev));
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
  const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toLocaleDateString('sv').slice(0, 10);
  const stale = (tasks ?? []).filter((t) => isStale(t, today, cutoff));
  const fresh = (tasks ?? []).filter((t) => !isStale(t, today, cutoff));
  const mine = fresh.filter((t) => t.mine);
  const others = fresh.filter((t) => !t.mine);
  const overdueCount = fresh.filter((t) => !!t.due && t.due < today).length;

  const closeAllStale = async () => {
    if (!confirmBulk) {
      setConfirmBulk(true);
      return;
    }
    setConfirmBulk(false);
    setBulkBusy(true);
    // Uma por vez: cada fechamento reescreve uma nota no vault (drvfs lento), e
    // em paralelo duas tarefas da mesma nota brigariam pelo mesmo arquivo.
    for (const t of stale) await close(t);
    setBulkBusy(false);
  };

  // Delegadas agrupadas por responsável, quem tem mais tarefas primeiro
  const byOwner = new Map<string, OpenTask[]>();
  for (const t of others) {
    const key = t.owner ?? 'Sem responsável';
    byOwner.set(key, [...(byOwner.get(key) ?? []), t]);
  }
  const ownerGroups = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);

  // Assuntos por tema (o primeiro da nota); tema com mais assuntos primeiro,
  // "Sem tema" sempre por último.
  const byTheme = new Map<string, OpenTopic[]>();
  for (const t of topics ?? []) {
    const key = t.themes[0] ?? NO_THEME;
    byTheme.set(key, [...(byTheme.get(key) ?? []), t]);
  }
  const themeGroups = [...byTheme.entries()].sort((a, b) =>
    (a[0] === NO_THEME ? 1 : 0) - (b[0] === NO_THEME ? 1 : 0) || b[1].length - a[1].length);

  const openSource = (file: string, title: string, date: string) =>
    onOpenNote({ file, title, date, participants: [], tags: [] });

  const renderTopic = (t: OpenTopic) => {
    const key = taskKey(t);
    const isClosing = closing.has(key);
    return (
      <li key={key} className={`task-item ${isClosing ? 'is-closing' : ''}`}>
        <input
          type="checkbox"
          className="task-check"
          checked={isClosing}
          disabled={isClosing}
          onChange={() => void close(t)}
          aria-label={`Resolvido: ${t.subject}`}
        />
        <div className="task-main">
          <span className="task-text">
            <strong>{t.subject}</strong>
            {t.missing && <> — falta {t.missing}</>}
          </span>
          <span className="task-meta">
            {t.waitingOn && <span className="task-owner">aguardando {t.waitingOn}</span>}
            <span className="task-due">{relativeDay(t.noteDate)}</span>
            <button className="task-note" onClick={() => openSource(t.file, t.noteTitle, t.noteDate)} title={t.file}>
              {t.noteTitle}
            </button>
          </span>
        </div>
      </li>
    );
  };

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
        <h1 className="chat-title">Pendências</h1>
        <div className="tasks-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'assuntos'} className={`tasks-tab ${tab === 'assuntos' ? 'is-on' : ''}`} onClick={() => setTab('assuntos')}>
            Assuntos{topics && topics.length > 0 ? ` ${topics.length}` : ''}
          </button>
          <button role="tab" aria-selected={tab === 'acoes'} className={`tasks-tab ${tab === 'acoes' ? 'is-on' : ''}`} onClick={() => setTab('acoes')}>
            Minhas ações{mine.length > 0 ? ` ${mine.length}` : ''}
          </button>
        </div>
        {tab === 'acoes' && tasks !== null && tasks.length > 0 && (
          <span className="tasks-count">
            {fresh.length} abertas{overdueCount > 0 ? ` · ${overdueCount} vencidas` : ''}
            {stale.length > 0 ? ` · ${stale.length} antigas` : ''}
          </span>
        )}
      </header>

      <div className="tasks-body">
        {error && <p className="chat-error">{error}</p>}

        {tab === 'assuntos' ? (
          topics === null ? (
            <p className="muted pad">Varrendo as notas do vault…</p>
          ) : topics.length === 0 ? (
            <div className="tasks-empty">
              <span className="tasks-empty-glyph" aria-hidden>☀</span>
              <p>Nenhum assunto em aberto.</p>
              <p className="muted">As próximas notas trazem o que ficou sem desfecho em cada reunião.</p>
            </div>
          ) : (
            themeGroups.map(([theme, list]) => (
              <section className="task-group" key={theme}>
                <h2 className={`task-group-label ${theme === NO_THEME ? '' : 'task-group-mine'}`}>
                  {theme} <span className="task-group-count">{list.length}</span>
                </h2>
                <ul className="tasks-list">{list.map(renderTopic)}</ul>
              </section>
            ))
          )
        ) : tasks === null ? (
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

            {stale.length > 0 && (
              <section className="task-group task-group-stale">
                <div className="task-stale-head">
                  <button
                    className="task-stale-toggle"
                    onClick={() => setShowStale((v) => !v)}
                    aria-expanded={showStale}
                  >
                    {showStale ? '▾' : '▸'} Antigas (+{STALE_DAYS} dias, sem prazo à frente){' '}
                    <span className="task-group-count">{stale.length}</span>
                  </button>
                  <button
                    className={`task-stale-close ${confirmBulk ? 'is-armed' : ''}`}
                    onClick={() => void closeAllStale()}
                    onBlur={() => setConfirmBulk(false)}
                    disabled={bulkBusy}
                  >
                    {bulkBusy ? 'Fechando…' : confirmBulk ? `Confirmar: fechar ${stale.length}?` : 'Fechar todas'}
                  </button>
                </div>
                {showStale && (
                  <ul className="tasks-list">{stale.map((t) => renderItem(t, true))}</ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
