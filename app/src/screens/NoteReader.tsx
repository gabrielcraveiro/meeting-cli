import { useEffect, useRef, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { BackIcon, ExternalIcon, PencilIcon } from '../components/Icons';
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

/** Popover de correção: selecionar um termo errado na nota (ex.: "Tonarki")
 * abre "corrigir para…" — grava no glossário (vale pras próximas transcrições)
 * E substitui todas as ocorrências NESTA nota. */
type GlossarySel = { from: string; x: number; y: number };

export function NoteReader({ note, onBack }: Props) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);

  /** modo edição: markdown cru num textarea, salvo direto no vault.
   * `saving` é compartilhado com o popover de glossário — as duas escritas
   * nunca acontecem juntas (uma some quando a outra abre). */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const [sel, setSel] = useState<GlossarySel | null>(null);
  const [fixTo, setFixTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const load = () => {
    setError(null);
    setMarkdown(null);
    api
      .noteContent(note.file)
      .then((r) => setMarkdown(r.markdown))
      .catch((err) => setError(friendlyError(err)));
  };

  useEffect(load, [note.file]);
  // trocar de nota nunca carrega rascunho da anterior
  useEffect(() => { setEditing(false); setDraft(''); }, [note.file]);

  const startEdit = () => {
    if (markdown === null) return;
    setDraft(markdown);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.noteSave(note.file, draft);
      setMarkdown(draft);
      setEditing(false);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  const onMouseUp = () => {
    const s = window.getSelection();
    const text = s?.toString().replace(/\s+/g, ' ').trim() ?? '';
    if (!text || text.length < 2 || text.length > 60 || !s || s.rangeCount === 0) {
      if (!saving) setSel(null);
      return;
    }
    const rect = s.getRangeAt(0).getBoundingClientRect();
    const host = screenRef.current?.getBoundingClientRect();
    if (!host) return;
    setSel({
      from: text,
      x: Math.max(8, Math.min(rect.left - host.left, host.width - 232)),
      y: Math.min(rect.bottom - host.top + 6, host.height - 90),
    });
    setFixTo('');
    setSavedMsg(null);
  };

  const saveFix = async () => {
    if (!sel || !fixTo.trim() || saving) return;
    const from = sel.from;
    const to = fixTo.trim();
    setSaving(true);
    try {
      const [, rep] = await Promise.all([
        api.glossaryAdd(from, to),
        api.noteReplace(note.file, from, to),
      ]);
      setSel(null);
      setSavedMsg(
        `"${from}" → "${to}" — ${rep.replaced} ocorrência(s) corrigida(s) + glossário`,
      );
      setTimeout(() => setSavedMsg(null), 4000);
      load(); // recarrega a nota já corrigida
    } catch (err) {
      setError(friendlyError(err));
      setSel(null);
    } finally {
      setSaving(false);
    }
  };

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
    <div className="screen reader" ref={screenRef}>
      <header className="reader-head">
        <button className="btn-ghost" onClick={onBack} aria-label="Voltar">
          <BackIcon />
        </button>
        <div className="reader-meta">
          <span>{relativeDay(note.date)}</span>
          {note.participants.length > 0 && <span>· {participantsLabel(note.participants)}</span>}
        </div>
        {editing ? (
          <>
            <button className="reader-cancel" onClick={() => setEditing(false)} disabled={saving}>
              cancelar
            </button>
            <button className="reader-save" onClick={() => void saveEdit()} disabled={saving}>
              {saving ? 'salvando…' : 'salvar'}
            </button>
          </>
        ) : (
          <>
            <button
              className="btn-ghost"
              onClick={startEdit}
              disabled={markdown === null}
              title="Editar a nota"
              aria-label="Editar nota"
            >
              <PencilIcon />
            </button>
            <button className="btn-ghost" onClick={openInObsidian} title="Abrir no Obsidian">
              <ExternalIcon />
            </button>
          </>
        )}
      </header>

      <div className="reader-body" onMouseUp={onMouseUp}>
        {error && <ErrorBanner message={error} onRetry={load} />}
        {markdown === null && !error && <p className="muted pad">Carregando nota…</p>}
        {markdown !== null && !editing && (
          <NoteContent markdown={markdown} fallbackTitle={note.title} />
        )}
        {markdown !== null && editing && (
          <textarea
            className="reader-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveEdit();
            }}
            spellCheck
            autoFocus
          />
        )}
      </div>

      {sel && (
        <div className="gloss-pop" style={{ left: sel.x, top: sel.y }}>
          <span className="gloss-from" title={sel.from}>“{sel.from}”</span>
          <div className="gloss-row">
            <input
              className="gloss-input"
              value={fixTo}
              onChange={(e) => setFixTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveFix();
                if (e.key === 'Escape') setSel(null);
              }}
              placeholder="corrigir para…"
              autoFocus
            />
            <button
              className="gloss-save"
              onClick={() => void saveFix()}
              disabled={saving || !fixTo.trim()}
            >
              {saving ? '…' : 'Corrigir'}
            </button>
          </div>
        </div>
      )}
      {savedMsg && <div className="gloss-toast">Dicionário: {savedMsg}</div>}
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
