import { useEffect, useMemo, useRef, useState } from 'react';
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

/** Silêncio longo dentro do mesmo falante abre um turno novo: sem isso, quem
 * volta a falar 5 min depois "continuaria" o parágrafo antigo e o horário do
 * cabeçalho mentiria sobre quando aquilo foi dito. */
const TURN_GAP_SEC = 60;
/** Dentro do turno, pausa acima disso vira parágrafo — dá respiro visual a
 * monólogos longos sem repetir o nome. */
const PARA_GAP_SEC = 12;
/** Duração só aparece no cabeçalho quando conta algo ("falou por 2 min"). */
const SHOW_DURATION_SEC = 30;

type Turn = { speaker: string; start: number; end: number; paras: TranscriptLine[][] };

/** Agrupa legendas consecutivas do mesmo falante em turnos, como numa conversa.
 * As legendas do Teams chegam fatiadas por frase; repetir o nome a cada linha
 * esconde quem de fato está conduzindo a conversa. */
function groupTurns(lines: TranscriptLine[]): Turn[] {
  const turns: Turn[] = [];
  for (const l of lines) {
    const speaker = l.speaker || 'Alguém';
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker && l.ts - last.end <= TURN_GAP_SEC) {
      const para = last.paras[last.paras.length - 1];
      const prevTs = para[para.length - 1].ts;
      if (l.ts - prevTs > PARA_GAP_SEC) last.paras.push([l]);
      else para.push(l);
      last.end = Math.max(last.end, l.ts);
    } else {
      turns.push({ speaker, start: l.ts, end: l.ts, paras: [[l]] });
    }
  }
  return turns;
}

/** Matiz estável por nome: a mesma pessoa mantém a cor a reunião inteira, e o
 * olho acha "quem falou" sem ler o nome. Saturação/luz ficam no CSS por tema. */
function speakerHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Participação por volume de palavras, não por tempo: a legenda do Teams não
 * traz fim de fala confiável, e contar palavras não pune quem fala devagar
 * nem premia quem deixa silêncio no meio da frase. */
type Share = { speaker: string; pct: number };

function talkShares(lines: TranscriptLine[]): Share[] {
  const words = new Map<string, number>();
  let total = 0;
  for (const l of lines) {
    const n = l.text.split(/\s+/).filter(Boolean).length;
    const who = l.speaker || 'Alguém';
    words.set(who, (words.get(who) ?? 0) + n);
    total += n;
  }
  if (!total) return [];
  return [...words.entries()]
    .map(([speaker, n]) => ({ speaker, pct: (n / total) * 100 }))
    .sort((a, b) => b.pct - a.pct);
}

/** Quantos falantes a legenda da barra nomeia; o resto vira "+N" (a barra em
 * si mostra todos, e o title de cada fatia dá o número). */
const SHARE_LEGEND_MAX = 3;

function shortDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m}min ${s}s` : `${m}min`;
}

/** Painel lateral com o transcript ao vivo (SSE). Fechado por padrão. */
export function TranscriptPanel() {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [connected, setConnected] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const pinnedRef = useRef(true);
  const turns = useMemo(() => groupTurns(lines.slice(-MAX_LINES_RENDER)), [lines]);
  const shares = useMemo(() => talkShares(lines), [lines]);
  // Falas que chegaram enquanto o usuário lia lá em cima. Estado (não ref)
  // porque a pílula precisa re-renderizar a cada fala nova.
  const [unseen, setUnseen] = useState(0);

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
          setUnseen(0);
        },
        line: (data) => {
          const l = data as TranscriptLine;
          if (!l || typeof l.text !== 'string') return;
          setLines((prev) => [...prev, l].slice(-MAX_LINES_MEMORY));
          if (!pinnedRef.current) setUnseen((n) => n + 1);
        },
        // Revisão da legenda: o ASR completou falas já exibidas. Troca a cauda
        // em vez de acrescentar — senão a mesma frase aparece 2-3 vezes.
        replace: (data) => {
          const d = data as { drop?: number; lines?: TranscriptLine[] };
          const drop = Math.max(0, d.drop ?? 0);
          const fresh = Array.isArray(d.lines) ? d.lines.filter((l) => typeof l?.text === 'string') : [];
          setLines((prev) => [...prev.slice(0, Math.max(0, prev.length - drop)), ...fresh].slice(-MAX_LINES_MEMORY));
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
    if (pinnedRef.current) setUnseen(0);
  };

  const jumpToLive = () => {
    const box = boxRef.current;
    if (!box) return;
    pinnedRef.current = true;
    setUnseen(0);
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
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
      {shares.length > 1 && (
        <div className="talk" aria-label="Participação na conversa">
          <div className="talk-bar">
            {shares.map((sh) => (
              <span
                key={sh.speaker}
                className="spk talk-seg"
                style={{ '--spk-hue': speakerHue(sh.speaker), flexGrow: sh.pct } as React.CSSProperties}
                title={`${sh.speaker} · ${Math.round(sh.pct)}%`}
              />
            ))}
          </div>
          <div className="talk-legend">
            {shares.slice(0, SHARE_LEGEND_MAX).map((sh) => (
              <span
                key={sh.speaker}
                className="spk talk-item"
                style={{ '--spk-hue': speakerHue(sh.speaker) } as React.CSSProperties}
              >
                <span className="talk-name">{sh.speaker.split(' ')[0]}</span> {Math.round(sh.pct)}%
              </span>
            ))}
            {shares.length > SHARE_LEGEND_MAX && (
              <span className="talk-more">+{shares.length - SHARE_LEGEND_MAX}</span>
            )}
          </div>
        </div>
      )}
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
            {turns.map((t, i) => (
              <section
                className="spk tturn"
                key={`${t.start}-${i}`}
                style={{ '--spk-hue': speakerHue(t.speaker) } as React.CSSProperties}
              >
                <header className="tturn-head">
                  <span className="tturn-dot" aria-hidden />
                  <span className="tline-speaker">{t.speaker}</span>
                  <span className="tline-ts">
                    {mmss(t.start)}
                    {t.end - t.start >= SHOW_DURATION_SEC && ` · ${shortDuration(t.end - t.start)}`}
                  </span>
                </header>
                {t.paras.map((para, j) => (
                  <p className="tline" key={j}>
                    {para.map((l, k) => (
                      <span className="tline-text" key={k} title={mmss(l.ts)}>
                        {k > 0 && ' '}
                        {l.text}
                      </span>
                    ))}
                  </p>
                ))}
              </section>
            ))}
          </>
        )}
      </div>

      {unseen > 0 && (
        <button className="tlive-pill" onClick={jumpToLive}>
          ↓ {unseen} {unseen === 1 ? 'fala nova' : 'falas novas'}
        </button>
      )}

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
