import { useMemo } from 'react';
import { renderInline, renderMarkdown } from '../lib/markdown';
import { openHttps } from '../lib/shell';

type Props = {
  source: string;
  inline?: boolean;
  className?: string;
};

/**
 * Clique em link nunca navega o webview (isso mataria o app): links https saem
 * para o navegador via comando Rust, qualquer outro esquema é ignorado.
 */
function onLinkClick(e: React.MouseEvent<HTMLElement>) {
  const anchor = (e.target as HTMLElement).closest('a');
  if (!anchor) return;
  e.preventDefault();
  const href = anchor.getAttribute('href') ?? '';
  if (href.startsWith('https://')) void openHttps(href);
}

export function Markdown({ source, inline = false, className }: Props) {
  const html = useMemo(
    () => (inline ? renderInline(source) : renderMarkdown(source)),
    [source, inline],
  );
  const cls = ['prose', className].filter(Boolean).join(' ');
  if (inline) {
    return (
      <span className={cls} onClick={onLinkClick} dangerouslySetInnerHTML={{ __html: html }} />
    );
  }
  return <div className={cls} onClick={onLinkClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
