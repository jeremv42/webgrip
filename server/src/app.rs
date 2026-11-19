// The HTTP API: routes, saved connections, one live driver per connection, the password guard.

use crate::auth::{logout_cookie, Attempt, Auth};
use crate::chat::{Chat, ChatOptions};
use crate::describe::to_markdown;
use crate::drivers::{default_driver, Driver};
use crate::error::Error;
use crate::js;
use crate::sql::{is_pageable, split_sql};
use crate::types::*;
use crate::vault::{is_sealed, seal, unseal};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

pub type MakeDriver = Arc<dyn Fn(&DriverConfig) -> Arc<dyn Driver> + Send + Sync>;

pub struct AppOptions {
    // saved connections, passwords included, encrypted with `secret`
    pub data_file: PathBuf,
    // encryption key of data_file, and key of the session cookies
    pub secret: String,
    // the password asked at login
    pub password: String,
    pub make_driver: Option<MakeDriver>,
    // chat with Claude through the Claude Code CLI (WEBGRIP_CHAT); off when None
    pub chat: Option<ChatOptions>,
    // desktop app: `password` is a random token of this launch, given to the window by GET /api/desktop-login, and the
    // UI has no login or logout
    pub desktop: bool,
}

pub struct AppState {
    data_file: PathBuf,
    secret: String,
    desktop: bool,
    auth: Auth,
    connections: RwLock<Vec<ConnectionConfig>>,
    drivers: Mutex<HashMap<String, Arc<dyn Driver>>>,
    make_driver: MakeDriver,
    pub chat: Option<Chat>,
    // the port the API listens on (the chat's MCP endpoint is reached there)
    pub port: OnceLock<u16>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    fn save(&self, list: &[ConnectionConfig]) -> Result<(), Error> {
        if let Some(dir) = self.data_file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = seal(&serde_json::to_string(list)?, &self.secret);
        write_private(&self.data_file, text.as_bytes())?;
        Ok(())
    }

    // A missing file means no connection yet; an unreadable one stops the startup (rather than being overwritten).
    fn load(&self) -> Result<Vec<ConnectionConfig>, String> {
        let text = match std::fs::read_to_string(&self.data_file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.to_string()),
        };
        let stored: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if is_sealed(&stored) {
            return serde_json::from_str(&unseal(&stored, &self.secret)?).map_err(|e| e.to_string());
        }
        // file written before encryption: encrypt it now
        let list: Vec<ConnectionConfig> = serde_json::from_value(stored).map_err(|e| e.to_string())?;
        self.save(&list).map_err(|e| e.message)?;
        Ok(list)
    }

    pub fn connection(&self, id: &str) -> Result<ConnectionConfig, Error> {
        self.connections.read().unwrap().iter().find(|c| c.id == id).cloned().ok_or_else(|| Error::status("Unknown connection", 404))
    }

    pub fn driver(&self, id: &str) -> Result<Arc<dyn Driver>, Error> {
        let mut drivers = self.drivers.lock().unwrap();
        if let Some(d) = drivers.get(id) {
            return Ok(d.clone());
        }
        let d = (self.make_driver)(&DriverConfig::from(&self.connection(id)?));
        drivers.insert(id.to_string(), d.clone());
        Ok(d)
    }

    async fn drop_driver(&self, id: &str) {
        let d = self.drivers.lock().unwrap().remove(id);
        if let Some(d) = d {
            d.close().await;
        }
    }
}

// Writes a file only its owner can read
pub fn write_private(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
        f.write_all(data)?;
        // the mode above only applies to a new file
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    std::fs::write(path, data)
}

// A route's value as JSON, or { error } (400 unless the error says otherwise)
pub struct ApiError(pub Error);

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        ApiError(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.0.status.unwrap_or(400)).unwrap_or(StatusCode::BAD_REQUEST);
        (status, Json(json!({ "error": self.0.message }))).into_response()
    }
}

type ApiResult = Result<Json<Value>, ApiError>;

fn ok<T: serde::Serialize>(v: T) -> ApiResult {
    Ok(Json(serde_json::to_value(v).map_err(Error::from)?))
}

// The request body as JSON ({} when empty or not JSON)
fn body_json(b: &Bytes) -> Value {
    serde_json::from_slice(b).unwrap_or_else(|_| json!({}))
}

// A non-empty string field
fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn owned(v: &Value, k: &str) -> Option<String> {
    str_of(v, k).map(str::to_string)
}

