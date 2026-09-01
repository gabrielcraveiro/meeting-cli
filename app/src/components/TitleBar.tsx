import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';
import { CloseIcon, MinusIcon, MoonIcon, SunIcon } from './Icons';

const THEME_KEY = 'meeting.theme';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Barra de título própria (janela frameless). A área arrastável usa o
 * atributo data-tauri-drag-region, tratado pelo próprio webview.
 */
export function TitleBar({ label }: { label?: string }) {
  const minimize = () => void getCurrentWindow().minimize();
  // fechar = esconder (o app vive no tray); o Rust também intercepta,
  // mas fazer aqui evita o flicker do close nativo.
  const hide = () => void getCurrentWindow().hide();

  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="titlebar-label" data-tauri-drag-region>
        {label ?? 'Meeting'}
      </span>
      <div className="titlebar-controls">
        <button
          className="tb-btn"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
          aria-label="Alternar tema"
        >
          {theme === 'dark' ? <SunIcon size={14} /> : <MoonIcon size={14} />}
        </button>
        <button className="tb-btn" onClick={minimize} title="Minimizar" aria-label="Minimizar">
          <MinusIcon />
        </button>
        <button className="tb-btn" onClick={hide} title="Fechar (fica no tray)" aria-label="Fechar">
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
