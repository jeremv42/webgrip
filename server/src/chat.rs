// Chat with Claude, through the Claude Code CLI installed on the server (`claude -p`, the account it is logged in with).
// Claude gets no built-in tool (no shell, no files): only the read-only database tools below, served over MCP by this
// API on /mcp to the CLI process, behind a token valid while that process runs.

use crate::app::{write_private, Shared};
use crate::chat_text::{cap, describe_for_chat, to_events, to_tsv, MAX_TEXT, SERVER};
use crate::drivers::Driver;
use crate::error::Error;
use crate::js;
use crate::sql::read_only_statement;
use crate::types::{ChatEvent, Dialect, ExploreResult};
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Clone, Debug)]
pub struct ChatOptions {
    // the Claude Code executable
    pub bin: String,
    // --model (alias or full name), else the CLI's default
    pub model: Option<String>,
    // whether Claude may run read-only queries itself (WEBGRIP_CHAT_RUN_QUERY). Off: it only sees the structure, never
    // a row; the user runs the queries and decides what to send it.
    pub run_query: bool,
}

// What the tools of one chat run work on: the connection, and the database / schema selected in the UI
#[derive(Clone, Debug)]
struct Scope {
    conn_id: String,
    db: Option<String>,
    schema: Option<String>,
}

pub struct Chat {
    opts: ChatOptions,
    dir: PathBuf,
    scopes: Mutex<HashMap<String, Scope>>, // token -> scope, while its CLI process runs
}

const DEFAULT_ROWS: f64 = 100.0;
const MAX_ROWS: f64 = 1000.0;
static UUID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap());

const QUERY_RULE_ON: &str = "- Your tools only reach that connection: list_databases, list_tables, describe_schema, run_query. Look at the real structure before writing a query that depends on it rather than guessing names. run_query is read-only (one statement, read-only transaction rolled back, 30 s limit, rows capped): use it to check a query, look at sample values or answer a question about the data. Keep result sets small (LIMIT, aggregates).";
const QUERY_RULE_OFF: &str = "- Your tools only reach that connection's structure: list_databases, list_tables, describe_schema. Look at the real structure before writing a query rather than guessing names. You cannot read any data (this is deliberate: the data may be private). When you need some, write the query and ask the user to run it; they may attach its result to their next message, or describe it. Never ask for more data than the question needs.";

