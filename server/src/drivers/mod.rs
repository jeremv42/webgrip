// What the API needs from a database engine. `db` / `schema` left empty = the connection's defaults.

pub mod edit;
pub mod mariadb;
pub mod plan;
pub mod postgres;

use crate::error::Result;
use crate::types::*;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

// Time limit of a chat query
pub const EXPLORE_TIMEOUT_MS: u64 = 30_000;

pub type Db<'a> = Option<&'a str>;

#[async_trait]
pub trait Driver: Send + Sync {
    fn has_schemas(&self) -> bool;
    async fn test(&self) -> Result<String>;
    async fn databases(&self) -> Result<Vec<String>>;
    async fn schemas(&self, db: Db<'_>) -> Result<Vec<String>>;
    async fn tables(&self, db: Db<'_>, schema: Db<'_>) -> Result<Vec<TableInfo>>;
    async fn columns(&self, db: Db<'_>, schema: Db<'_>, table: &str) -> Result<Vec<ColumnInfo>>;
    async fn completion(&self, db: Db<'_>, schema: Db<'_>) -> Result<CompletionInfo>;
    async fn describe(&self, db: Db<'_>, schema: Db<'_>) -> Result<SchemaDescription>;
    // Runs the statements in order on the database's dedicated session; stops at the first error.
    // With `explain`, each statement is wrapped in EXPLAIN; ANALYZE runs it in a transaction (or savepoint) rolled back
    // afterwards. Each result is a StatementResult (shared/types.ts).
    async fn run(
        &self,
        db: Db<'_>,
        schema: Db<'_>,
        statements: Vec<Statement>,
        max_rows: usize,
        explain: Option<ExplainMode>,
    ) -> Result<Vec<Value>>;
    // Runs a read-only statement again and returns `count` rows from `offset` (a RowsPage).
    async fn page(&self, db: Db<'_>, schema: Db<'_>, sql: &str, offset: usize, count: usize) -> Result<Value>;
    // Updates edited rows on the editor session, all or nothing (inside the session's transaction if one is open);
    // each change must hit exactly one row. Returns the number of rows updated.
    async fn save(&self, db: Db<'_>, schema: Db<'_>, target: &TableRef, changes: &[RowChange]) -> Result<usize>;
    // Runs one statement for the chat on a fresh connection (never the editor session), inside a read-only transaction
    // that is rolled back, with a time limit (EXPLORE_TIMEOUT_MS). Keeps at most max_rows rows.
    async fn explore(&self, db: Db<'_>, schema: Db<'_>, sql: &str, max_rows: usize) -> Result<ExploreResult>;
    async fn cancel(&self, db: Db<'_>) -> Result<bool>;
    async fn close(&self);
}

pub fn default_driver(cfg: &DriverConfig) -> Arc<dyn Driver> {
    match cfg.kind {
        Dialect::Mariadb => Arc::new(mariadb::MariadbDriver::new(cfg.clone())),
        Dialect::Postgres => Arc::new(postgres::PostgresDriver::new(cfg.clone())),
    }
}

// The session of a database is taken by one request at a time: the flag is cleared when this is dropped.
pub struct Busy<'a>(&'a std::sync::atomic::AtomicBool);

impl<'a> Busy<'a> {
    pub fn take(flag: &'a std::sync::atomic::AtomicBool) -> Result<Self> {
        if flag.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::error::Error::new("A query is already running on this database"));
        }
        Ok(Busy(flag))
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

// Milliseconds since `t0`, as a fraction
pub fn ms_since(t0: std::time::Instant) -> f64 {
    t0.elapsed().as_secs_f64() * 1000.0
}

// The base of a StatementResult: the statement and its offsets
pub fn statement_json(st: &Statement) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    m.insert("sql".into(), st.sql.clone().into());
    m.insert("start".into(), st.start.into());
    m.insert("end".into(), st.end.into());
    m
}
