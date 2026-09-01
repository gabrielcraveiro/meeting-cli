use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

/// Percent-encoding de um componente de query (RFC 3986 unreserved + nada mais).
fn encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Abre uma nota no Obsidian. A URI é montada AQUI — o frontend só manda o
/// caminho relativo e (opcionalmente) o nome do vault, então não há como um
/// markdown malicioso induzir `file://` ou outro esquema.
#[tauri::command]
fn open_obsidian(app: tauri::AppHandle, file: String, vault: Option<String>) -> Result<(), String> {
    let relative = file.replace('\\', "/");
    let relative = relative.strip_suffix(".md").unwrap_or(&relative);
    if relative.is_empty() {
        return Err("caminho da nota vazio".into());
    }

    let mut uri = String::from("obsidian://open?");
    if let Some(name) = vault.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        uri.push_str("vault=");
        uri.push_str(&encode_component(name));
        uri.push('&');
    }
    uri.push_str("file=");
    uri.push_str(&encode_component(relative));

    app.opener()
        .open_url(uri, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Abre um link externo no navegador. Só `https://` — qualquer outro esquema
/// (file, javascript, obsidian, smb…) é rejeitado.
#[tauri::command]
fn open_https(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("apenas links https são permitidos".into());
    }
    // sem espaços/controle: evita truques de parsing no handler do sistema
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("URL inválida".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Resolve os binários `node` e `meeting` DENTRO do WSL em runtime — nada de
/// path hardcoded (era o bloqueador nº 1 pra distribuir o app: os caminhos
/// eram da máquina do autor). Estratégia, com cache por processo:
///   1. login shell (`bash -lc`): carrega o profile do usuário (fnm/nvm/apt
///      entram no PATH) e pergunta `command -v meeting && command -v node`;
///   2. fallback: glob no layout do fnm (`~/.local/share/fnm/node-versions/
///      */installation/bin/meeting`), node = irmão no mesmo diretório.
/// Invocamos o node explicitamente com o script `meeting` porque o shebang
/// `#!/usr/bin/env node` falha em shells não-interativos sem o PATH do fnm.
#[cfg(target_os = "windows")]
fn resolve_wsl_bins() -> Result<(String, String), String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Result<(String, String), String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            if let Some(pair) = probe_wsl(&[
                "-e", "bash", "-lc",
                "command -v meeting && command -v node",
            ]) {
                return Ok(pair);
            }
            if let Some(pair) = probe_fnm_glob() {
                return Ok(pair);
            }
            Err("não encontrei `meeting`/`node` no WSL — instale com: npm i -g @gabrielcraveiro/meeting-cli".into())
        })
        .clone()
}

/// Roda wsl.exe capturando stdout; espera duas linhas (meeting, node).
#[cfg(target_os = "windows")]
fn probe_wsl(args: &[&str]) -> Option<(String, String)> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("wsl.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines().map(str::trim).filter(|l| l.starts_with('/'));
    let meeting = lines.next()?.to_string();
    let node = lines.next()?.to_string();
    Some((node, meeting))
}

