// The HTTP API with a fake driver that records what it is asked: connections, the password, the routes, the chat
// (with a fake `claude` CLI that calls the MCP tools like the real one).

use async_trait::async_trait;
use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use webgrip_server::drivers::{Db, Driver};
use webgrip_server::error::{Error, Result};
use webgrip_server::types::*;
use webgrip_server::{create_app, AppOptions, ChatOptions};

const SECRET: &str = "test-secret-0123456789";
const PASSWORD: &str = "pw";

#[derive(Default)]
struct Fake {
    cfg: DriverConfig,
    calls: Mutex<Vec<String>>,
    closed: Mutex<bool>,
    fail_test: bool,
}

impl Fake {
    fn log(&self, s: String) {
        self.calls.lock().unwrap().push(s);
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn closed(&self) -> bool {
        *self.closed.lock().unwrap()
    }
}

#[async_trait]
impl Driver for Fake {
    fn has_schemas(&self) -> bool {
        self.cfg.kind != Dialect::Mariadb
    }
    async fn test(&self) -> Result<String> {
        if self.fail_test {
            return Err(Error::new("connection refused"));
        }
        Ok(format!(
            "fake {:?} for {}:{}",
            self.cfg.kind,
            self.cfg.user.as_deref().unwrap_or(""),
            self.cfg.password.as_deref().unwrap_or("")
        ))
    }
    async fn databases(&self) -> Result<Vec<String>> {
        Ok(vec!["app".into(), "postgres".into()])
    }
    async fn schemas(&self, db: Db<'_>) -> Result<Vec<String>> {
        self.log(format!("schemas {db:?}"));
        Ok(vec!["public".into()])
    }
    async fn tables(&self, db: Db<'_>, schema: Db<'_>) -> Result<Vec<TableInfo>> {
        self.log(format!("tables {db:?} {schema:?}"));
        Ok(vec![TableInfo { name: "t".into(), kind: TableKind::Table }])
    }
    async fn columns(&self, db: Db<'_>, schema: Db<'_>, table: &str) -> Result<Vec<ColumnInfo>> {
        self.log(format!("columns {db:?} {schema:?} {table}"));
        Ok(vec![])
    }
    async fn completion(&self, _: Db<'_>, _: Db<'_>) -> Result<CompletionInfo> {
        Ok(CompletionInfo { current: None, schemas: vec![], tables: vec![], functions: vec![] })
    }
    async fn describe(&self, db: Db<'_>, _: Db<'_>) -> Result<SchemaDescription> {
        Ok(SchemaDescription {
            engine: "Fake".into(),
            version: "1".into(),
            database: db.unwrap_or("").into(),
            schema: None,
            schemas: None,
            tables: vec![],
        })
    }
    async fn run(
        &self,
        db: Db<'_>,
        schema: Db<'_>,
        st: Vec<Statement>,
        max_rows: usize,
        explain: Option<ExplainMode>,
    ) -> Result<Vec<Value>> {
        self.log(format!("run {db:?} {schema:?} {:?} {max_rows} {explain:?}", st.iter().map(|s| s.sql.as_str()).collect::<Vec<_>>()));
        Ok(st
            .iter()
            .map(|s| json!({ "sql": s.sql, "start": s.start, "end": s.end, "kind": "command", "command": "OK", "ms": 1 }))
            .collect())
    }
    async fn page(&self, db: Db<'_>, schema: Db<'_>, sql: &str, offset: usize, count: usize) -> Result<Value> {
        self.log(format!("page {db:?} {schema:?} {sql} {offset} {count}"));
        Ok(json!({ "rows": [[offset], [offset + count - 1]], "truncated": true }))
    }
    async fn save(&self, db: Db<'_>, schema: Db<'_>, target: &TableRef, changes: &[RowChange]) -> Result<usize> {
        self.log(format!("save {db:?} {schema:?} {}.{} {}", target.schema, target.table, changes.len()));
        Ok(changes.len())
    }
    async fn explore(&self, db: Db<'_>, schema: Db<'_>, sql: &str, max_rows: usize) -> Result<ExploreResult> {
        self.log(format!("explore {db:?} {schema:?} {sql} {max_rows}"));
        Ok(ExploreResult::Rows {
            columns: vec![ResultColumn { name: "x".into(), kind: "int4".into() }],
            rows: vec![vec![sql.into()]],
            truncated: false,
        })
    }
    async fn cancel(&self, db: Db<'_>) -> Result<bool> {
        self.log(format!("cancel {db:?}"));
        Ok(true)
    }
    async fn close(&self) {
        *self.closed.lock().unwrap() = true;
    }
}

struct Api {
    base: String,
    http: Client,
    cookie: String,
    made: Arc<Mutex<Vec<Arc<Fake>>>>,
    data_file: PathBuf,
    _dir: Option<tempfile::TempDir>,
}

struct Setup {
    chat: Option<ChatOptions>,
    fail_test: bool,
    desktop: bool,
    password: String,
}

impl Default for Setup {
    fn default() -> Self {
        Setup { chat: None, fail_test: false, desktop: false, password: PASSWORD.into() }
    }
}

async fn start_in(dir: &Path, setup: Setup) -> std::result::Result<Api, String> {
    let made: Arc<Mutex<Vec<Arc<Fake>>>> = Default::default();
    let m = made.clone();
    let fail_test = setup.fail_test;
    let data_file = dir.join("data").join("connections.json");
    let (router, state) = create_app(AppOptions {
        data_file: data_file.clone(),
        secret: SECRET.into(),
        password: setup.password.clone(),
        make_driver: Some(Arc::new(move |cfg: &DriverConfig| {
            let d = Arc::new(Fake { cfg: cfg.clone(), fail_test, ..Default::default() });
            m.lock().unwrap().push(d.clone());
            d as Arc<dyn Driver>
        })),
        chat: setup.chat,
        desktop: setup.desktop,
    })?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    state.port.set(port).unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let base = format!("http://127.0.0.1:{port}");
    let http = Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let mut api = Api { base, http, cookie: String::new(), made, data_file, _dir: None };
    if !setup.desktop {
        let res = api.login(&setup.password).await;
        api.cookie = res.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string();
    }
    Ok(api)
}

async fn start(setup: Setup) -> Api {
    let dir = tempfile::tempdir().unwrap();
    let mut api = start_in(dir.path(), setup).await.unwrap();
    api._dir = Some(dir);
    api
}

impl Api {
    async fn login(&self, pw: &str) -> reqwest::Response {
        self.http.post(format!("{}/api/login", self.base)).json(&json!({ "password": pw })).send().await.unwrap()
    }
    async fn call(&self, method: Method, url: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = self.http.request(method, format!("{}/api{url}", self.base)).header("cookie", &self.cookie);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.unwrap();
        let status = res.status();
        (status, res.json().await.unwrap_or(Value::Null))
    }
    async fn get(&self, url: &str) -> (StatusCode, Value) {
        self.call(Method::GET, url, None).await
    }
    async fn post(&self, url: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::POST, url, Some(body)).await
    }
    async fn save_conn(&self, form: Value) -> Value {
        self.post("/connections", form).await.1
    }
    fn stored(&self) -> Value {
        let sealed: Value = serde_json::from_str(&std::fs::read_to_string(&self.data_file).unwrap()).unwrap();
        serde_json::from_str(&webgrip_server::vault::unseal(&sealed, SECRET).unwrap()).unwrap()
    }
    fn made(&self, i: usize) -> Arc<Fake> {
        self.made.lock().unwrap()[i].clone()
    }
    fn count(&self) -> usize {
        self.made.lock().unwrap().len()
    }
}

