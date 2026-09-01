import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackIcon, CloseIcon, SendIcon, StopIcon, WaveIcon } from '../components/Icons';
import { Markdown } from '../components/Markdown';
import { TranscriptPanel } from '../components/TranscriptPanel';
import { ApiError, api, friendlyError, type Insight, type OpenTask, type Status } from '../lib/api';
import { mmss } from '../lib/format';
import { subscribeSse } from '../lib/sse';

type Card =
  | { kind: 'reply'; id: string; question: string; text: string }
  | { kind: 'pending'; id: string; question: string };

type InsightItem = { id: string; ts: number; text: string };

const insightKey = (i: { ts: number; text: string }) => `${i.ts}|${i.text}`;

/** Insights chegam como "- [decisao] texto…" — o marcador vira badge visual. */
const INSIGHT_KINDS: Record<string, { label: string; cls: string }> = {
  decisao: { label: 'decisão', cls: 'kind-decisao' },
  acao: { label: 'ação', cls: 'kind-acao' },
  risco: { label: 'risco', cls: 'kind-risco' },
  pendencia: { label: 'pendência', cls: 'kind-risco' },
  info: { label: 'info', cls: 'kind-info' },
  pergunta: { label: 'pergunte', cls: 'kind-pergunta' },
};

function parseInsight(text: string): { kind?: { label: string; cls: string }; body: string } {
  const m = text.match(/^-?\s*\[(\w+)\]\s*(.*)$/s);
  if (m) {
    const key = m[1].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    return { kind: INSIGHT_KINDS[key] ?? { label: m[1].toLowerCase(), cls: 'kind-info' }, body: m[2] };
  }
  return { body: text.replace(/^-\s*/, '') };
}

type Props = {
  status: Status | null;
  onStopped: () => void;
  /** volta pra Home SEM parar a gravação — a sessão vive no daemon */
  onBack: () => void;
  /** abre a tela de Tarefas (a gravação continua; a pill traz de volta) */
  onOpenTasks: () => void;
};

const DRAFT_KEY = 'meeting.notepad.draft';
/** janela do daemon para receber contexto extra depois do stop */
const CONTEXT_WINDOW_SEC = 45;
/** Guardrail: chips de insight na tela têm teto — os antigos saem por baixo
 * (continuam na nota final, que vem do daemon, não daqui). */
const MAX_INSIGHTS = 40;
/** Guardrail: cards de resposta do chat da sessão também não acumulam sem fim. */
const MAX_CARDS = 10;

