import { ErrorBanner } from './ErrorBanner';
import { SparkIcon } from './Icons';
import { relativeDay } from '../lib/format';
import { highlight } from '../lib/highlight';
import type { SearchResult } from '../lib/api';

type Props = {
  query: string;
  results: SearchResult[] | null;
  searching: boolean;
  error: string | null;
  onAsk: () => void;
  onOpen: (r: SearchResult) => void;
};

/** Snippet com os termos da query em <mark> — highlight é client-side. */
function Snippet({ text, query }: { text: string; query: string }) {
  const segments = highlight(text, query);
  return (
    <span className="result-snippet">
      {segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </span>
  );
}

export function SearchResults({
  query,
  results,
  searching,
  error,
  onAsk,
  onOpen,
}: Props) {
  const trimmed = query.trim();
  const isQuestion = trimmed.endsWith('?');

  return (
    <div className="results">
      <ul className="result-list">
        <li>
          <button
            className={`result-ask ${isQuestion ? 'is-primed' : ''}`}
            onClick={onAsk}
          >
            <span className="result-ask-glyph" aria-hidden>
              <SparkIcon />
            </span>
            <span className="result-ask-text">
              <span className="result-ask-label">Perguntar à IA</span>
              <span className="result-ask-query">{trimmed}</span>
            </span>
          </button>
        </li>

        {results?.map((r) => (
          <li key={r.file}>
            <button className="result-item" onClick={() => onOpen(r)}>
              <span className="result-head">
                <span className="result-title">{r.title || r.file}</span>
                <span className="result-date">{relativeDay(r.date)}</span>
              </span>
              {r.snippet && <Snippet text={r.snippet} query={query} />}
            </button>
          </li>
        ))}
      </ul>

      {error && <ErrorBanner message={error} />}
      {!error && searching && results === null && (
        <p className="muted pad">Buscando…</p>
      )}
      {!error && !searching && results !== null && results.length === 0 && (
        <p className="muted pad">
          Nenhuma nota com “{trimmed}”. Você ainda pode perguntar à IA.
        </p>
      )}
    </div>
  );
}