#[cfg(unix)]
fn mode(p: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

// ---------------- connections ----------------

#[tokio::test]
async fn saves_a_connection_with_defaults_and_never_returns_its_password() {
    let api = start(Setup::default()).await;
    let c = api.save_conn(json!({ "user": "bob", "password": "secret", "port": "6543" })).await;
    assert!(c["id"].is_string());
    let mut want = json!({ "name": "bob@localhost", "type": "postgres", "host": "localhost", "port": 6543, "user": "bob", "database": "", "ssl": false, "hasPassword": true });
    want["id"] = c["id"].clone();
    assert_eq!(c, want);
    assert_eq!(api.get("/connections").await.1, json!([c]));
    // stored on disk encrypted, password included, readable by the owner only
    assert!(!std::fs::read_to_string(&api.data_file).unwrap().contains("secret"));
    assert_eq!(api.stored()[0]["password"], "secret");
    #[cfg(unix)]
    assert_eq!(mode(&api.data_file), 0o600);
}

#[tokio::test]
async fn keeps_the_stored_password_on_edit_only_when_asked_to() {
    let api = start(Setup::default()).await;
    let c = api.save_conn(json!({ "name": "db", "user": "bob", "password": "secret", "type": "mariadb" })).await;
    let mut edit = c.clone();
    edit["name"] = "renamed".into();
    edit["password"] = "".into();
    edit["keepPassword"] = true.into();
    api.save_conn(edit.clone()).await;
    let s = api.stored();
    assert_eq!(s.as_array().unwrap().len(), 1);
    assert_eq!(
        (s[0]["id"].clone(), s[0]["name"].clone(), s[0]["type"].clone(), s[0]["password"].clone()),
        (c["id"].clone(), "renamed".into(), "mariadb".into(), "secret".into())
    );
    edit["keepPassword"] = false.into();
    api.save_conn(edit).await;
    assert_eq!(api.stored()[0]["password"], "");
}

#[tokio::test]
async fn reloads_the_saved_connections_at_startup_and_keeps_the_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let api = start_in(dir.path(), Setup::default()).await.unwrap();
    let c = api.save_conn(json!({ "user": "bob", "host": "db" })).await;
    let other = start_in(dir.path(), Setup::default()).await.unwrap();
    // the session cookie of the first server stays valid
    let res = other.http.get(format!("{}/api/connections", other.base)).header("cookie", &api.cookie).send().await.unwrap();
    assert_eq!(res.json::<Value>().await.unwrap(), json!([c]));
}