#[cfg(target_os = "windows")]
fn probe_fnm_glob() -> Option<(String, String)> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("wsl.exe")
        .args([
            "-e", "bash", "-c",
            "ls -1 \"$HOME\"/.local/share/fnm/node-versions/*/installation/bin/meeting 2>/dev/null | tail -1",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let meeting = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !meeting.starts_with('/') {
        return None;
    }
    let node = format!("{}/node", meeting.rsplit_once('/')?.0);
    Some((node, meeting))
}

/// Sobe o daemon do meeting-cli SEM terminal (`--headless`): o app é o dono da
/// UI agora, e o log ao vivo aparece na tela "Daemon" via `/daemon/logs`.
/// O processo é solto (não herda stdio) — se o app fechar, o daemon continua.
#[tauri::command]
fn start_daemon_headless() -> Result<(), String> {
    spawn_daemon_headless()
}

#[cfg(target_os = "windows")]
fn spawn_daemon_headless() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    // CREATE_NO_WINDOW: nada de janela de console piscando. Não combinamos com
    // DETACHED_PROCESS porque as duas flags são mutuamente exclusivas no
    // CreateProcess — o desacoplamento vem do stdio em null + wsl.exe, que já
    // sobrevive ao processo pai.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let (node, meeting) = resolve_wsl_bins()?;
    std::process::Command::new("wsl.exe")
        .args(["-e", &node, &meeting, "daemon", "--headless"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
fn spawn_daemon_headless() -> Result<(), String> {
    use std::process::Stdio;

    std::process::Command::new("meeting")
        .args(["daemon", "--headless"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Reinicia o daemon via `meeting daemon restart` — o CLI cuida do ciclo
/// inteiro (SIGTERM no antigo, spawn destacado do novo, espera o /status).
/// Bloqueante por alguns segundos, por isso roda em spawn_blocking. Se houver
/// gravação em andamento o CLI recusa e a mensagem chega ao app como erro.
#[tauri::command]
async fn restart_daemon() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(restart_daemon_blocking)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
fn restart_daemon_blocking() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let (node, meeting) = resolve_wsl_bins()?;
    let out = std::process::Command::new("wsl.exe")
        .args(["-e", &node, &meeting, "daemon", "restart"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    collect_restart_output(out)
}

#[cfg(not(target_os = "windows"))]
fn restart_daemon_blocking() -> Result<String, String> {
    let out = std::process::Command::new("meeting")
        .args(["daemon", "restart"])
        .output()
        .map_err(|e| e.to_string())?;
    collect_restart_output(out)
}

fn collect_restart_output(out: std::process::Output) -> Result<String, String> {
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let text = text.trim().to_string();
    if out.status.success() {
        Ok(text)
    } else if text.is_empty() {
        Err(format!("meeting daemon restart falhou (exit {:?})", out.status.code()))
    } else {
        Err(text)
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Instância única: relançar o app (ou ativar um deep link com ele já
        // aberto) foca a janela existente em vez de abrir outra. Com a feature
        // "deep-link", a URL da segunda invocação chega ao plugin deep-link.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        // Autostart no login: o app é o "interruptor" da gravação automática
        // (autoRecordRequiresApp) e vive no tray — sem ele aberto pós-reboot,
        // calls eram silenciosamente ignoradas.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_obsidian,
            open_https,
            start_daemon_headless,
            restart_daemon
        ])
        .setup(|app| {
            // meeting:// — notificações do daemon abrem o APP na nota (em vez
            // do Obsidian). register_all cobre dev/execução sem instalador; o
            // NSIS registra o protocolo na instalação.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |_event| {
                    // o front roteia pra nota; aqui só garantimos a janela visível
                    show_main(&handle);
                });
            }

            // Garante o autostart habilitado (idempotente; usuário pode
            // desabilitar nas Configurações de Inicializar do Windows).
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            let open = MenuItemBuilder::with_id("open", "Abrir").build(app)?;
            let daemon = MenuItemBuilder::with_id("daemon", "Iniciar daemon").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Sair").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&open)
                .item(&daemon)
                .separator()
                .item(&quit)
                .build()?;

            // O tray é criado só aqui (e NÃO em app.trayIcon do tauri.conf.json),
            // senão apareceriam dois ícones na bandeja.
            let mut tray = TrayIconBuilder::with_id("main-tray").tooltip("Meeting");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }

            tray
                .menu(&menu)
                // no Windows o menu deve abrir só no botão direito
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "daemon" => {
                        if let Err(err) = spawn_daemon_headless() {
                            eprintln!("falha ao iniciar o daemon: {err}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // fechar = esconder; o app continua vivo no tray
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("erro ao rodar o app Meeting");
}
