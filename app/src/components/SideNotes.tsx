import { useCallback, useEffect, useState } from 'react';
import { api, type NoteSummary } from '../lib/api';
import { relativeDay } from '../lib/format';

type Props = {
  activeFile?: string;
  onOpenNote: (note: NoteSummary) => void;
};

/** Lista lateral de notas — só aparece em janela larga (≥900px). Filtro local
 * por título; o vault inteiro continua na busca da Home (léxica + IA). */
export function SideNotes({ activeFile, onOpenNote }: Props) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [q, setQ] = useState('');

  const load = useCallback(() => {
    api.notesRecent(60).then(setNotes).catch(() => setNotes([]));
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const term = q.trim().toLowerCase();
  const shown = term
    ? notes.filter((n) => (n.title || n.file).toLowerCase().includes(term))
    : notes;

  return (
    <aside className="side-notes">
      <input
        className="side-filter"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filtrar notas…"
      />
      <ul className="side-list">
        {shown.map((n) => (
          <li key={n.file}>
            <button
              className={`side-item ${n.file === activeFile ? 'is-active' : ''}`}
              onClick={() => onOpenNote(n)}
              title={n.title || n.file}
            >
              <span className="side-item-title">{n.title || n.file}</span>
              <span className="side-item-date">{relativeDay(n.date)}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="muted side-empty">Nada por aqui.</li>}
      </ul>
    </aside>
  );
}