#[tokio::test]
async fn encrypts_a_plain_text_connections_file_written_by_an_older_version() {
    let dir = tempfile::tempdir().unwrap();
    let plain =
        json!([{ "id": "x", "name": "old", "type": "postgres", "host": "h", "user": "u", "password": "p", "database": "", "ssl": false }]);
    std::fs::create_dir_all(dir.path().join("data")).unwrap();
    std::fs::write(dir.path().join("data/connections.json"), plain.to_string()).unwrap();
    let api = start_in(dir.path(), Setup::default()).await.unwrap();
    assert!(!std::fs::read_to_string(&api.data_file).unwrap().contains("\"p\""));
    assert_eq!(api.stored(), plain);
    #[cfg(unix)]
    assert_eq!(mode(&api.data_file), 0o600);
    let mut public = plain[0].clone();
    public.as_object_mut().unwrap().remove("password");
    public["hasPassword"] = true.into();
    assert_eq!(api.get("/connections").await.1, json!([public]));
}

#[tokio::test]
async fn refuses_to_start_with_the_wrong_secret_instead_of_losing_the_connections() {
    let dir = tempfile::tempdir().unwrap();
    let api = start_in(dir.path(), Setup::default()).await.unwrap();
    api.save_conn(json!({ "user": "bob" })).await;
    let err = create_app(AppOptions {
        data_file: api.data_file.clone(),
        secret: "another-secret-012345".into(),
        password: PASSWORD.into(),
        make_driver: None,
        chat: None,
        desktop: false,
    })
    .err()
    .unwrap();
    assert!(err.contains("WEBGRIP_SECRET"), "{err}");
    assert_eq!(api.stored().as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn deletes_a_connection_and_closes_its_driver() {
    let api = start(Setup::default()).await;
    let c = api.save_conn(json!({ "user": "bob" })).await;
    let id = c["id"].as_str().unwrap();
    api.get(&format!("/c/{id}/info")).await;
    assert_eq!(api.call(Method::DELETE, &format!("/connections/{id}"), None).await.1, json!({ "ok": true }));
    assert!(api.made(0).closed());
    assert_eq!(api.get("/connections").await.1, json!([]));
}

#[tokio::test]
async fn drops_the_live_driver_when_a_connection_is_edited() {
    let api = start(Setup::default()).await;
    let c = api.save_conn(json!({ "user": "bob" })).await;
    let id = c["id"].as_str().unwrap();
    api.get(&format!("/c/{id}/info")).await;
    let mut edit = c.clone();
    edit["host"] = "elsewhere".into();
    api.save_conn(edit).await;
    assert!(api.made(0).closed());
    api.get(&format!("/c/{id}/info")).await;
    assert_eq!(api.made(1).cfg.host.as_deref(), Some("elsewhere"));
}

#[tokio::test]
async fn tests_a_configuration_with_the_stored_password_then_closes_the_driver() {
    let api = start(Setup::default()).await;
    let mut c = api.save_conn(json!({ "user": "bob", "password": "secret" })).await;
    c["password"] = "".into();
    c["keepPassword"] = true.into();
    assert_eq!(api.post("/connections/test", c).await.1, json!({ "version": "fake Postgres for bob:secret" }));
    assert!(api.made(0).closed());
}

#[tokio::test]
async fn reports_a_failed_test_as_a_400_with_the_error_message() {
    let api = start(Setup { fail_test: true, ..Default::default() }).await;
    assert_eq!(
        api.post("/connections/test", json!({ "user": "bob" })).await,
        (StatusCode::BAD_REQUEST, json!({ "error": "connection refused" }))
    );
}

// ---------------- database routes ----------------

#[tokio::test]
async fn answers_404_for_an_unknown_connection() {
    let api = start(Setup::default()).await;
    assert_eq!(api.get("/c/nope/info").await, (StatusCode::NOT_FOUND, json!({ "error": "Unknown connection" })));
}

#[tokio::test]
async fn reuses_one_driver_per_connection_and_passes_query_parameters() {
    let api = start(Setup::default()).await;
    let id = api.save_conn(json!({ "user": "bob" })).await["id"].as_str().unwrap().to_string();
    assert_eq!(api.get(&format!("/c/{id}/info")).await.1, json!({ "hasSchemas": true, "databases": ["app", "postgres"] }));
    api.get(&format!("/c/{id}/tables?db=app&schema=sales")).await;
    api.get(&format!("/c/{id}/columns?db=app&schema=sales&table=orders")).await;
    api.get(&format!("/c/{id}/schemas?db=")).await;
    assert_eq!(api.count(), 1);
    assert_eq!(
        api.made(0).calls(),
        vec!["tables Some(\"app\") Some(\"sales\")", "columns Some(\"app\") Some(\"sales\") orders", "schemas None"]
    );
}

#[tokio::test]
async fn exports_the_structure_as_markdown() {
    let api = start(Setup::default()).await;
    let id = api.save_conn(json!({ "user": "bob" })).await["id"].as_str().unwrap().to_string();
    let md = api.get(&format!("/c/{id}/describe?db=app")).await.1["markdown"].as_str().unwrap().to_string();
    assert!(md.starts_with("# app — 1\n"), "{md}");
}

#[tokio::test]
async fn splits_the_script_with_the_connection_dialect_and_clamps_max_rows() {
    let api = start(Setup::default()).await;
    let pg = api.save_conn(json!({ "user": "bob" })).await["id"].as_str().unwrap().to_string();
    let r = api.post(&format!("/c/{pg}/query"), json!({ "sql": "select `a;b`; select 2", "db": "app", "maxRows": 1e9 })).await.1;
    let sqls: Vec<&str> = r["results"].as_array().unwrap().iter().map(|r| r["sql"].as_str().unwrap()).collect();
    assert_eq!(sqls, ["select `a", "b`", "select 2"]);
    assert_eq!(api.made(0).calls().last().unwrap(), "run Some(\"app\") None [\"select `a\", \"b`\", \"select 2\"] 100000 None");
    let my = api.save_conn(json!({ "user": "bob", "type": "mariadb" })).await["id"].as_str().unwrap().to_string();
    api.post(&format!("/c/{my}/query"), json!({ "sql": "select `a;b`; select 2", "maxRows": 0 })).await;
    // 0 = the default
    assert_eq!(api.made(1).calls().last().unwrap(), "run None None [\"select `a;b`\", \"select 2\"] 500 None");
}

#[tokio::test]
async fn forwards_a_valid_explain_mode_only() {
    let api = start(Setup::default()).await;
    let id = api.save_conn(json!({ "user": "bob" })).await["id"].as_str().unwrap().to_string();
    api.post(&format!("/c/{id}/query"), json!({ "sql": "select 1", "explain": "analyze" })).await;
    assert!(api.made(0).calls().last().unwrap().ends_with("Some(Analyze)"));
    api.post(&format!("/c/{id}/query"), json!({ "sql": "select 1", "explain": "drop" })).await;
    assert!(api.made(0).calls().last().unwrap().ends_with("None"));
}

#[tokio::test]
async fn does_not_call_the_driver_for_an_empty_script() {
    let api = start(Setup::default()).await;
    let id = api.save_conn(json!({ "user": "bob" })).await["id"].as_str().unwrap().to_string();
    assert_eq!(api.post(&format!("/c/{id}/query"), json!({ "sql": " -- nothing ; " })).await.1, json!({ "results": [] }));
    assert!(api.made(0).calls().is_empty());
}

#[tokio::test]
async fn fetches_more_rows_of_a_read_only_statement_only_with_a_clamped_count() {
    let api = start(Setup::default()).await;
    let id = api.save_conn(json!({ "user": "bob" })).await["id"].as_str().unwrap().to_string();
    let r = api.post(&format!("/c/{id}/rows"), json!({ "db": "app", "sql": "select * from t", "offset": 500, "count": 1e9 })).await.1;
    assert_eq!(r, json!({ "rows": [[500], [100499]], "truncated": true }));
    assert_eq!(api.made(0).calls(), vec!["page Some(\"app\") None select * from t 500 100000"]);
    let refused = api.post(&format!("/c/{id}/rows"), json!({ "sql": "delete from t returning *", "offset": 0 })).await;
    assert_eq!(refused, (StatusCode::BAD_REQUEST, json!({ "error": "Only a read-only query can fetch more rows" })));
    assert_eq!(api.made(0).calls().len(), 1);
}

#[tokio::test]
async fn forwards_edited_rows_to_the_driver_and_rejects_a_malformed_save() {
    let api = start(Setup::default()).await;
    let id = api.save_conn(json!({ "user": "bob" })).await["id"].as_str().unwrap().to_string();
    let target = json!({ "schema": "public", "table": "orders" });
    let changes = json!([{ "key": { "id": "1" }, "set": { "note": "x" } }]);
    let ok = api.post(&format!("/c/{id}/save"), json!({ "db": "app", "schema": "", "target": target, "changes": changes })).await;
    assert_eq!(ok.1, json!({ "updated": 1 }));
    assert_eq!(api.made(0).calls(), vec!["save Some(\"app\") None public.orders 1"]);
    for body in [
        json!({ "target": target, "changes": [] }),
        json!({ "target": { "table": "t" }, "changes": changes }),
        json!({ "target": target, "changes": [{ "key": 1 }] }),
    ] {
        assert_eq!(api.post(&format!("/c/{id}/save"), body).await.0, StatusCode::BAD_REQUEST);
    }
    assert_eq!(api.made(0).calls().len(), 1);
}

#[tokio::test]
async fn forwards_cancel_to_the_driver() {
    let api = start(Setup::default()).await;
    let id = api.save_conn(json!({ "user": "bob" })).await["id"].as_str().unwrap().to_string();
    assert_eq!(api.post(&format!("/c/{id}/cancel"), json!({ "db": "app" })).await.1, json!({ "cancelled": true }));
    assert_eq!(api.made(0).calls(), vec!["cancel Some(\"app\")"]);
}

// ---------------- authentication ----------------

#[tokio::test]
async fn answers_401_to_every_route_without_a_valid_session_cookie() {
    let api = start(Setup::default()).await;
    for c in ["", "webgrip_session=9999999999.forged", "webgrip_session="] {
        let res = api.http.get(format!("{}/api/connections", api.base)).header("cookie", c).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(res.json::<Value>().await.unwrap(), json!({ "error": "Not authenticated" }));
    }
    let res = api.http.post(format!("{}/api/c/x/query", api.base)).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn logs_in_with_the_right_password_only_with_a_cookie_restricted_to_the_api() {
    let api = start(Setup::default()).await;
    let bad = api.login("wrong").await;
    assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
    assert!(bad.headers().get("set-cookie").is_none());
    let ok = api.login(PASSWORD).await;
    assert_eq!(ok.status(), StatusCode::OK);
    let cookie = ok.headers()["set-cookie"].to_str().unwrap().to_string();
    let re = regex::Regex::new(r"^webgrip_session=\d+\.[\w-]+; Path=/api; HttpOnly; SameSite=Strict; Max-Age=2592000$").unwrap();
    assert!(re.is_match(&cookie), "{cookie}");
}

#[tokio::test]
async fn invalidates_the_sessions_when_the_password_changes() {
    let dir = tempfile::tempdir().unwrap();
    let api = start_in(dir.path(), Setup::default()).await.unwrap();
    let other = start_in(dir.path(), Setup { password: "new".into(), ..Default::default() }).await.unwrap();
    let res = other.http.get(format!("{}/api/connections", other.base)).header("cookie", &api.cookie).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn clears_the_cookie_on_logout() {
    let api = start(Setup::default()).await;
    let res = api.http.post(format!("{}/api/logout", api.base)).header("cookie", &api.cookie).send().await.unwrap();
    let cookie = res.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with("webgrip_session=; ") && cookie.ends_with("Max-Age=0"), "{cookie}");
}

#[tokio::test]
async fn has_no_token_login_outside_the_desktop_app() {
    let api = start(Setup::default()).await;
    let res = api.http.get(format!("{}/api/desktop-login?token={PASSWORD}", api.base)).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED); // behind the guard, like any unknown route
    assert!(res.headers().get("set-cookie").is_none());
}

#[tokio::test]
async fn logs_the_desktop_window_in_with_the_launch_token_then_redirects_to_the_app() {
    let token = "a".repeat(64);
    let api = start(Setup { desktop: true, password: token.clone(), ..Default::default() }).await;
    let bad = api.http.get(format!("{}/api/desktop-login?token=wrong", api.base)).send().await.unwrap();
    assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);
    assert!(bad.headers().get("set-cookie").is_none());
    let ok = api.http.get(format!("{}/api/desktop-login?token={token}", api.base)).send().await.unwrap();
    assert_eq!(ok.status(), StatusCode::SEE_OTHER);
    assert_eq!(ok.headers()["location"], "/");
    let session = ok.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string();
    let features = api.http.get(format!("{}/api/features", api.base)).header("cookie", session).send().await.unwrap();
    assert_eq!(features.json::<Value>().await.unwrap(), json!({ "chat": false, "chatRunQuery": false, "desktop": true }));
}

// ---------------- chat, with a fake `claude` ----------------

const FAKE_CLAUDE: &str = r#"
const fs = require('node:fs')
const args = process.argv.slice(2)
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
let prompt = ''
process.stdin.on('data', (b) => (prompt += b))
process.stdin.on('end', async () => {
  if (prompt.includes('FAIL')) {
    process.stderr.write('Not logged in')
    process.exit(1)
  }
  const server = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8')).mcpServers.webgrip
  let n = 0
  const rpc = async (method, params) => {
    const res = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) })
    return (await res.json()).result
  }
  await rpc('initialize', { protocolVersion: '2025-06-18' })
  const tools = (await rpc('tools/list')).tools.map((t) => t.name)
  out({ type: 'system', subtype: 'init', session_id: opt('--resume') || '11111111-2222-3333-4444-555555555555' })
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify({ prompt, tools, model: opt('--model') }) } } })
  for (const sql of ['select 1', 'delete from t']) {
    const r = await rpc('tools/call', { name: 'run_query', arguments: { sql } })
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: sql, is_error: !!r.isError, content: r.content }] } })
  }
  out({ type: 'result', is_error: false, result: 'ok' })
})
"#;