fn system_prompt(run_query: bool) -> String {
    format!(
        "You are the assistant built into WebGrip, a web SQL client for PostgreSQL and MySQL/MariaDB. The user looks at a database through it and asks you about its structure and data, or for SQL.

- Each user message starts with a [WebGrip] line: the connection, its engine, and the database (and schema) selected in WebGrip. Write SQL for that engine; unqualified names resolve in that database / schema.
{}
- Never try to change data or structure. When the user wants a change (INSERT, UPDATE, DELETE, DDL…), write the SQL in your answer: they will review it and run it themselves.
- Put SQL meant for the user in ```sql fenced blocks: WebGrip shows an Insert button on them that appends the SQL to the editor.
- Answer in the user's language, concisely. Your answer is rendered as Markdown (tables included).",
        if run_query { QUERY_RULE_ON } else { QUERY_RULE_OFF }
    )
}

fn tools(run_query: bool) -> Vec<Value> {
    let mut t = vec![
        json!({
            "name": "list_databases",
            "description": "Databases of the connection; for PostgreSQL, also the schemas of one database (the selected one by default).",
            "inputSchema": { "type": "object", "properties": { "db": { "type": "string", "description": "Database whose schemas to list (PostgreSQL)" } } },
        }),
        json!({
            "name": "list_tables",
            "description": "Tables and views of a schema (PostgreSQL) or database (MySQL/MariaDB). Defaults: the selected database / schema.",
            "inputSchema": { "type": "object", "properties": { "db": { "type": "string" }, "schema": { "type": "string", "description": "PostgreSQL only" } } },
        }),
        json!({
            "name": "describe_schema",
            "description": "Structure of a schema (PostgreSQL) or database (MySQL/MariaDB) as Markdown: tables and views, columns with types, nullability, defaults, primary keys, foreign keys, indexes, estimated row counts. No data. Defaults: the selected database / schema. A large schema comes back as a compact overview (columns, primary and foreign keys): then pass \"tables\" to get the full detail of the tables you need.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "db": { "type": "string" },
                    "schema": { "type": "string", "description": "PostgreSQL only" },
                    "tables": { "type": "array", "items": { "type": "string" }, "description": "Only these tables / views, in full detail" },
                },
            },
        }),
    ];
    if run_query {
        t.push(json!({
            "name": "run_query",
            "description": "Runs ONE read-only statement (SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN, DESCRIBE) in a read-only transaction rolled back afterwards, with a 30 s time limit, and returns the rows as TSV (NULL for nulls, long values cut). Anything that writes is refused.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string" },
                    "db": { "type": "string", "description": "Default: the selected database" },
                    "schema": { "type": "string", "description": "PostgreSQL only; default: the selected schema" },
                    "max_rows": { "type": "number", "description": format!("Rows returned at most (default {DEFAULT_ROWS}, max {MAX_ROWS})") },
                },
                "required": ["sql"],
            },
        }));
    }
    t
}

fn nonempty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

async fn call_tool(d: &dyn Driver, scope: &Scope, name: &str, args: &Value, run_query: bool) -> Result<String, Error> {
    let arg_db = nonempty(args.get("db"));
    let db = arg_db.clone().or_else(|| scope.db.clone());
    let schema = nonempty(args.get("schema")).or_else(|| if arg_db.is_some() && arg_db != scope.db { None } else { scope.schema.clone() });
    let dialect = if d.has_schemas() { Dialect::Postgres } else { Dialect::Mariadb };
    match name {
        "list_databases" => {
            let mut lines = vec!["Databases:".to_string()];
            lines.extend(d.databases().await?.into_iter().map(|n| format!("- {n}")));
            if d.has_schemas() {
                lines.push(String::new());
                lines.push(format!("Schemas of {}:", db.as_deref().unwrap_or("the default database")));
                lines.extend(d.schemas(db.as_deref()).await?.into_iter().map(|n| format!("- {n}")));
            }
            Ok(lines.join("\n"))
        }
        "list_tables" => {
            let schema = d.has_schemas().then(|| schema.unwrap_or_else(|| "public".into()));
            let tables = d.tables(db.as_deref(), schema.as_deref()).await?;
            Ok(if tables.is_empty() {
                "No table".into()
            } else {
                tables
                    .iter()
                    .map(|t| format!("{} ({})", t.name, serde_json::to_value(&t.kind).unwrap().as_str().unwrap_or("")))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }
        "describe_schema" => {
            let tables: Option<Vec<String>> = args
                .get("tables")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).collect());
            let schema = d.has_schemas().then(|| schema.unwrap_or_else(|| "public".into()));
            let desc = d.describe(db.as_deref(), schema.as_deref()).await?;
            Ok(describe_for_chat(&desc, tables.as_deref(), MAX_TEXT))
        }
        "run_query" => {
            if !run_query {
                return Err(Error::new("Running queries is disabled: ask the user to run it"));
            }
            let sql = match args.get("sql") {
                None | Some(Value::Null) => String::new(),
                v => js::template(v),
            };
            let sql = read_only_statement(&sql, dialect).map_err(Error::new)?;
            let max_rows = js::num_or(args.get("max_rows"), DEFAULT_ROWS).floor().clamp(1.0, MAX_ROWS) as usize;
            Ok(match d.explore(db.as_deref(), schema.as_deref(), &sql, max_rows).await? {
                ExploreResult::Rows { columns, rows, truncated } => to_tsv(&columns, &rows, truncated),
                ExploreResult::Command { command } => format!("{command} (no rows)"),
            })
        }
        _ => Err(Error::new(format!("Unknown tool {name}"))),
    }
}

impl Chat {
    pub fn new(opts: ChatOptions, dir: PathBuf) -> Self {
        Chat { opts, dir, scopes: Mutex::new(HashMap::new()) }
    }

    pub fn run_query(&self) -> bool {
        self.opts.run_query
    }

    async fn answer(&self, state: &Shared, scope: &Scope, m: &Value) -> Value {
        match m.get("method").and_then(Value::as_str) {
            Some("initialize") => json!({
                "result": {
                    "protocolVersion": m.pointer("/params/protocolVersion").filter(|v| js::truthy(Some(v))).cloned().unwrap_or("2025-06-18".into()),
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": SERVER, "version": "1.0.0" },
                }
            }),
            Some("ping") => json!({ "result": {} }),
            Some("tools/list") => json!({ "result": { "tools": tools(self.opts.run_query) } }),
            Some("tools/call") => {
                let name = m.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
                let args = m.pointer("/params/arguments").filter(|a| !a.is_null()).cloned().unwrap_or(json!({}));
                let result = match state.driver(&scope.conn_id) {
                    Ok(d) => call_tool(d.as_ref(), scope, name, &args, self.opts.run_query).await,
                    Err(e) => Err(e),
                };
                match result {
                    Ok(text) => json!({ "result": { "content": [{ "type": "text", "text": cap(&text, "", MAX_TEXT) }] } }),
                    Err(e) => json!({ "result": { "content": [{ "type": "text", "text": e.full_text() }], "isError": true } }),
                }
            }
            method => json!({ "error": { "code": -32601, "message": format!("Method not found: {}", method.unwrap_or("undefined")) } }),
        }
    }
}

// MCP over HTTP (JSON answers, no SSE stream), for the CLI processes started below only
pub async fn mcp(State(state): State<Shared>, method: Method, headers: HeaderMap, body: Bytes) -> Response {
    let chat = state.chat.as_ref().expect("chat enabled");
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|a| a.strip_prefix("Bearer "))
        .filter(|t| !t.is_empty() && !t.contains(char::is_whitespace));
    let scope = token.and_then(|t| chat.scopes.lock().unwrap().get(t).cloned());
    let Some(scope) = scope else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Invalid token" }))).into_response();
    };
    if method != Method::POST {
        return (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response();
    }
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let batch = body.is_array();
    let messages = match &body {
        Value::Array(a) => a.clone(),
        v => vec![v.clone()],
    };
    let mut replies = Vec::new();
    for m in &messages {
        let id = m.get("id");
        if id.is_none_or(Value::is_null) {
            continue; // notification
        }
        let mut reply = json!({ "jsonrpc": "2.0", "id": id });
        if let (Some(r), Value::Object(a)) = (reply.as_object_mut(), chat.answer(&state, &scope, m).await) {
            r.extend(a);
        }
        replies.push(reply);
    }
    if replies.is_empty() {
        return StatusCode::ACCEPTED.into_response();
    }
    Json(if batch { Value::Array(replies) } else { replies.remove(0) }).into_response()
}

fn line(e: &ChatEvent) -> Bytes {
    Bytes::from(serde_json::to_string(e).unwrap() + "\n")
}

// POST /api/c/:id/chat: one user message → NDJSON stream of ChatEvent until Claude's answer is complete.
// Closing the request (Stop button) kills the CLI process.
pub async fn chat(State(state): State<Shared>, Path(conn_id): Path<String>, body: Bytes) -> Response {
    let chat = state.chat.as_ref().expect("chat enabled");
    let bad = |status: StatusCode, msg: &str| (status, Json(json!({ "error": msg }))).into_response();
    let cfg = match state.connection(&conn_id) {
        Ok(c) => c,
        Err(e) => return bad(StatusCode::NOT_FOUND, &e.message),
    };
    let body: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let message = body.get("message").and_then(Value::as_str).map(js::trim).unwrap_or("").to_string();
    if message.is_empty() {
        return bad(StatusCode::BAD_REQUEST, "Empty message");
    }
    let session_id = match body.get("sessionId") {
        None => None,
        Some(Value::String(s)) if UUID.is_match(s) => Some(s.clone()),
        Some(_) => return bad(StatusCode::BAD_REQUEST, "Invalid session id"),
    };

    let scope = Scope { conn_id: conn_id.clone(), db: nonempty(body.get("db")), schema: nonempty(body.get("schema")) };
    let token = {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(crate::vault::random::<24>())
    };
    // the token goes in a private file rather than on the command line (visible to every local user)
    let dir = chat.dir.clone();
    if let Err(e) = create_private_dir(&dir) {
        return bad(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    let mcp_file = dir.join(format!("mcp-{}.json", uuid::Uuid::new_v4()));
    let port = state.port.get().copied().unwrap_or(0);
    let config = json!({ "mcpServers": { SERVER: { "type": "http", "url": format!("http://127.0.0.1:{port}/mcp"), "headers": { "Authorization": format!("Bearer {token}") } } } });
    if let Err(e) = write_private(&mcp_file, config.to_string().as_bytes()) {
        return bad(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    chat.scopes.lock().unwrap().insert(token.clone(), scope.clone());

    let tool_names: Vec<String> =
        tools(chat.opts.run_query).iter().map(|t| format!("mcp__{SERVER}__{}", t["name"].as_str().unwrap())).collect();
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(mcp_file.to_string_lossy().into_owned());
    args.extend(["--allowedTools".into(), tool_names.join(",")]);
    args.extend(["--permission-mode", "dontAsk", "--setting-sources", "", "--disable-slash-commands", "--system-prompt"].map(String::from));
    args.push(system_prompt(chat.opts.run_query));
    if let Some(m) = &chat.opts.model {
        args.extend(["--model".into(), m.clone()]);
    }
    if let Some(id) = &session_id {
        args.extend(["--resume".into(), id.clone()]);
    }

    let engine = if cfg.kind == Dialect::Mariadb { "MySQL/MariaDB" } else { "PostgreSQL" };
    let mut where_ = Vec::new();
    if let Some(db) = &scope.db {
        where_.push(format!("database {db}"));
    }
    if cfg.kind != Dialect::Mariadb {
        if let Some(s) = &scope.schema {
            where_.push(format!("schema {s}"));
        }
    }
    let where_ = if where_.is_empty() { String::new() } else { format!(", {}", where_.join(", ")) };
    let prompt = format!("[WebGrip] connection \"{}\" ({engine}){where_}\n\n{message}", cfg.name);

    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(256);
    let bin = chat.opts.bin.clone();
    let st = state.clone();
    tokio::spawn(async move {
        let finish = |error: Option<String>| {
            st.chat.as_ref().unwrap().scopes.lock().unwrap().remove(&token);
            let _ = std::fs::remove_file(&mcp_file);
            error
        };
        let mut child = match Command::new(&bin)
            .args(&args)
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let err = finish(Some(format!("Cannot start {bin}: {e}")));
                let _ = tx.send(line(&ChatEvent::Done { error: err })).await;
                return;
            }
        };
        let mut stdin = child.stdin.take().unwrap();
        tokio::spawn(async move {
            // the process may die before reading its prompt
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
        let mut stderr_pipe = child.stderr.take().unwrap();
        let stderr_task = tokio::spawn(async move {
            let mut tail = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr_pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > 4000 {
                    tail.drain(..tail.len() - 4000);
                }
            }
            String::from_utf8_lossy(&tail).into_owned()
        });
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut done = false;
        let mut gone = false;
        loop {
            tokio::select! {
                next = lines.next_line() => match next {
                    Ok(Some(l)) => {
                        let Ok(msg) = serde_json::from_str::<Value>(&l) else { continue };
                        for e in to_events(&msg) {
                            done |= matches!(e, ChatEvent::Done { .. });
                            if tx.send(line(&e)).await.is_err() {
                                gone = true;
                            }
                        }
                        if gone { break; }
                    }
                    _ => break,
                },
                _ = tx.closed() => { gone = true; break; }
            }
        }
        if gone {
            // the browser closed the request (Stop button): stop Claude
            let _ = child.start_kill();
        }
        let _ = child.wait().await;
        let stderr = stderr_task.await.unwrap_or_default();
        let _ = finish(None);
        if !done && !gone {
            let error = Some(if js::trim(&stderr).is_empty() {
                "Claude stopped without answering".to_string()
            } else {
                js::trim(&stderr).to_string()
            });
            let _ = tx.send(line(&ChatEvent::Done { error })).await;
        }
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|b| (Ok::<_, std::io::Error>(b), rx)) });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap()
}

fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)
}
