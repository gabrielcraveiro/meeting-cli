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

/// Sobe o daemon do meeting-cli num terminal próprio (o chat da TUI depende
/// de um terminal real — ver commit "tray inicia o daemon em terminal").
#[tauri::command]
fn start_daemon() -> Result<(), String> {
    spawn_daemon()
}

#[cfg(target_os = "windows")]
fn spawn_daemon() -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "Meeting Daemon", "cmd", "/K", "meeting", "daemon"])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
fn spawn_daemon() -> Result<(), String> {
    std::process::Command::new("meeting")
        .arg("daemon")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_obsidian,
            open_https,
            start_daemon
        ])
        .setup(|app| {
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
                        if let Err(err) = spawn_daemon() {
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
