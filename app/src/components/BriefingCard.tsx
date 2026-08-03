import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { ChevronIcon, SunIcon } from './Icons';
import { Markdown } from './Markdown';

const STORAGE_KEY = 'meeting.briefing.open';

export function BriefingCard() {
  const [open, setOpen] = useState(() => localStorage.getItem(STORAGE_KEY) === '1');
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .briefingToday()
      .then((r) => alive && setMarkdown(r.markdown))
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) setEmpty(true);
        else setEmpty(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(STORAGE_KEY, v ? '0' : '1');
      return !v;
    });
  };

  return (
    <section className={`card briefing ${open ? 'is-open' : ''}`}>
      <button className="briefing-head" onClick={toggle} aria-expanded={open}>
        <SunIcon className="briefing-sun" />
        <span className="briefing-title">Briefing do dia</span>
        <ChevronIcon className="briefing-chevron" />
      </button>
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