fn node_available() -> bool {
    std::process::Command::new("node").arg("--version").output().is_ok()
}

async fn chat_api(run_query: bool) -> (Api, String, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("claude.cjs");
    std::fs::write(&script, FAKE_CLAUDE).unwrap();
    let bin = dir.path().join("claude");
    std::fs::write(&bin, format!("#!/bin/sh\nexec node \"{}\" \"$@\"\n", script.display())).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let chat = ChatOptions { bin: bin.to_string_lossy().into_owned(), model: Some("haiku".into()), run_query };
    let mut api = start_in(dir.path(), Setup { chat: Some(chat), ..Default::default() }).await.unwrap();
    let id = api.save_conn(json!({ "name": "demo" })).await["id"].as_str().unwrap().to_string();
    let chat_dir = dir.path().join("data").join("chat");
    api._dir = Some(dir);
    (api, id, chat_dir)
}

async fn events(api: &Api, id: &str, body: Value) -> Vec<Value> {
    let res = api.http.post(format!("{}/api/c/{id}/chat", api.base)).header("cookie", &api.cookie).json(&body).send().await.unwrap();
    assert!(res.headers()["content-type"].to_str().unwrap().contains("ndjson"));
    res.text().await.unwrap().lines().filter(|l| !l.is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[tokio::test]
async fn chat_is_off_unless_enabled() {
    let api = start(Setup::default()).await;
    let id = api.save_conn(json!({ "name": "demo" })).await["id"].as_str().unwrap().to_string();
    assert_eq!(api.get("/features").await.1, json!({ "chat": false, "chatRunQuery": false, "desktop": false }));
    assert_eq!(api.post(&format!("/c/{id}/chat"), json!({ "message": "hi" })).await.0, StatusCode::NOT_FOUND);
    let mcp = api.http.post(format!("{}/mcp", api.base)).send().await.unwrap();
    assert_eq!(mcp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn chat_streams_the_answer_with_the_read_only_tools_of_the_connection() {
    if !node_available() {
        return;
    }
    let (api, id, chat_dir) = chat_api(true).await;
    assert_eq!(api.get("/features").await.1, json!({ "chat": true, "chatRunQuery": true, "desktop": false }));
    let ev = events(&api, &id, json!({ "message": "How many?", "db": "shop", "schema": "sales" })).await;
    assert_eq!(ev[0], json!({ "type": "session", "id": "11111111-2222-3333-4444-555555555555" }));
    let text: Value = serde_json::from_str(ev[1]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        text,
        json!({
            "prompt": "[WebGrip] connection \"demo\" (PostgreSQL), database shop, schema sales\n\nHow many?",
            "tools": ["list_databases", "list_tables", "describe_schema", "run_query"],
            "model": "haiku",
        })
    );
    assert_eq!(ev[2], json!({ "type": "tool_result", "id": "select 1", "error": false, "text": "x (int4)\nselect 1\n(1 row)" }));
    assert_eq!((ev[3]["id"].clone(), ev[3]["error"].clone()), (json!("delete from t"), json!(true)));
    assert_eq!(ev[4], json!({ "type": "done" }));
    // only the read-only statement reached the driver, with the UI's database and schema
    assert_eq!(api.made(0).calls(), vec!["explore Some(\"shop\") Some(\"sales\") select 1 100"]);
    // the token died with the process, and its config file is gone
    let mcp = api.http.post(format!("{}/mcp", api.base)).header("authorization", "Bearer x").send().await.unwrap();
    assert_eq!(mcp.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(std::fs::read_dir(chat_dir).unwrap().count(), 0);
}

#[tokio::test]
async fn chat_without_run_query_gives_claude_no_way_to_read_rows() {
    if !node_available() {
        return;
    }
    let (api, id, _) = chat_api(false).await;
    assert_eq!(api.get("/features").await.1, json!({ "chat": true, "chatRunQuery": false, "desktop": false }));
    let ev = events(&api, &id, json!({ "message": "How many?" })).await;
    let text: Value = serde_json::from_str(ev[1]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text["tools"], json!(["list_databases", "list_tables", "describe_schema"]));
    // even called anyway, the tool is refused
    assert_eq!(ev[2]["error"], true);
    assert!(ev[2]["text"].as_str().unwrap().contains("disabled"));
    assert!(api.count() == 0 || api.made(0).calls().is_empty());
}

#[tokio::test]
async fn chat_continues_a_conversation_and_reports_a_cli_failure() {
    if !node_available() {
        return;
    }
    let (api, id, _) = chat_api(true).await;
    let session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let ev = events(&api, &id, json!({ "message": "again", "sessionId": session })).await;
    assert_eq!(ev[0], json!({ "type": "session", "id": session }));
    assert_eq!(events(&api, &id, json!({ "message": "FAIL" })).await, vec![json!({ "type": "done", "error": "Not logged in" })]);
}

#[tokio::test]
async fn chat_validates_the_request() {
    if !node_available() {
        return;
    }
    let (api, id, _) = chat_api(true).await;
    assert_eq!(api.post(&format!("/c/{id}/chat"), json!({ "message": " " })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(api.post(&format!("/c/{id}/chat"), json!({ "message": "hi", "sessionId": "--help" })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(api.post("/c/nope/chat", json!({ "message": "hi" })).await.0, StatusCode::NOT_FOUND);
}

// ---------------- the desktop app's server ----------------

#[tokio::test]
async fn desktop_server_serves_the_app_to_its_own_host_only_and_logs_the_window_in() {
    let dir = tempfile::tempdir().unwrap();
    let dist = dir.path().join("dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html><title>WebGrip</title>").unwrap();
    std::fs::write(dist.join("assets/app.js"), "console.log(1)").unwrap();
    let data = dir.path().join("data");
    std::env::set_var("WEBGRIP_CHAT", "0");
    let server = webgrip_server::desktop::start(&data, &dist).await.unwrap();
    let base = format!("http://127.0.0.1:{}", server.port);
    let http = Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();

    // the SPA, without a session
    let index = http.get(format!("{base}/")).send().await.unwrap();
    assert_eq!(index.status(), StatusCode::OK);
    assert!(index.text().await.unwrap().contains("<title>WebGrip</title>"));
    assert_eq!(http.get(format!("{base}/assets/app.js")).send().await.unwrap().status(), StatusCode::OK);
    // any other Host (DNS rebinding) gets nothing
    let other = http.get(format!("{base}/")).header("host", "evil.example").send().await.unwrap();
    assert_eq!(other.status(), StatusCode::MISDIRECTED_REQUEST);
    // the API needs the session the launch token gives
    assert_eq!(http.get(format!("{base}/api/connections")).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let login = http.get(&server.login_url).send().await.unwrap();
    assert_eq!(login.status(), StatusCode::SEE_OTHER);
    let cookie = login.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string();
    let features = http.get(format!("{base}/api/features")).header("cookie", cookie).send().await.unwrap();
    assert_eq!(features.json::<Value>().await.unwrap(), json!({ "chat": false, "chatRunQuery": false, "desktop": true }));

    // the connections' key, made at the first launch, readable by the owner only, kept for the next launch
    let key = std::fs::read_to_string(data.join("secret.key")).unwrap();
    #[cfg(unix)]
    assert_eq!(mode(&data.join("secret.key")), 0o600);
    let again = webgrip_server::desktop::start(&data, &dist).await.unwrap();
    assert_ne!(again.login_url, server.login_url, "a new token per launch");
    assert_eq!(std::fs::read_to_string(data.join("secret.key")).unwrap(), key);
}