// Runs a database operation to its end even if the client goes away: dropping it halfway would leave the session's
// connection in the middle of an exchange (and a transaction in an unknown state)
async fn detached<T: Send + 'static>(f: impl std::future::Future<Output = Result<T, Error>> + Send + 'static) -> Result<T, Error> {
    tokio::spawn(f).await.unwrap_or_else(|e| Err(Error::new(format!("The operation failed: {e}"))))
}

// A query string parameter (non-empty)
fn q<'a>(query: &'a HashMap<String, String>, k: &str) -> Option<&'a str> {
    query.get(k).map(String::as_str).filter(|s| !s.is_empty())
}

pub fn public_conn(c: &ConnectionConfig) -> Value {
    let mut v = serde_json::to_value(c).unwrap();
    let m = v.as_object_mut().unwrap();
    m.remove("password");
    m.insert("hasPassword".into(), (!c.password.is_empty()).into());
    v
}

// the stored password, unless the form brings a new one
fn password_of(body: &Value, prev: Option<&ConnectionConfig>) -> String {
    if let Some(p) = str_of(body, "password") {
        return p.to_string();
    }
    if js::truthy(body.get("keepPassword")) {
        return prev.map(|p| p.password.clone()).unwrap_or_default();
    }
    String::new()
}

fn port_of(body: &Value) -> Option<u32> {
    let n = js::num_or(body.get("port"), 0.0);
    (n > 0.0 && n.is_finite()).then(|| n.min(u32::MAX as f64) as u32)
}

fn dialect_of(body: &Value) -> Dialect {
    if body.get("type").and_then(Value::as_str) == Some("mariadb") {
        Dialect::Mariadb
    } else {
        Dialect::Postgres
    }
}

pub fn create_app(opts: AppOptions) -> Result<(Router, Shared), String> {
    let state = Arc::new(AppState {
        data_file: opts.data_file.clone(),
        secret: opts.secret.clone(),
        desktop: opts.desktop,
        auth: Auth::new(&opts.password, &opts.secret),
        connections: RwLock::new(vec![]),
        drivers: Mutex::new(HashMap::new()),
        make_driver: opts.make_driver.unwrap_or_else(|| Arc::new(default_driver)),
        chat: opts.chat.map(|c| Chat::new(c, opts.data_file.parent().unwrap_or(std::path::Path::new(".")).join("chat"))),
        port: OnceLock::new(),
    });
    let loaded = state.load()?;
    *state.connections.write().unwrap() = loaded;

    let mut api = Router::new()
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/features", get(features))
        .route("/api/connections", get(list_connections).post(save_connection))
        .route("/api/connections/test", post(test_connection))
        .route("/api/connections/{id}", delete(delete_connection))
        .route("/api/c/{id}/info", get(info))
        .route("/api/c/{id}/schemas", get(schemas))
        .route("/api/c/{id}/tables", get(tables))
        .route("/api/c/{id}/columns", get(columns))
        .route("/api/c/{id}/completion", get(completion))
        .route("/api/c/{id}/describe", get(describe))
        .route("/api/c/{id}/query", post(query))
        .route("/api/c/{id}/rows", post(rows))
        .route("/api/c/{id}/save", post(save_rows))
        .route("/api/c/{id}/cancel", post(cancel));
    if state.desktop {
        api = api.route("/api/desktop-login", get(desktop_login));
    }
    if state.chat.is_some() {
        // outside /api (never proxied to the browser): the chat's database tools, for the Claude Code process only (token)
        api = api.route("/mcp", any(crate::chat::mcp)).route("/api/c/{id}/chat", post(crate::chat::chat));
    }
    let router = api
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(DefaultBodyLimit::max(20 * 1024 * 1024))
        .with_state(state.clone());
    Ok((router, state))
}

// Every /api route but the login ones needs a valid session cookie
async fn guard(State(s): State<Shared>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_ascii_lowercase();
    let under_api = path == "/api" || path.starts_with("/api/");
    let open = matches!(path.as_str(), "/api/login" | "/api/logout") || (s.desktop && path == "/api/desktop-login");
    if under_api && !open {
        let cookie = req.headers().get(header::COOKIE).and_then(|v| v.to_str().ok());
        if !s.auth.session_ok(cookie) {
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Not authenticated" }))).into_response();
        }
    }
    next.run(req).await
}

