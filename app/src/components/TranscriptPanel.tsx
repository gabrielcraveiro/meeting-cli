import { useEffect, useRef, useState } from 'react';
import { subscribeSse } from '../lib/sse';
import { mmss } from '../lib/format';
import { api, friendlyError, type TranscriptLine } from '../lib/api';

/**
 * Popover de correção de termo: selecionar um trecho do transcript abre um
 * mini-formulário "corrigir para…" que grava no glossário do vault
 * (meeting-glossario.md). Dali em diante toda legenda chega corrigida.
 */
type GlossarySel = { from: string; x: number; y: number };

/** Guardrails de performance: reuniões longas geram milhares de linhas e cada
 * linha nova re-renderiza o painel inteiro. Teto de memória + teto de render
 * mantêm o custo constante; o transcript completo continua no daemon/nota. */
const MAX_LINES_MEMORY = 2000;
const MAX_LINES_RENDER = 400;

/** Painel lateral com o transcript ao vivo (SSE). Fechado por padrão. */
export function TranscriptPanel() {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [connected, setConnected] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const pinnedRef = useRef(true);

  const [sel, setSel] = useState<GlossarySel | null>(null);
  const [fixTo, setFixTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const stop = subscribeSse('/session/transcript/stream', {
      onOpen: () => setConnected(true),
      onDisconnect: () => setConnected(false),
      events: {
        snapshot: (data) => {
          const d = data as { lines?: TranscriptLine[] };
          setLines(Array.isArray(d.lines) ? d.lines.slice(-MAX_LINES_MEMORY) : []);
        },
        line: (data) => {
          const l = data as TranscriptLine;
          if (!l || typeof l.text !== 'string') return;
          setLines((prev) => [...prev, l].slice(-MAX_LINES_MEMORY));
        },
      },
    });
    return stop;
  }, []);

  // autoscroll só quando o usuário está "colado" no fim
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !pinnedRef.current) return;
    box.scrollTop = box.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    pinnedRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  };

  const onMouseUp = () => {
    const s = window.getSelection();
    const text = s?.toString().replace(/\s+/g, ' ').trim() ?? '';
    if (!text || text.length < 2 || text.length > 60 || !s || s.rangeCount === 0) {
      if (!saving) setSel(null);
      return;
    }
    const rect = s.getRangeAt(0).getBoundingClientRect();
    const host = asideRef.current?.getBoundingClientRect();
    if (!host) return;
    setSel({
      from: text,
      x: Math.max(8, Math.min(rect.left - host.left, host.width - 232)),
      y: rect.bottom - host.top + 6,
    });
    setFixTo('');
    setSavedMsg(null);
    setSaveError(null);
  };

  const save = async () => {
    if (!sel || !fixTo.trim() || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.glossaryAdd(sel.from, fixTo.trim());
      setSavedMsg(`"${sel.from}" → "${fixTo.trim()}"`);
      setSel(null);
      setTimeout(() => setSavedMsg(null), 3000);
    } catch (err) {
      setSaveError(friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="transcript" ref={asideRef}>
      <header className="transcript-head">
        <span>Transcript ao vivo</span>
        <span className={`conn ${connected ? 'conn-on' : ''}`} title={connected ? 'conectado' : 'reconectando…'} />
      </header>
      <div className="transcript-body" ref={boxRef} onScroll={onScroll} onMouseUp={onMouseUp}>
        {lines.length === 0 ? (
          <p className="muted">
            {connected ? 'Aguardando fala…' : 'Conectando ao transcript…'}
          </p>
        ) : (
          <>
            {lines.length > MAX_LINES_RENDER && (
              <p className="muted tline-elided">
                … {lines.length - MAX_LINES_RENDER} falas anteriores ocultas (a nota final tem tudo)
              </p>
            )}
            {lines.slice(-MAX_LINES_RENDER).map((l, i) => (
              <p className="tline" key={`${l.ts}-${i}`}>
                <span className="tline-ts">[{mmss(l.ts)}]</span>{' '}
                <span className="tline-speaker">{l.speaker || 'Alguém'}:</span>{' '}
                <span className="tline-text">{l.text}</span>
              </p>
            ))}
          </>
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
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') setSel(null);
              }}
              placeholder="corrigir para…"
              autoFocus
            />
            <button className="gloss-save" onClick={() => void save()} disabled={saving || !fixTo.trim()}>
              {saving ? '…' : 'Sempre'}
            </button>
          </div>
          {saveError && <span className="gloss-err">{saveError}</span>}
        </div>
      )}
      {savedMsg && <div className="gloss-toast">Glossário: {savedMsg}</div>}
    </aside>
  );
}
