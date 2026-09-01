import type { AskSource } from './api';

/**
 * Threads de chat vivem FORA do React (módulo) para sobreviver à navegação —
 * sair da tela de chat desmonta o componente, mas a conversa continua aqui.
 * Sem persistência em disco (v1): fechar o app reseta, igual antes.
 */

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: AskSource[];
};

export type ChatThread = {
  id: string;
  /** primeira pergunta do usuário, truncada — vira o rótulo da aba */
  title: string;
  messages: ChatMessage[];
  createdAt: number;
};

/** Guardrails: threads e mensagens antigas são podadas, não acumulam sem teto. */
const MAX_THREADS = 8;
const MAX_MESSAGES_PER_THREAD = 80;
const TITLE_MAX = 42;

let threads: ChatThread[] = [];
let activeId: string | null = null;
let seq = 0;

export function nextMessageId(): string {
  seq += 1;
  return `m${Date.now()}-${seq}`;
}

function newThread(): ChatThread {
  seq += 1;
  const t: ChatThread = {
    id: `t${Date.now()}-${seq}`,
    title: 'Nova conversa',
    messages: [],
    createdAt: Date.now(),
  };
  threads = [...threads, t];
  // poda a mais antiga que não seja a ativa nem a recém-criada
  if (threads.length > MAX_THREADS) {
    const removable = threads.find((th) => th.id !== activeId && th.id !== t.id);
    if (removable) threads = threads.filter((th) => th.id !== removable.id);
  }
  return t;
}

export function listThreads(): ChatThread[] {
  return threads;
}

/** Thread ativa — cria a primeira sob demanda. */
export function activeThread(): ChatThread {
  let t = threads.find((th) => th.id === activeId);
  if (!t) {
    t = threads[threads.length - 1] ?? newThread();
    activeId = t.id;
  }
  return t;
}

export function setActiveThread(id: string): ChatThread {
  const t = threads.find((th) => th.id === id);
  if (t) activeId = t.id;
  return activeThread();
}

export function startNewThread(): ChatThread {
  // reaproveita uma "Nova conversa" vazia em vez de acumular abas em branco
  const blank = threads.find((th) => th.messages.length === 0);
  const t = blank ?? newThread();
  activeId = t.id;
  return t;
}

export function appendMessage(threadId: string, msg: ChatMessage): void {
  threads = threads.map((th) => {
    if (th.id !== threadId) return th;
    const messages = [...th.messages, msg].slice(-MAX_MESSAGES_PER_THREAD);
    const title =
      th.title === 'Nova conversa' && msg.role === 'user'
        ? msg.content.length > TITLE_MAX
          ? `${msg.content.slice(0, TITLE_MAX)}…`
          : msg.content
        : th.title;
    return { ...th, messages, title };
  });
}

export function removeThread(id: string): ChatThread {
  threads = threads.filter((th) => th.id !== id);
  if (activeId === id) activeId = null;
  return activeThread();
}
