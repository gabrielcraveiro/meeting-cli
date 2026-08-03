/**
 * Render de markdown.
 *
 * O markdown vem do vault e do claude engine — ou seja, passa por um modelo e
 * por arquivos que não controlamos byte a byte. Sanitizar com regex é furado,
 * então o HTML gerado pelo `marked` vai inteiro pro DOMPurify.
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

const PURIFY_CONFIG = { USE_PROFILES: { html: true } };

export function renderMarkdown(src: string): string {
  const html = marked.parse(src ?? '', { async: false }) as string;
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

/** Markdown "de uma linha" — negrito, itálico, código inline. Para cartões. */
export function renderInline(src: string): string {
  const html = marked.parseInline(src ?? '', { async: false }) as string;
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}
