import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { splitFrontmatter } from '../lib/frontmatter';
import { ChevronIcon, ExternalIcon, SunIcon } from './Icons';
import { Markdown } from './Markdown';

type Props = {
  /** abre o briefing como nota completa no leitor (tela cheia) */
  onOpen?: (file: string, title: string) => void;
};

const STORAGE_KEY = 'meeting.briefing.open';

export function BriefingCard({ onOpen }: Props = {}) {
  const [open, setOpen] = useState(() => localStorage.getItem(STORAGE_KEY) === '1');
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let alive = true;
    const fetchBriefing = () => {
      api
        .briefingToday()
        .then((r) => {
          if (!alive) return;
          setEmpty(false);
          // frontmatter YAML é metadado — não aparece no card
          const { body } = splitFrontmatter(r.markdown);
          setMarkdown((prev) => {
            // 1ª vez que o briefing do dia aparece e o usuário nunca fechou
            // o card → abre sozinho (descoberta; a preferência dele vence).
            if (prev === null && localStorage.getItem(STORAGE_KEY) === null) setOpen(true);
            return body;
          });
        })
        .catch((err) => {
          if (!alive) return;
          if (err instanceof ApiError && err.status === 404) setEmpty(true);
          else setEmpty(true);
        });
    };
    fetchBriefing();
    // Briefing pode ser gerado DEPOIS do app abrir (cron 7h40, geração manual)
    // — re-busca a cada 5 min em vez de congelar no 404 da montagem.
    const id = window.setInterval(fetchBriefing, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(STORAGE_KEY, v ? '0' : '1');
      return !v;
    });
  };

  const today = new Date().toLocaleDateString('sv').slice(0, 10);

  return (
    <section className={`card briefing ${open ? 'is-open' : ''}`}>
      <div className="briefing-head-row">
        <button className="briefing-head" onClick={toggle} aria-expanded={open}>
          <SunIcon className="briefing-sun" />
          <span className="briefing-title">Briefing do dia</span>
          <ChevronIcon className="briefing-chevron" />
        </button>
        {markdown !== null && onOpen && (
          <button
            className="briefing-open"
            onClick={() => onOpen(`Briefings/${today}.md`, `Briefing — ${today}`)}
            title="Abrir o briefing em tela cheia"
            aria-label="Abrir briefing completo"
          >
            <ExternalIcon size={14} />
          </button>
        )}
      </div>
      {open && (
        <div className="briefing-body">
          {markdown ? (
            <Markdown source={markdown} className="prose-compact" />
          ) : (
            <p className="muted">
              {empty ? 'Sem briefing hoje.' : 'Carregando…'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
