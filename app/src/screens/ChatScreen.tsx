import { useEffect, useRef, useState } from 'react';
import { BackIcon, CloseIcon, PlusIcon, SendIcon } from '../components/Icons';
import { Markdown } from '../components/Markdown';
import { api, askError, type ChatTurn } from '../lib/api';
import {
  activeThread,
  appendMessage,
  listThreads,
  nextMessageId,
  removeThread,
  setActiveThread,
  startNewThread,
  type ChatThread,
} from '../lib/chatThreads';

type Props = {
  onBack: () => void;
  onOpenNote: (file: string) => void;
};

/** Quantos turnos recentes (mensagens, não pares) mandamos como contexto —
 * metade do limite do daemon (12), de sobra pra não pesar o payload. */
const HISTORY_TURNS = 6;

/** Tela de chat multi-turno com o vault. As conversas vivem em `chatThreads`
 * (fora do React): navegar pra outra tela e voltar retoma tudo, e dá pra
 * manter várias conversas em paralelo via abas. */
export function ChatScreen({ onBack, onOpenNote }: Props) {
  // O store é a verdade; este estado é só o espelho que dispara re-render.
  const [thread, setThread] = useState<ChatThread>(() => activeThread());
  const [threads, setThreads] = useState<ChatThread[]>(() => listThreads());
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** false = rápido (RAG, ~5-10s); true = profundo (claude agêntico, ~40s+) */
  const [deep, setDeep] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const askCtrl = useRef<AbortController | null>(null);

  const sync = () => {
    setThread({ ...activeThread() });
    setThreads(listThreads());
  };

  useEffect(() => {
    inputRef.current?.focus();
    return () => askCtrl.current?.abort();
  }, []);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.messages, sending]);

  const switchTo = (id: string) => {
    if (sending) return; // guardrail: resposta em voo pertence à thread atual
    setActiveThread(id);
    setError(null);
    sync();
    inputRef.current?.focus();
  };

  const newChat = () => {
    if (sending) return;
    startNewThread();
    setError(null);
    sync();
    inputRef.current?.focus();
  };

  const closeThread = (id: string) => {
    if (sending) return;
    removeThread(id);
    sync();
  };

  const send = async () => {
    const text = question.trim();
    if (!text || sending) return;
    const target = thread; // a resposta volta pra ESTA thread, mesmo se algo mudar

    // histórico pro daemon: últimos turnos já trocados, sem a pergunta atual
    // (que vai no campo `question`) e sem `sources` (fora do contrato).
    const history: ChatTurn[] = target.messages
      .slice(-HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.content }));

    appendMessage(target.id, { id: nextMessageId(), role: 'user', content: text });
    setQuestion('');
    setError(null);
    setSending(true);
    sync();

    const ctrl = new AbortController();
    askCtrl.current = ctrl;
    try {
      const res = await api.ask(text, history, ctrl.signal, deep ? 'deep' : 'fast');
      if (ctrl.signal.aborted) return;
      appendMessage(target.id, {
        id: nextMessageId(),
        role: 'assistant',
        content: res.answer,
        sources: res.sources ?? [],
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(askError(err));
    } finally {
      if (!ctrl.signal.aborted) {
        setSending(false);
        sync();
      }
    }
  };

  return (
    <div className="screen chat-screen">
      <header className="chat-head">
        <button className="btn-ghost" onClick={onBack} aria-label="Voltar">
          <BackIcon />
        </button>
        <h1 className="chat-title">Perguntar ao vault</h1>
        <button
          className="btn-ghost chat-new"
          onClick={newChat}
          disabled={sending}
          title="Nova conversa"
          aria-label="Nova conversa"
        >
          <PlusIcon />
        </button>
      </header>

      {threads.length > 1 && (
        <div className="chat-tabs" role="tablist">
          {threads.map((t) => (
            <span key={t.id} className={`chat-tab ${t.id === thread.id ? 'is-active' : ''}`}>
              <button
                role="tab"
                aria-selected={t.id === thread.id}
                className="chat-tab-label"
                onClick={() => switchTo(t.id)}
                title={t.title}
              >
                {t.title}
              </button>
              <button
                className="chat-tab-close"
                onClick={() => closeThread(t.id)}
                aria-label={`Fechar conversa: ${t.title}`}
              >
                <CloseIcon size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="chat-thread">
        {thread.messages.length === 0 && !sending && (
          <p className="muted pad chat-empty">
            Pergunte qualquer coisa sobre suas reuniões — follow-ups lembram do que já foi dito.
          </p>
        )}

        {thread.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="chat-bubble-user">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="chat-bubble-ai">
              <Markdown source={m.content} className="prose-compact" />
              {m.sources && m.sources.length > 0 && (
                <div className="chat-sources">
                  {m.sources.map((s) => (
                    <button
                      key={s.file}
                      className="chip"
                      onClick={() => onOpenNote(s.file)}
                      title={s.file}
                    >
                      ↗ {s.title || s.file}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ),
        )}

        {sending && (
          <div className="chat-bubble-ai chat-bubble-wait" role="status">
            <span className="spinner" aria-hidden />
            <span>{deep ? 'Pesquisando a fundo no vault (até ~1 min)…' : 'Pensando…'}</span>
          </div>
        )}

        {error && <p className="chat-error">{error}</p>}

        <div ref={threadEndRef} />
      </div>

      <div className="chat-askbar-slot">
        <div className="askbar">
          <button
            className={`btn-mode ${deep ? 'is-deep' : ''}`}
            onClick={() => setDeep((v) => !v)}
            disabled={sending}
            title={
              deep
                ? 'Modo profundo: claude pesquisa o vault a fundo (~40s+). Clique para voltar ao rápido.'
                : 'Modo rápido: resposta em segundos. Clique para pesquisa profunda.'
            }
            aria-pressed={deep}
          >
            {deep ? '🔬' : '⚡'}
          </button>
          <input
            ref={inputRef}
            className="ask-input"
            value={question}
            disabled={sending}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send();
            }}
            placeholder="Pergunte qualquer coisa ao vault…"
          />
          <button
            className="btn-send"
            onClick={() => void send()}
            disabled={sending || !question.trim()}
            aria-label="Enviar pergunta"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