export function NoteSession({ status, onStopped, onBack, onOpenTasks }: Props) {
  const [draft, setDraft] = useState(() => sessionStorage.getItem(DRAFT_KEY) ?? '');
  const [showTranscript, setShowTranscript] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [awaitingNote, setAwaitingNote] = useState(false);

  // contexto pós-reunião (fase 'finalizing')
  const [context, setContext] = useState('');
  const [contextLeft, setContextLeft] = useState(CONTEXT_WINDOW_SEC);
  const [contextDone, setContextDone] = useState(false);
  const [contextNote, setContextNote] = useState<string | null>(null);
  const [sendingContext, setSendingContext] = useState(false);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const sentRef = useRef<Set<string>>(new Set());

  // ------------------------------------------------------- notepad

  useEffect(() => {
    sessionStorage.setItem(DRAFT_KEY, draft);
  }, [draft]);

  // textarea auto-expansível
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [draft]);

  const sendLine = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || sentRef.current.has(text)) return;
    sentRef.current.add(text);
    try {
      await api.postSessionNote(text);
    } catch (err) {
      sentRef.current.delete(text);
      setError(friendlyError(err));
    }
  }, []);

  /** Envia todas as linhas completas ainda não enviadas (exceto a última, em edição). */
  const flushLines = useCallback(
    (all: boolean) => {
      const lines = draft.split('\n');
      const upTo = all ? lines.length : Math.max(0, lines.length - 1);
      for (let i = 0; i < upTo; i++) void sendLine(lines[i]);
    },
    [draft, sendLine],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // a linha onde o caret está acabou de ser "fechada" pelo Enter
    const ta = e.currentTarget;
    const before = ta.value.slice(0, ta.selectionStart);
    const currentLine = before.slice(before.lastIndexOf('\n') + 1);
    void sendLine(currentLine);
  };

  // ao sair do notepad, garante que nada fique preso
  const onBlur = () => flushLines(true);

  // ------------------------------------------------------- insights (SSE)

  // Insights vivem ACIMA do editor (não misturados com o chat) e o snapshot
  // do SSE reidrata o que foi gerado antes desta tela montar — sem ele,
  // navegar pra Home e voltar apagava tudo.
  const [insights, setInsights] = useState<InsightItem[]>([]);
  const [dismissedInsights, setDismissedInsights] = useState<Set<string>>(new Set());

  useEffect(() => {
    const merge = (incoming: Insight[]) =>
      setInsights((prev) => {
        const seen = new Set(prev.map(insightKey));
        const fresh = incoming
          .filter((i) => i && typeof i.text === 'string' && !seen.has(insightKey(i)))
          .map((i) => ({ id: insightKey(i), ts: i.ts, text: i.text }));
        return fresh.length > 0 ? [...prev, ...fresh].slice(-MAX_INSIGHTS) : prev;
      });

    const stop = subscribeSse('/session/insights/stream', {
      events: {
        // Snapshot é o estado COMPLETO da sessão atual — substitui, não mescla.
        // Mesclar deixava insights da call anterior na tela quando uma call
        // emendava na outra (o stream reconecta na sessão nova, snapshot vazio).
        snapshot: (data) => {
          const incoming = ((data as { insights?: Insight[] })?.insights) ?? [];
          setInsights(
            incoming
              .filter((i) => i && typeof i.text === 'string')
              .map((i) => ({ id: insightKey(i), ts: i.ts, text: i.text })),
          );
        },
        insight: (data) => merge([data as Insight]),
      },
    });
    return stop;
  }, []);

  const visibleInsights = insights.filter((i) => !dismissedInsights.has(i.id));

  // Call longa gera dezenas de chips e o editor afunda — colapsado mostra só
  // os mais recentes; o contador expande a lista completa (rolável).
  const INSIGHTS_COLLAPSED = 5;
  const [insightsExpanded, setInsightsExpanded] = useState(false);
  const shownInsights = insightsExpanded
    ? visibleInsights
    : visibleInsights.slice(-INSIGHTS_COLLAPSED);
  const hiddenInsights = visibleInsights.length - shownInsights.length;

  // ------------------------------------------------------- chat

  /** Envia uma pergunta ao chat da sessão. `label` é o que aparece no card
   * (útil pra perguntas prontas, tipo o resumo dos últimos 5 min). */
  const askMessage = async (msg: string, label?: string) => {
    if (!msg || asking) return;
    const id = `q-${Date.now()}`;
    const tag = label ?? msg;
    setAsking(true);
    setCards((prev) => [...prev, { kind: 'pending', id, question: tag } as Card].slice(-MAX_CARDS));
    try {
      const { reply } = await api.chat(msg);
      setCards((prev) =>
        prev.map((c) =>
          c.id === id ? { kind: 'reply', id, question: tag, text: reply } : c,
        ),
      );
    } catch (err) {
      setCards((prev) =>
        prev.map((c) =>
          c.id === id
            ? { kind: 'reply', id, question: tag, text: `_${friendlyError(err)}_` }
            : c,
        ),
      );
    } finally {
      setAsking(false);
    }
  };

  const ask = async () => {
    const msg = question.trim();
    if (!msg) return;
    setQuestion('');
    await askMessage(msg);
  };

  /** Resumo pronto: recap objetivo dos últimos ~5 minutos da call. */
  const recapRecent = () => {
    const now = status?.elapsedSec ?? 0;
    const from = Math.max(0, now - 300);
    void askMessage(
      `Resuma objetivamente o que foi discutido nos últimos 5 minutos da call ` +
        `(aproximadamente de [${mmss(from)}] até [${mmss(now)}]): temas, decisões e ` +
        `pontos importantes, citando quem falou. Máximo 5 bullets. ` +
        `Se o trecho foi trivial, diga em uma frase.`,
      'Resumo dos últimos 5 min',
    );
  };

  const dismiss = (id: string) => setCards((prev) => prev.filter((c) => c.id !== id));

  // ------------------------------------------------------- parar

  const stop = async () => {
    if (!window.confirm('Encerrar a gravação e gerar a nota final?')) return;
    setStopping(true);
    flushLines(true);
    try {
      await api.stop();
      sessionStorage.removeItem(DRAFT_KEY);
      // não saímos daqui: a fase 'finalizing' ainda pede contexto extra
      setAwaitingNote(true);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setStopping(false);
    }
  };

  const elapsed = useMemo(() => mmss(status?.elapsedSec ?? 0), [status?.elapsedSec]);
  const finalizing = status?.phase === 'finalizing';

  // ------------------------------------------------- contexto pós-reunião

  // countdown visual da janela de 45s (só enquanto o daemon está finalizando)
  useEffect(() => {
    if (!finalizing || contextDone) return;
    const id = window.setInterval(() => {
      setContextLeft((v) => (v <= 1 ? 0 : v - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [finalizing, contextDone]);

  /**
   * Fecha a janela de contexto. `text` vazio é resposta válida no contrato
   * ("sem contexto, prossiga") — é o que o botão *Pular* manda, para o daemon
   * não ficar esperando os 45s inteiros.
   */
  const sendContext = async (raw?: string) => {
    const text = (raw ?? context).trim();
    if (sendingContext) return;
    if (raw === undefined && !text) return;
    setSendingContext(true);
    try {
      await api.sessionContext(text);
      setContextDone(true);
      setContext('');
    } catch (err) {
      setContextDone(true);
      setContextNote(
        err instanceof ApiError && err.status === 409
          ? 'A janela de contexto fechou — a nota já estava sendo escrita.'
          : friendlyError(err),
      );
    } finally {
      setSendingContext(false);
    }
  };

  // a nota saiu (phase voltou a idle) → devolve o usuário pra Home
  useEffect(() => {
    if (!awaitingNote) return;
    if (status?.phase === 'idle' && !status.recording) onStopped();
  }, [awaitingNote, status?.phase, status?.recording, onStopped]);

  const contextExpired = contextLeft <= 0;
  const showContextForm = finalizing && !contextDone && !contextExpired;
  const showFinalizing = finalizing && (contextDone || contextExpired);

  // ---------------------------------------------- enhance ao vivo (Granola)
  const [enhanced, setEnhanced] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [showEnhanced, setShowEnhanced] = useState(false);
  const enhancingRef = useRef(false);
  /** relógio do auto-enhance — parte do mount pra 1ª rodada vir aos 10 min */
  const lastEnhanceAt = useRef(Date.now());

  const runEnhance = async (opts?: { auto?: boolean }) => {
    if (enhancingRef.current) return;
    enhancingRef.current = true;
    flushLines(true);  // linhas ainda não enviadas entram no esqueleto
    setEnhancing(true);
    if (!opts?.auto) setError(null);
    try {
      const r = await api.enhance();
      setEnhanced(r.markdown);
      lastEnhanceAt.current = Date.now();
      if (!opts?.auto) setShowEnhanced(true);
    } catch (err) {
      // auto-refresh falho é silencioso — a próxima rodada tenta de novo
      if (!opts?.auto) {
        setError(
          err instanceof ApiError && err.status === 409
            ? 'Nenhuma gravação ativa para aprimorar.'
            : friendlyError(err),
        );
      }
    } finally {
      enhancingRef.current = false;
      setEnhancing(false);
    }
  };

  // Auto-enhance a cada 10 min de gravação: a prévia rica fica sempre fresca
  // sem clique. Atualiza em segundo plano; quem está vendo a prévia ganha a
  // reescrita animada (efeito de digitação abaixo).
  const AUTO_ENHANCE_MS = 10 * 60_000;
  const recording = !!status?.recording && !finalizing;
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      if (Date.now() - lastEnhanceAt.current >= AUTO_ENHANCE_MS) {
        void runEnhance({ auto: true });
      }
    }, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  // Efeito de digitação: a cada versão nova da prévia (manual ou automática),
  // o texto se reescreve progressivamente. typedLen === null → texto completo.
  const [typedLen, setTypedLen] = useState<number | null>(null);
  useEffect(() => {
    if (!showEnhanced || enhanced === null) { setTypedLen(null); return; }
    setTypedLen(0);
    const total = enhanced.length;
    const step = Math.max(6, Math.round(total / 160)); // ~5s do início ao fim
    const id = window.setInterval(() => {
      setTypedLen((v) => {
        if (v === null) return null;
        const next = v + step;
        if (next >= total) { clearInterval(id); return null; }
        return next;
      });
    }, 30);
    return () => clearInterval(id);
  }, [enhanced, showEnhanced]);

  // -------------------------------------------- prep → esqueleto do notepad
  // Se existe nota de prep pra ESTA reunião e o notepad está vazio, a pauta
  // sugerida vira o ponto de partida das suas anotações — e como as linhas do
  // notepad guiam a nota final, a pauta planejada estrutura a nota. Nunca
  // sobrescreve texto seu; só preenche vazio, uma vez por sessão.
  useEffect(() => {
    if (sessionStorage.getItem(DRAFT_KEY)?.trim()) return;
    let alive = true;
    const t = window.setTimeout(() => {
      api
        .sessionPrep()
        .then((r) => {
          if (!alive) return;
          const pauta = r.markdown.match(/## Sugest[aã]o de pauta\s*\n+([\s\S]*?)(?=\n## |\n---|\s*$)/i)?.[1];
          if (!pauta?.trim()) return;
          const bullets = pauta
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('-'))
            .slice(0, 6);
          if (bullets.length === 0) return;
          setDraft((prev) => (prev.trim() ? prev : `Pauta (do prep):\n${bullets.join('\n')}\n\n`));
        })
        .catch(() => {}); // sem prep = sem esqueleto, segue vazio
    }, 4000); // espera o título da sessão assentar no daemon
    return () => { alive = false; clearTimeout(t); };
  }, [status?.sessionKey]);

  // --------------------------------------------------- pauta sugerida da call
  // Cruza quem está NA call com as pendências abertas do vault ("Giovani está
  // aqui e deve X"). Busca aos 45s (roster já populado) e re-tenta aos 2min se
  // veio vazio (gente ainda entrando). Dispensável com um clique.
  type Pauta = {
    context: string | null;
    tasks: OpenTask[];
    related: Array<{ file: string; title: string; date: string }>;
  };
  const [pauta, setPauta] = useState<Pauta | null>(null);
  const [pautaDismissed, setPautaDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    setPauta(null);
    setPautaDismissed(false);
    const fetchPauta = async (): Promise<boolean> => {
      try {
        const r = await api.sessionPauta();
        if (!alive) return false;
        if (r.context || r.tasks.length > 0 || r.related.length > 0) {
          setPauta(r);
          return true;
        }
      } catch {
        // sem pauta não é erro — só não mostra o card
      }
      return false;
    };
    const t1 = window.setTimeout(() => {
      void fetchPauta().then((ok) => {
        if (!ok && alive) {
          window.setTimeout(() => { void fetchPauta(); }, 75_000);
        }
      });
    }, 45_000);
    return () => { alive = false; clearTimeout(t1); };
  }, [status?.sessionKey]);

  // ------------------------------------------- virada de sessão (call → call)
  // Quando uma call emenda na outra, esta tela NÃO desmonta — o daemon troca a
  // sessão por baixo (sessionKey muda). Tudo que é "desta call" reseta aqui;
  // os insights se resolvem via snapshot do SSE (stream reconecta e substitui).
  // O rascunho do notepad fica: anotação do usuário não some sozinha.
  const sessionKeyRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const key = status?.sessionKey;
    if (key === undefined) return;
    if (sessionKeyRef.current !== undefined && key !== sessionKeyRef.current) {
      setCards([]);
      setDismissedInsights(new Set());
      setEnhanced(null);
      setShowEnhanced(false);
      setContextDone(false);
      setContextLeft(CONTEXT_WINDOW_SEC);
      setContextNote(null);
      setAwaitingNote(false);
      sentRef.current = new Set();
    }
    sessionKeyRef.current = key;
  }, [status?.sessionKey]);

  return (
    <div className={`screen session ${showTranscript ? 'with-transcript' : ''}`}>
      <div className="session-main">
        <header className="session-head">
          <button
            className="btn-ghost session-back"
            onClick={() => {
              flushLines(true); // linhas do notepad não podem ficar presas
              onBack();
            }}
            title="Voltar pra Home (a gravação continua)"
            aria-label="Voltar (gravação continua)"
          >
            <BackIcon />
          </button>
          <h1 className="session-title">{status?.title || 'Nota sem título'}</h1>
          <div className="session-status">
            <span className="rec-dot" aria-hidden />
            <span className="rec-time">{finalizing ? 'finalizando…' : elapsed}</span>
            <button
              className={`btn-enhance ${showEnhanced ? 'is-on' : ''}`}
              onClick={() => {
                if (showEnhanced) { setShowEnhanced(false); return; }
                // versão em cache aparece na hora; se está velha, renova por trás
                if (enhanced !== null) {
                  setShowEnhanced(true);
                  if (Date.now() - lastEnhanceAt.current > 2 * 60_000) void runEnhance({ auto: true });
                } else {
                  void runEnhance();
                }
              }}
              disabled={(enhancing && enhanced === null) || finalizing}
              title={showEnhanced ? 'Voltar às suas notas' : 'Aprimorar notas com o transcript até agora (auto a cada 10 min)'}
            >
              {enhancing && enhanced === null ? '…' : showEnhanced ? 'Minhas notas' : '✨ Aprimorar'}
            </button>
            <button
              className="btn-stop"
              onClick={stop}
              disabled={stopping || finalizing}
              title="Encerrar gravação"
            >
              <StopIcon />
            </button>
          </div>
        </header>

        {error && <p className="session-error">{error}</p>}

        {pauta !== null && !pautaDismissed && (
          <div className="pauta-card" role="note" aria-label="Pauta sugerida">
            <div className="pauta-head">
              <span className="pauta-title">💡 Pra esta call</span>
              <button
                className="card-dismiss"
                onClick={() => setPautaDismissed(true)}
                aria-label="Dispensar pauta sugerida"
              >
                <CloseIcon size={12} />
              </button>
            </div>
            {pauta.context && (
              <div className="pauta-context">
                {pauta.context.split('\n').map((l, i) => {
                  const t = l.trim();
                  return t ? <p key={i}>{t.replace(/^-\s*/, '• ')}</p> : null;
                })}
              </div>
            )}
            {pauta.tasks.length > 0 && (
              <ul className="pauta-list">
                {pauta.tasks.slice(0, 5).map((t) => (
                  <li key={`${t.file}|${t.line}`}>
                    {t.owner ? <strong>{t.owner}: </strong> : <strong>você: </strong>}
                    {t.text}
                    {t.due && <span className="pauta-due"> · 📅 {t.due}</span>}
                  </li>
                ))}
                {pauta.tasks.length > 5 && (
                  <li className="pauta-more">
                    <button className="pauta-link" onClick={onOpenTasks}>
                      +{pauta.tasks.length - 5} pendências — ver Tarefas →
                    </button>
                  </li>
                )}
              </ul>
            )}
            {pauta.related.length > 0 && (
              <p className="pauta-related">
                Reuniões anteriores: {pauta.related.map((r) => r.title).join(' · ')}
              </p>
            )}
          </div>
        )}

        {visibleInsights.length > 0 && (
          <div
            className={`insights-strip ${insightsExpanded ? 'is-expanded' : ''}`}
            aria-label="Insights da reunião"
          >
            {(hiddenInsights > 0 || insightsExpanded) && (
              <button
                className="insight-more"
                onClick={() => setInsightsExpanded((v) => !v)}
                aria-expanded={insightsExpanded}
              >
                {insightsExpanded ? '− recolher' : `+${hiddenInsights} anteriores`}
              </button>
            )}
            {shownInsights.map((i) => {
              const parsed = parseInsight(i.text);
              return (
                <div className="insight-chip" key={i.id} title={`${mmss(i.ts)} — ${parsed.body}`}>
                  {parsed.kind ? (
                    <span className={`insight-kind ${parsed.kind.cls}`}>{parsed.kind.label}</span>
                  ) : (
                    <span className="insight-when">{mmss(i.ts)}</span>
                  )}
                  <span className="insight-text">{parsed.body}</span>
                  <button
                    className="card-dismiss"
                    onClick={() => setDismissedInsights((p) => new Set(p).add(i.id))}
                    aria-label="Dispensar insight"
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {showEnhanced && enhanced !== null ? (
          <div className="enhanced-view">
            <div className="enhanced-tag">
              <span>✨ Prévia aprimorada — se refaz a cada 10 min; suas notas cruas continuam intactas</span>
              <button className="enhanced-refresh" onClick={() => void runEnhance()} disabled={enhancing}>
                {enhancing ? 'atualizando…' : 'atualizar'}
              </button>
            </div>
            <div className={typedLen !== null ? 'is-typing' : ''}>
              <Markdown
                source={typedLen === null ? enhanced : enhanced.slice(0, typedLen)}
                className="prose-editorial"
              />
              {typedLen !== null && <span className="type-caret" aria-hidden />}
            </div>
          </div>
        ) : (
          <textarea
            ref={taRef}
            className="notepad"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            placeholder="Anote o que importa. Cada linha guia a nota final."
            spellCheck
            autoFocus
          />
        )}

        <div className="session-foot">
          {cards.length > 0 && (
            <div className="cards">
              {cards.map((c) => (
                <div className={`card-mini card-${c.kind}`} key={c.id}>
                  <button
                    className="card-dismiss"
                    onClick={() => dismiss(c.id)}
                    aria-label="Dispensar"
                  >
                    <CloseIcon size={12} />
                  </button>
                  {c.kind === 'pending' && (
                    <>
                      <span className="card-tag">{c.question}</span>
                      <p className="muted">Pensando…</p>
                    </>
                  )}
                  {c.kind === 'reply' && (
                    <>
                      <span className="card-tag">{c.question}</span>
                      <Markdown source={c.text} className="prose-compact" />
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {showContextForm ? (
            <div className="ctx">
              <div className="ctx-head">
                <span className="ctx-label">Algum contexto extra pra nota?</span>
                <span className="ctx-clock">{contextLeft}s</span>
              </div>
              <div className="ctx-bar" aria-hidden>
                <span
                  className="ctx-bar-fill"
                  style={{ transform: `scaleX(${contextLeft / CONTEXT_WINDOW_SEC})` }}
                />
              </div>
              <div className="ctx-row">
                <input
                  className="ctx-input"
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void sendContext();
                  }}
                  placeholder="O que a transcrição não pegou…"
                  autoFocus
                />
                <button
                  className="btn-ctx-skip"
                  onClick={() => void sendContext('')}
                  disabled={sendingContext}
                  title="Seguir sem contexto extra"
                >
                  Pular
                </button>
                <button
                  className="btn-ctx-send"
                  onClick={() => void sendContext()}
                  disabled={sendingContext || !context.trim()}
                >
                  {sendingContext ? 'Enviando…' : 'Enviar'}
                </button>
              </div>
            </div>
          ) : showFinalizing ? (
            <div className="ctx ctx-wait">
              <span className="spinner" aria-hidden />
              <span className="ctx-label">Finalizando nota…</span>
              {contextNote && <span className="ctx-note">{contextNote}</span>}
            </div>
          ) : (
            <>
            <div className="quick-actions">
              {asking ? (
                <span className="quick-busy">
                  <span className="spinner" aria-hidden /> gerando…
                </span>
              ) : (
                <>
                  <button className="quick-chip" onClick={recapRecent}>
                    ⏱ Resumo dos últimos 5 min
                  </button>
                  <button
                    className="quick-chip"
                    onClick={() =>
                      void askMessage(
                        'Liste as decisões e combinados fechados até agora nesta call, ' +
                          'com quem assumiu cada um. Máximo 5 bullets. Se nada foi decidido ainda, diga isso.',
                        'Decisões até agora',
                      )
                    }
                  >
                    ✓ Decisões até agora
                  </button>
                </>
              )}
            </div>
            <div className="askbar">
              <button
                className={`btn-wave ${showTranscript ? 'is-on' : ''}`}
                onClick={() => setShowTranscript((v) => !v)}
                title={showTranscript ? 'Esconder transcript' : 'Mostrar transcript'}
                aria-pressed={showTranscript}
              >
                <WaveIcon />
              </button>
              <input
                className="ask-input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void ask();
                }}
                placeholder="Pergunte qualquer coisa…"
              />
              <button
                className="btn-send"
                onClick={() => void ask()}
                disabled={asking || !question.trim()}
                aria-label="Enviar pergunta"
              >
                <SendIcon />
              </button>
            </div>
            </>
          )}
        </div>
      </div>

      {showTranscript && <TranscriptPanel />}
    </div>
  );
}