fn attempt_response(a: Attempt, success: impl FnOnce(String) -> Response) -> Response {
    match a {
        Attempt::Ok(cookie) => success(cookie),
        Attempt::TooMany => {
            (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "Too many attempts, try again in a minute" }))).into_response()
        }
        Attempt::Wrong => (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Wrong password" }))).into_response(),
    }
}

async fn login(State(s): State<Shared>, body: Bytes) -> Response {
    let body = body_json(&body);
    let a = s.auth.attempt(body.get("password").and_then(Value::as_str)).await;
    attempt_response(a, |cookie| ([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response())
}

// Desktop app: the window opens GET /api/desktop-login?token=<launch token> (the password of this launch), which sets
// the cookie and goes on to the app, so there is no login dialog.
async fn desktop_login(State(s): State<Shared>, Query(query): Query<HashMap<String, String>>) -> Response {
    let a = s.auth.attempt(query.get("token").map(String::as_str)).await;
    attempt_response(a, |cookie| (StatusCode::SEE_OTHER, [(header::SET_COOKIE, cookie), (header::LOCATION, "/".into())]).into_response())
}

async fn logout() -> Response {
    ([(header::SET_COOKIE, logout_cookie())], Json(json!({ "ok": true }))).into_response()
}

async fn features(State(s): State<Shared>) -> ApiResult {
    let run_query = s.chat.as_ref().is_some_and(|c| c.run_query());
    ok(Features { chat: s.chat.is_some(), chat_run_query: run_query, desktop: s.desktop })
}

async fn list_connections(State(s): State<Shared>) -> ApiResult {
    ok(s.connections.read().unwrap().iter().map(public_conn).collect::<Vec<_>>())
}

async fn save_connection(State(s): State<Shared>, body: Bytes) -> ApiResult {
    let body = body_json(&body);
    let id = str_of(&body, "id");
    let prev = id.and_then(|id| s.connections.read().unwrap().iter().find(|c| c.id == id).cloned());
    let user = str_of(&body, "user").unwrap_or("").to_string();
    let host = str_of(&body, "host").unwrap_or("localhost").to_string();
    let cfg = ConnectionConfig {
        id: prev.as_ref().map_or_else(|| uuid::Uuid::new_v4().to_string(), |p| p.id.clone()),
        name: str_of(&body, "name").map_or_else(|| format!("{user}@{host}"), str::to_string),
        kind: dialect_of(&body),
        port: port_of(&body),
        password: password_of(&body, prev.as_ref()),
        database: str_of(&body, "database").unwrap_or("").to_string(),
        ssl: js::truthy(body.get("ssl")),
        host,
        user,
    };
    {
        let mut list = s.connections.write().unwrap();
        match list.iter_mut().find(|c| c.id == cfg.id) {
            Some(c) => *c = cfg.clone(),
            None => list.push(cfg.clone()),
        }
        s.save(&list)?;
    }
    s.drop_driver(&cfg.id).await;
    ok(public_conn(&cfg))
}

async fn delete_connection(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult {
    s.drop_driver(&id).await;
    {
        let mut list = s.connections.write().unwrap();
        list.retain(|c| c.id != id);
        s.save(&list)?;
    }
    ok(json!({ "ok": true }))
}

async fn test_connection(State(s): State<Shared>, body: Bytes) -> ApiResult {
    let body = body_json(&body);
    let prev = str_of(&body, "id").and_then(|id| s.connections.read().unwrap().iter().find(|c| c.id == id).cloned());
    let password = password_of(&body, prev.as_ref());
    let d = (s.make_driver)(&DriverConfig {
        kind: dialect_of(&body),
        host: Some(str_of(&body, "host").unwrap_or("localhost").to_string()),
        port: port_of(&body),
        user: body.get("user").and_then(Value::as_str).map(str::to_string),
        password: (!password.is_empty()).then_some(password),
        database: body.get("database").and_then(Value::as_str).filter(|d| !d.is_empty()).map(str::to_string),
        ssl: js::truthy(body.get("ssl")),
    });
    let r = d.test().await;
    d.close().await;
    ok(json!({ "version": r? }))
}

type Q = Query<HashMap<String, String>>;

async fn info(State(s): State<Shared>, Path(id): Path<String>) -> ApiResult {
    let d = s.driver(&id)?;
    ok(json!({ "hasSchemas": d.has_schemas(), "databases": d.databases().await? }))
}

async fn schemas(State(s): State<Shared>, Path(id): Path<String>, Query(p): Q) -> ApiResult {
    ok(s.driver(&id)?.schemas(q(&p, "db")).await?)
}

async fn tables(State(s): State<Shared>, Path(id): Path<String>, Query(p): Q) -> ApiResult {
    ok(s.driver(&id)?.tables(q(&p, "db"), q(&p, "schema")).await?)
}

async fn columns(State(s): State<Shared>, Path(id): Path<String>, Query(p): Q) -> ApiResult {
    ok(s.driver(&id)?.columns(q(&p, "db"), q(&p, "schema"), q(&p, "table").unwrap_or("")).await?)
}

async fn completion(State(s): State<Shared>, Path(id): Path<String>, Query(p): Q) -> ApiResult {
    ok(s.driver(&id)?.completion(q(&p, "db"), q(&p, "schema")).await?)
}

async fn describe(State(s): State<Shared>, Path(id): Path<String>, Query(p): Q) -> ApiResult {
    let d = s.driver(&id)?.describe(q(&p, "db"), q(&p, "schema")).await?;
    ok(json!({ "markdown": to_markdown(&d) }))
}

fn clamp(v: Option<&Value>, fallback: f64, min: f64, max: f64) -> usize {
    js::num_or(v, fallback).floor().clamp(min, max) as usize
}

async fn query(State(s): State<Shared>, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let d = s.driver(&id)?;
    let body = body_json(&body);
    let explain = match body.get("explain").and_then(Value::as_str) {
        Some("plan") => Some(ExplainMode::Plan),
        Some("analyze") => Some(ExplainMode::Analyze),
        _ => None,
    };
    let max_rows = js::num_or(body.get("maxRows"), 500.0).clamp(1.0, 100_000.0) as usize;
    let sql = body.get("sql").and_then(Value::as_str).unwrap_or("");
    let statements = split_sql(sql, if d.has_schemas() { Dialect::Postgres } else { Dialect::Mariadb });
    if statements.is_empty() {
        return ok(json!({ "results": [] }));
    }
    let (db, schema) = (owned(&body, "db"), owned(&body, "schema"));
    let results = detached(async move { d.run(db.as_deref(), schema.as_deref(), statements, max_rows, explain).await }).await?;
    ok(json!({ "results": results }))
}

async fn rows(State(s): State<Shared>, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let body = body_json(&body);
    let sql = body.get("sql").and_then(Value::as_str).filter(|sql| is_pageable(sql));
    let Some(sql) = sql.map(str::to_string) else { return Err(Error::new("Only a read-only query can fetch more rows").into()) };
    let offset = js::num_or(body.get("offset"), 0.0).floor().max(0.0) as usize;
    let count = clamp(body.get("count"), 500.0, 1.0, 100_000.0);
    let d = s.driver(&id)?;
    let (db, schema) = (owned(&body, "db"), owned(&body, "schema"));
    ok(detached(async move { d.page(db.as_deref(), schema.as_deref(), &sql, offset, count).await }).await?)
}

async fn save_rows(State(s): State<Shared>, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let body = body_json(&body);
    let invalid = || ApiError(Error::new("Invalid save request"));
    let target: TableRef = serde_json::from_value(body.get("target").cloned().unwrap_or(Value::Null)).map_err(|_| invalid())?;
    let changes = body.get("changes").and_then(Value::as_array).filter(|c| !c.is_empty()).ok_or_else(invalid)?;
    let changes: Vec<RowChange> =
        changes.iter().map(|c| serde_json::from_value(c.clone()).map_err(|_| invalid())).collect::<Result<_, _>>()?;
    let d = s.driver(&id)?;
    let (db, schema) = (owned(&body, "db"), owned(&body, "schema"));
    let updated = detached(async move { d.save(db.as_deref(), schema.as_deref(), &target, &changes).await }).await?;
    ok(json!({ "updated": updated }))
}

async fn cancel(State(s): State<Shared>, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let body = body_json(&body);
    ok(json!({ "cancelled": s.driver(&id)?.cancel(str_of(&body, "db")).await? }))
}

// A request's Host header, for the desktop app's check
pub fn host_of(h: &HeaderMap) -> Option<&str> {
    h.get(header::HOST).and_then(|v| v.to_str().ok())
}
