import { BackIcon } from './Icons';
import { Markdown } from './Markdown';
import type { AskResponse, AskSource } from '../lib/api';

type Props = {
  question: string;
  asking: boolean;
  answer: AskResponse | null;
  error: string | null;
  onBack: () => void;
  onRetry: () => void;
  onOpenSource: (source: AskSource) => void;
};

function money(usd?: number): string | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  return `US$ ${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** Tela dedicada da resposta — espera, erro e resultado com fontes. */
export function AnswerView({
  question,
  asking,
  answer,
  error,
  onBack,
  onRetry,
  onOpenSource,
}: Props) {
  const cost = money(answer?.costUsd);

  return (
    <div className="answer">
      <header className="answer-head">
        <button className="btn-ghost" onClick={onBack} aria-label="Voltar">
          <BackIcon />
        </button>
        <p className="answer-question">{question}</p>
      </header>

      {asking && (
        <div className="answer-wait" role="status">
          <span className="spinner" />
          <span>Consultando suas reuniões… pode levar um minuto.</span>
        </div>
      )}

      {!asking && error && (
        <div className="answer-fail" role="status">
          <p className="answer-fail-msg">{error}</p>
          <button className="btn-primary answer-retry" onClick={onRetry}>
            Tentar de novo
          </button>
        </div>
      )}

      {!asking && !error && answer && (
        <>
          <section className="card answer-card">
            <Markdown source={answer.answer} className="prose-editorial" />
          </section>

          {answer.sources.length > 0 && (
            <section className="answer-sources">
              <h2 className="group-label">Fontes</h2>
              <div className="chips">
                {answer.sources.map((s) => (
                  <button
                    key={s.file}
                    className="chip"
                    onClick={() => onOpenSource(s)}
                    title={s.file}
                  >
                    {s.title || s.file}
                  </button>
                ))}
              </div>
            </section>
          )}

          {cost && <p className="answer-cost">Custo desta pergunta: {cost}</p>}
        </>
      )}
    </div>
  );
}
