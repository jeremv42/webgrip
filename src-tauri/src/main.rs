// WebGrip desktop shell. It starts the server (the `webgrip-server` sidecar, built from server/desktop.ts),
// waits for the port it prints, and points its window at it. The UI is the same SPA as the web version,
// served by that server on 127.0.0.1: the window has no access to Tauri's IPC.
//
// No password: each launch makes a random token, passed to the server in its environment and given to the
// window through /api/desktop-login, which turns it into the session cookie.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Server(Mutex<Option<CommandChild>>);

fn launch_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("no random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// Shows an error on the start page (or over the app, when the server stops later).
fn show_error(window: &WebviewWindow, message: &str) {
    let text = serde_json::to_string(message).unwrap_or_default();
    let _ = window.eval(&format!(
        "(() => {{ const s = document.getElementById('status'); \
         if (s) {{ s.className = 'error'; s.textContent = {text} }} else alert({text}) }})()"
    ));
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Origin of the server once known: the window may only show it (or the start page).
            let origin: Arc<OnceLock<String>> = Arc::default();
            let allowed = origin.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("WebGrip")
                .inner_size(1400.0, 900.0)
                .min_inner_size(800.0, 500.0)
                .on_navigation(move |url: &Url| {
                    url.scheme() == "tauri"
                        || url.host_str() == Some("tauri.localhost")
                        || allowed.get().is_some_and(|o| url.origin().ascii_serialization() == *o)
                })
                .build()?;

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let dist = app.path().resource_dir()?.join("dist");
            let token = launch_token();

            let (mut events, child) = app
                .shell()
                .sidecar("webgrip-server")?
                .env("WEBGRIP_DATA_DIR", &data_dir)
                .env("WEBGRIP_DIST", &dist)
                .env("WEBGRIP_LAUNCH_TOKEN", &token)
                .spawn()?;
            app.manage(Server(Mutex::new(Some(child))));

            tauri::async_runtime::spawn(async move {
                let mut stderr = String::new();
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let line = String::from_utf8_lossy(&line);
                            let Some(port) = line.trim().strip_prefix("WEBGRIP_PORT=") else { continue };
                            let base = format!("http://127.0.0.1:{port}");
                            let _ = origin.set(base.clone());
                            match Url::parse(&format!("{base}/api/desktop-login?token={token}")) {
                                Ok(url) => {
                                    let _ = window.navigate(url);
                                }
                                Err(e) => show_error(&window, &format!("Bad server address: {e}")),
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            let line = String::from_utf8_lossy(&line);
                            eprintln!("[server] {}", line.trim_end());
                            stderr.push_str(&line);
                            if stderr.len() > 4000 {
                                stderr = stderr[stderr.len() - 4000..].to_string();
                            }
                        }
                        CommandEvent::Terminated(status) => {
                            let code = status.code.map_or("a signal".to_string(), |c| format!("code {c}"));
                            show_error(&window, &format!("The WebGrip server stopped ({code}).\n\n{}", stderr.trim()));
                            break;
                        }
                        CommandEvent::Error(e) => show_error(&window, &format!("WebGrip server error: {e}")),
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting WebGrip")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(child) = app.state::<Server>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
