import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  askError,
  friendlyError,
  type AskResponse,
  type SearchResult,
} from '../lib/api';

/** Mínimo de caracteres para disparar a busca (o daemon exige ≥1). */
export const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

/** O que a Home deve mostrar no lugar do conteúdo normal. */
export type VaultView = 'idle' | 'results' | 'answer';

export type VaultSearch = {
  query: string;
  view: VaultView;
  results: SearchResult[] | null;
  searching: boolean;
  searchError: string | null;
  /** pergunta que originou a resposta atual (sobrevive a limpar o input) */
  question: string;
  asking: boolean;
  answer: AskResponse | null;
  answerError: string | null;
  setQuery: (q: string) => void;
  clear: () => void;
  ask: (question: string) => void;
  retryAsk: () => void;
  backFromAnswer: () => void;
  /** volta a um `view` anterior (usado ao sair do leitor de nota) */
  restore: (view: VaultView) => void;
};

/**
 * Busca e pergunta ao vault. Vive no App (não na Home) para que abrir uma nota
 * e voltar reencontre a lista de resultados / a resposta intactas.
 */
export function useVaultSearch(): VaultSearch {
  const [query, setQueryState] = useState('');
  const [mode, setMode] = useState<'search' | 'answer'>('search');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);

  const searchCtrl = useRef<AbortController | null>(null);
  const askCtrl = useRef<AbortController | null>(null);

  const term = query.trim();
  const active = mode === 'search' && term.length >= MIN_QUERY;

  // busca instantânea com debounce; cada digitada cancela a requisição anterior
  useEffect(() => {
    searchCtrl.current?.abort();
    if (!active) {
      setSearching(false);
      setSearchError(null);
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    searchCtrl.current = ctrl;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .search(term, 20, ctrl.signal)
        .then((rows) => {
          if (ctrl.signal.aborted) return;
          setResults(rows);
          setSearchError(null);
          setSearching(false);
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          setResults([]);
          setSearchError(friendlyError(err));
          setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [term, active]);

  useEffect(() => () => askCtrl.current?.abort(), []);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    setMode('search');
  }, []);

  const clear = useCallback(() => {
    searchCtrl.current?.abort();
    askCtrl.current?.abort();
    setQueryState('');
    setMode('search');
    setResults(null);
    setSearchError(null);
    setSearching(false);
    setAsking(false);
    setAnswer(null);
    setAnswerError(null);
    setQuestion('');
  }, []);

  const run = useCallback((text: string) => {
    const q = text.trim();
    if (!q) return;
    askCtrl.current?.abort();
    const ctrl = new AbortController();
    askCtrl.current = ctrl;
    setQuestion(q);
    setMode('answer');
    setAnswer(null);
    setAnswerError(null);
    setAsking(true);
    api
      .ask(q, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setAnswer({ ...res, sources: res.sources ?? [] });
        setAsking(false);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setAnswerError(askError(err));
        setAsking(false);
      });
  }, []);

  const retryAsk = useCallback(() => run(question), [run, question]);

  const backFromAnswer = useCallback(() => {
    askCtrl.current?.abort();
    setAsking(false);
    setAnswer(null);
    setAnswerError(null);
    setMode('search');
  }, []);

  const restore = useCallback((view: VaultView) => {
    setMode(view === 'answer' ? 'answer' : 'search');
  }, []);

  const view: VaultView =
    mode === 'answer' ? 'answer' : term.length >= MIN_QUERY ? 'results' : 'idle';

  return {
    query,
    view,
    results,
    searching,
    searchError,
    question,
    asking,
    answer,
    answerError,
    setQuery,
    clear,
    ask: run,
    retryAsk,
    backFromAnswer,
    restore,
  };
}
