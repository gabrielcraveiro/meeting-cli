import { useEffect, useRef, useState } from 'react';
import { subscribeSse } from '../lib/sse';
import { mmss } from '../lib/format';
import type { TranscriptLine } from '../lib/api';

/** Painel lateral com o transcript ao vivo (SSE). Fechado por padrão. */
export function TranscriptPanel() {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [connected, setConnected] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const stop = subscribeSse('/session/transcript/stream', {
      onOpen: () => setConnected(true),
      onDisconnect: () => setConnected(false),
      events: {
        snapshot: (data) => {
          const d = data as { lines?: TranscriptLine[] };
          setLines(Array.isArray(d.lines) ? d.lines : []);
        },
        line: (data) => {
          const l = data as TranscriptLine;
          if (!l || typeof l.text !== 'string') return;
          setLines((prev) => [...prev, l]);
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

  return (
    <aside className="transcript">
      <header className="transcript-head">
        <span>Transcript ao vivo</span>
        <span className={`conn ${connected ? 'conn-on' : ''}`} title={connected ? 'conectado' : 'reconectando…'} />
      </header>
      <div className="transcript-body" ref={boxRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <p className="muted">
            {connected ? 'Aguardando fala…' : 'Conectando ao transcript…'}
          </p>
        ) : (
          lines.map((l, i) => (
            <p className="tline" key={`${l.ts}-${i}`}>
              <span className="tline-ts">[{mmss(l.ts)}]</span>{' '}
              <span className="tline-speaker">{l.speaker || 'Alguém'}:</span>{' '}
              <span className="tline-text">{l.text}</span>
            </p>
          ))
        )}
      </div>
    </aside>
  );
}
