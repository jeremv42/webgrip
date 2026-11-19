// WebGrip desktop shell. The API server (the webgrip-server crate) runs inside this process, on Tauri's tokio runtime,
// on a free port of 127.0.0.1; the window shows the same SPA as the web version, served by that server. The window has
// no access to Tauri's IPC: it is a plain web page.
//
// No password: each launch makes a random token, which the window trades for the session cookie through
// /api/desktop-login (see webgrip_server::desktop).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use std::sync::OnceLock;
use tauri::{Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// Shows an error on the start page
fn show_error(window: &WebviewWindow, message: &str) {
    let text = serde_json::to_string(message).unwrap_or_default();
    let _ = window.eval(format!(
        "(() => {{ const s = document.getElementById('status'); \
         if (s) {{ s.className = 'error'; s.textContent = {text} }} else alert({text}) }})()"
    ));
}

fn main() {
    tauri::Builder::default()
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
            let dist = app.path().resource_dir()?.join("dist");
            tauri::async_runtime::spawn(async move {
                match webgrip_server::desktop::start(&data_dir, &dist).await {
                    Ok(server) => {
                        let _ = origin.set(format!("http://127.0.0.1:{}", server.port));
                        match Url::parse(&server.login_url) {
                            Ok(url) => {
                                let _ = window.navigate(url);
                            }
                            Err(e) => show_error(&window, &format!("Bad server address: {e}")),
                        }
                    }
                    Err(e) => show_error(&window, &format!("The WebGrip server could not start.\n\n{e}")),
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while starting WebGrip");
}
