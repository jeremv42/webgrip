// The web install's API: reads .env and the environment, then listens on 127.0.0.1 only (Vite serves the SPA and
// proxies /api to it).

use std::path::PathBuf;
use webgrip_server::{create_app, AppOptions, ChatOptions};

fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

#[tokio::main]
async fn main() {
    // .env of the working directory (optional, ignored by git): WEBGRIP_PASSWORD, WEBGRIP_SECRET... Variables already
    // set win.
    match dotenvy::from_path(".env") {
        Ok(_) => {}
        Err(e) if e.not_found() => {}
        Err(e) => {
            eprintln!("Cannot read .env: {e}");
            std::process::exit(1);
        }
    }
    let data_file = var("WEBGRIP_DATA").map_or_else(|| PathBuf::from("data/connections.json"), PathBuf::from);
    let port: u16 = var("PORT").and_then(|p| p.parse().ok()).unwrap_or(3070);
    let password = var("WEBGRIP_PASSWORD").unwrap_or_default();
    let secret = var("WEBGRIP_SECRET").unwrap_or_default();
    if password.is_empty() || secret.chars().count() < 16 {
        eprintln!("WEBGRIP_PASSWORD and WEBGRIP_SECRET (at least 16 characters) must be set, e.g. in .env (see .env.example)");
        std::process::exit(1);
    }

    // Chat with Claude through the Claude Code CLI of this machine (its logged-in account)
    let chat = flag("WEBGRIP_CHAT").then(|| ChatOptions {
        bin: var("WEBGRIP_CLAUDE_BIN").unwrap_or_else(|| "claude".into()),
        model: var("WEBGRIP_CHAT_MODEL"),
        // off by default: Claude sees the structure only, never a row unless the user attaches it
        run_query: flag("WEBGRIP_CHAT_RUN_QUERY"),
    });

    let (router, state) = match create_app(AppOptions { data_file, secret, password, make_driver: None, chat, desktop: false }) {
        Ok(app) => app,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    // API only, never exposed: the browser reaches it through the Vite proxy (/api).
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Cannot listen on 127.0.0.1:{port}: {e}");
            std::process::exit(1);
        }
    };
    let _ = state.port.set(port);
    println!("webgrip API on http://127.0.0.1:{port}");
    if let Err(e) = axum::serve(listener, router).await {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
