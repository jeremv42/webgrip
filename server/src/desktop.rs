// The server of the desktop app (src-tauri), run inside the app's process:
//
// - no password: each launch draws a random token; the window opens /api/desktop-login?token=…, which sets the
//   session cookie (the next launch has another token)
// - listens on 127.0.0.1, on a free port, and only answers that Host (a page from elsewhere reaching it through DNS
//   rebinding gets nothing)
// - serves the built SPA itself
// - keeps its connections and their encryption key in the app's data folder

use crate::app::{create_app, host_of, write_private, AppOptions};
use crate::chat::ChatOptions;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use base64::Engine;
use std::path::{Path, PathBuf};
use tower_http::services::ServeDir;

pub struct Desktop {
    pub port: u16,
    // the URL that logs the window in
    pub login_url: String,
}

// The key of the saved connections, created at the first launch (only readable by this user).
// Losing it means losing the saved connections' passwords.
fn secret(data_dir: &Path) -> std::io::Result<String> {
    let file = data_dir.join("secret.key");
    match std::fs::read_to_string(&file) {
        Ok(s) => return Ok(s.trim().to_string()),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        Err(_) => {}
    }
    let value = base64::engine::general_purpose::STANDARD.encode(crate::vault::random::<32>());
    std::fs::create_dir_all(data_dir)?;
    write_private(&file, format!("{value}\n").as_bytes())?;
    Ok(value)
}

// The chat needs the Claude Code CLI. An app started from the desktop often lacks the shell's PATH, so the usual
// install folders are tried too. WEBGRIP_CHAT=0 turns it off.
fn find_claude() -> Option<String> {
    if let Some(bin) = std::env::var("WEBGRIP_CLAUDE_BIN").ok().filter(|b| !b.is_empty()) {
        return Some(bin);
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(h) = &home {
        dirs.push(h.join(".local").join("bin"));
        dirs.push(h.join(".claude").join("local"));
    }
    dirs.push("/usr/local/bin".into());
    dirs.push("/opt/homebrew/bin".into());
    let name = if cfg!(windows) { "claude.exe" } else { "claude" };
    dirs.into_iter().map(|d| d.join(name)).find(|f| is_executable(f)).map(|f| f.to_string_lossy().into_owned())
}

fn is_executable(f: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(f) else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    meta.is_file()
}

fn flag(name: &str, fallback: bool) -> bool {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        _ => fallback,
    }
}

// Starts the server on a free port of 127.0.0.1 (on the current tokio runtime) and returns where to point the window.
pub async fn start(data_dir: &Path, dist: &Path) -> Result<Desktop, String> {
    let token = hex(&crate::vault::random::<32>());
    let secret = secret(data_dir).map_err(|e| format!("Cannot read or create the key in {}: {e}", data_dir.display()))?;
    let chat = if flag("WEBGRIP_CHAT", true) { find_claude() } else { None }.map(|bin| ChatOptions {
        bin,
        model: std::env::var("WEBGRIP_CHAT_MODEL").ok().filter(|m| !m.is_empty()),
        run_query: flag("WEBGRIP_CHAT_RUN_QUERY", false),
    });
    let (api, state) = create_app(AppOptions {
        data_file: data_dir.join("connections.json"),
        secret,
        password: token.clone(),
        make_driver: None,
        chat,
        desktop: true,
    })?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let _ = state.port.set(port);
    let host = format!("127.0.0.1:{port}");
    let router = api.fallback_service(ServeDir::new(dist)).layer(middleware::from_fn(move |req: Request, next: Next| {
        let ok = host_of(req.headers()) == Some(host.as_str());
        async move {
            if ok {
                next.run(req).await
            } else {
                StatusCode::MISDIRECTED_REQUEST.into_response()
            }
        }
    }));
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("WebGrip server stopped: {e}");
        }
    });
    Ok(Desktop { port, login_url: format!("http://127.0.0.1:{port}/api/desktop-login?token={token}") })
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
