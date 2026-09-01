import { invoke } from '@tauri-apps/api/core';

/**
 * Aberturas externas. Nenhuma delas recebe uma URI arbitrária: o Rust monta a
 * URI do Obsidian a partir do caminho relativo e só aceita `https://` para
 * links. Assim um markdown malicioso não consegue disparar `file://` & cia.
 */

/** Abre a nota no Obsidian. `file` é o relpath dentro do vault. */
export async function openObsidian(file: string, vault?: string): Promise<void> {
  await invoke('open_obsidian', { file, vault: vault ?? null });
}

/** Abre um link https no navegador padrão. */
export async function openHttps(url: string): Promise<void> {
  await invoke('open_https', { url });
}

/**
 * Sobe o daemon em modo headless (sem terminal). Não espera o daemon ficar de
 * pé — quem chama faz o retry de `/status` (ver `useDaemonLauncher`).
 */
export async function startDaemonHeadless(): Promise<void> {
  await invoke('start_daemon_headless');
}

/**
 * Reinicia o daemon (`meeting daemon restart` no WSL). Bloqueia até o novo
 * processo responder /status (~2-10s) e devolve o output do CLI. Se houver
 * gravação em andamento, rejeita com a mensagem de proteção do CLI.
 */
export async function restartDaemon(): Promise<string> {
  return await invoke<string>('restart_daemon');
}
