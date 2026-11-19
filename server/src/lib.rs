// WebGrip's API server. Run on its own (src/main.rs: the web install, behind Vite) or inside the desktop app
// (desktop::start: no password, serves the built SPA itself).

pub mod app;
pub mod auth;
pub mod chat;
pub mod chat_text;
pub mod describe;
pub mod desktop;
pub mod drivers;
pub mod error;
pub mod js;
pub mod sql;
pub mod types;
pub mod vault;

pub use app::{create_app, AppOptions};
pub use chat::ChatOptions;
