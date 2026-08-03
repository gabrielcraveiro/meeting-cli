import { getCurrentWindow } from '@tauri-apps/api/window';
import { CloseIcon, MinusIcon } from './Icons';

/**
 * Barra de título própria (janela frameless). A área arrastável usa o
 * atributo data-tauri-drag-region, tratado pelo próprio webview.
 */
export function TitleBar({ label }: { label?: string }) {
  const minimize = () => void getCurrentWindow().minimize();
  // fechar = esconder (o app vive no tray); o Rust também intercepta,
  // mas fazer aqui evita o flicker do close nativo.
  const hide = () => void getCurrentWindow().hide();

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="titlebar-label" data-tauri-drag-region>
        {label ?? 'Meeting'}
      </span>
      <div className="titlebar-controls">
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
