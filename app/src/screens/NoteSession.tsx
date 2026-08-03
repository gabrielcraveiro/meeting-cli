import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloseIcon, SendIcon, StopIcon, WaveIcon } from '../components/Icons';
import { Markdown } from '../components/Markdown';
import { TranscriptPanel } from '../components/TranscriptPanel';
import { ApiError, api, friendlyError, type Insight, type Status } from '../lib/api';
import { mmss } from '../lib/format';
import { subscribeSse } from '../lib/sse';

type Card =
  | { kind: 'insight'; id: string; ts: number; text: string }
  | { kind: 'reply'; id: string; question: string; text: string }
  | { kind: 'pending'; id: string; question: string };

type Props = {
  status: Status | null;
  onStopped: () => void;
};

const DRAFT_KEY = 'meeting.notepad.draft';
/** janela do daemon para receber contexto extra depois do stop */
const CONTEXT_WINDOW_SEC = 45;

export function NoteSession({ status, onStopped }: Props) {
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

  useEffect(() => {
    const stop = subscribeSse('/session/insights/stream', {
      events: {
        insight: (data) => {
          const ins = data as Insight;
          if (!ins || typeof ins.text !== 'string') return;
          setCards((prev) => [
            ...prev,
            { kind: 'insight', id: `ins-${ins.ts}-${prev.length}`, ts: ins.ts, text: ins.text },
          ]);
        },
      },
    });
    return stop;
  }, []);

  // ------------------------------------------------------- chat

  const ask = async () => {
    const msg = question.trim();
    if (!msg || asking) return;
    const id = `q-${Date.now()}`;
    setQuestion('');
    setAsking(true);
    setCards((prev) => [...prev, { kind: 'pending', id, question: msg }]);
    try {
      const { reply } = await api.chat(msg);
      setCards((prev) =>
        prev.map((c) =>
          c.id === id ? { kind: 'reply', id, question: msg, text: reply } : c,
        ),
      );
    } catch (err) {
      setCards((prev) =>
        prev.map((c) =>
          c.id === id
            ? { kind: 'reply', id, question: msg, text: `_${friendlyError(err)}_` }
            : c,
        ),
      );
    } finally {
      setAsking(false);
    }
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

  return (
    <div className={`screen session ${showTranscript ? 'with-transcript' : ''}`}>
      <div className="session-main">
        <header className="session-head">
          <h1 className="session-title">{status?.title || 'Nota sem título'}</h1>
          <div className="session-status">
            <span className="rec-dot" aria-hidden />
            <span className="rec-time">{finalizing ? 'finalizando…' : elapsed}</span>
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
                  {c.kind === 'insight' && (
                    <>
                      <span className="card-tag">insight · {mmss(c.ts)}</span>
                      <Markdown source={c.text} className="prose-compact" />
                    </>
                  )}
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
                  style={{ width: `${(contextLeft / CONTEXT_WINDOW_SEC) * 100}%` }}
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
          )}
        </div>
      </div>

      {showTranscript && <TranscriptPanel />}
    </div>
  );
}
