import { forwardRef } from 'react';
import { CloseIcon, SearchIcon } from './Icons';

type Props = {
  value: string;
  onChange: (v: string) => void;
  /** Enter com a query terminando em "?" → pergunta à IA. */
  onAsk: () => void;
  onClear: () => void;
  disabled?: boolean;
};

/**
 * Barra única de busca/pergunta no topo da Home. Sem botão de submit: a busca é
 * instantânea e a pergunta sai no Enter (ou pelo primeiro item da lista).
 */
export const SearchBar = forwardRef<HTMLInputElement, Props>(function SearchBar(
  { value, onChange, onAsk, onClear, disabled },
  ref,
) {
  const isQuestion = value.trim().endsWith('?');

  return (
    <div className="searchbar">
      <span className="search-glyph" aria-hidden>
        <SearchIcon />
      </span>
      <input
        ref={ref}
        className="search-input"
        type="text"
        value={value}
        disabled={disabled}
        placeholder="Buscar ou perguntar ao vault…"
        spellCheck={false}
        autoComplete="off"
        aria-label="Buscar ou perguntar ao vault"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && isQuestion) {
            e.preventDefault();
            onAsk();
          } else if (e.key === 'Escape' && value) {
            e.preventDefault();
            onClear();
          }
        }}
      />
      {isQuestion && <span className="search-hint">Enter para perguntar</span>}
      {value && (
        <button className="search-clear" onClick={onClear} aria-label="Limpar busca">
          <CloseIcon size={13} />
        </button>
      )}
    </div>
  );
});
