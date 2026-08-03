import { useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { BackIcon, ExternalIcon } from '../components/Icons';
import { Markdown } from '../components/Markdown';
import { api, friendlyError, type NoteSummary } from '../lib/api';
import { participantsLabel, relativeDay } from '../lib/format';
import { splitFrontmatter, type NoteMeta } from '../lib/frontmatter';
import { openObsidian } from '../lib/shell';

const VAULT_NAME_KEY = 'meeting.vaultName';

type Props = {
  note: NoteSummary;
  onBack: () => void;
};

export function NoteReader({ note, onBack }: Props) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    setMarkdown(null);
    api
      .noteContent(note.file)
      .then((r) => setMarkdown(r.markdown))
      .catch((err) => setError(friendlyError(err)));
  };

  useEffect(load, [note.file]);

  const openInObsidian = async () => {
    let vault = localStorage.getItem(VAULT_NAME_KEY) ?? '';
    if (!vault) {
      const answer = window.prompt(
        'Nome do vault no Obsidian (deixe vazio para usar o vault ativo):',
        '',
      );
      if (answer === null) return;
      vault = answer.trim();
      localStorage.setItem(VAULT_NAME_KEY, vault);
    }
    try {
      await openObsidian(note.file, vault || undefined);
    } catch {
      setError('Não foi possível abrir o Obsidian.');
    }
  };

  return (
    <div className="screen reader">
      <header className="reader-head">
        <button className="btn-ghost" onClick={onBack} aria-label="Voltar">
          <BackIcon />
        </button>
        <div className="reader-meta">
          <span>{relativeDay(note.date)}</span>
          {note.participants.length > 0 && <span>· {participantsLabel(note.participants)}</span>}
        </div>
        <button className="btn-ghost" onClick={openInObsidian} title="Abrir no Obsidian">
          <ExternalIcon />
        </button>
      </header>

      <div className="reader-body">
        {error && <ErrorBanner message={error} onRetry={load} />}
        {markdown === null && !error && <p className="muted pad">Carregando nota…</p>}
        {markdown !== null && <NoteContent markdown={markdown} fallbackTitle={note.title} />}
      </div>
    </div>
  );
}

/** Frontmatter YAML → cabeçalho editorial (título serifado + linha de fatos +
 *  chips de tags), no espírito das Properties do Obsidian. */
function NoteContent({ markdown, fallbackTitle }: { markdown: string; fallbackTitle?: string }) {
  const { meta, body } = splitFrontmatter(markdown);
  return (
    <>
      {meta && <MetaHeader meta={meta} fallbackTitle={fallbackTitle} />}
      <Markdown source={body} className="prose-editorial" />
    </>
  );
}

function MetaHeader({ meta, fallbackTitle }: { meta: NoteMeta; fallbackTitle?: string }) {
  const title = meta.title && meta.title !== 'Resumo' ? meta.title : fallbackTitle;
  const facts = [
    meta.date && relativeDay(meta.date),
    meta.time,
    meta.durationLabel,
    meta.participants.length > 0 && participantsLabel(meta.participants),
    meta.costLabel,
  ].filter(Boolean) as string[];

  return (
    <header className="note-meta-head">
      {title && <h1 className="note-meta-title">{title}</h1>}
      {facts.length > 0 && <p className="note-meta-facts">{facts.join(' · ')}</p>}
      {meta.tags.length > 0 && (
        <div className="note-meta-tags">
          {meta.tags.map((t) => (
            <span key={t} className="note-meta-tag">{t}</span>
          ))}
        </div>
      )}
    </header>
  );
}
