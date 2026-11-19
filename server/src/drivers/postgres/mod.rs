// PostgreSQL: metadata through a small pool per database, the SQL editor on one dedicated session per database.

pub mod conn;
pub mod plan;

use crate::describe::group_by;
use crate::drivers::edit::{check_updated, edit_target_of, param_text, update_of, ColumnSource, SourceTable};
use crate::drivers::{ms_since, statement_json, Busy, Db, Driver, EXPLORE_TIMEOUT_MS};
use crate::error::{Error, Result};
use crate::sql::{is_pageable, strip_leading_comments};
use crate::types::*;
use async_trait::async_trait;
use conn::{Config, Field, PgConn, QueryResult, Row};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, LazyLock};
use std::time::Instant;
use tokio::sync::{Mutex, Semaphore};

static ROW_STATEMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*(select|with|values|table|show|explain|fetch)(?-u:\b)").unwrap());
static EXPLAIN_STATEMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*explain(?-u:\b)").unwrap());

pub fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

// The EXPLAIN put in front of a statement (none when it already is an EXPLAIN)
pub fn explain_prefix(sql: &str, mode: Option<ExplainMode>) -> String {
    match mode {
        Some(m) if !EXPLAIN_STATEMENT.is_match(sql) => {
            format!("EXPLAIN ({}FORMAT JSON) ", if m == ExplainMode::Analyze { "ANALYZE, BUFFERS, " } else { "" })
        }
        _ => String::new(),
    }
}

fn kind_of(relkind: &str) -> TableKind {
    match relkind {
        "v" => TableKind::View,
        "m" => TableKind::Matview,
        "f" => TableKind::Foreign,
        _ => TableKind::Table,
    }
}

fn kind_name(relkind: &str) -> &'static str {
    match relkind {
        "v" => "view",
        "m" => "matview",
        "f" => "foreign",
        _ => "table",
    }
}

// Rows of a metadata query, read by column name
struct Rows {
    names: Vec<String>,
    rows: Vec<Row>,
}

impl Rows {
    fn from(r: QueryResult) -> Rows {
        Rows { names: r.fields.unwrap_or_default().into_iter().map(|f| f.name).collect(), rows: r.rows }
    }
    fn iter(&self) -> impl Iterator<Item = R<'_>> {
        self.rows.iter().map(|row| R { names: &self.names, row })
    }
}

#[derive(Clone, Copy)]
struct R<'a> {
    names: &'a [String],
    row: &'a Row,
}

impl R<'_> {
    fn opt(&self, k: &str) -> Option<String> {
        let i = self.names.iter().position(|n| n == k)?;
        self.row.get(i).cloned().flatten()
    }
    fn s(&self, k: &str) -> String {
        self.opt(k).unwrap_or_default()
    }
    fn b(&self, k: &str) -> bool {
        self.opt(k).as_deref() == Some("t")
    }
}

// A few connections per database for the metadata queries
#[derive(Default)]
struct Pool {
    idle: std::sync::Mutex<Vec<PgConn>>,
    slots: Option<Semaphore>,
}

const POOL_SIZE: usize = 3;

struct Session {
    conn: Mutex<Option<PgConn>>,
    busy: AtomicBool,
    pid: i32,
}

pub struct PostgresDriver {
    cfg: DriverConfig,
    pools: std::sync::Mutex<HashMap<String, Arc<Pool>>>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    type_names: Mutex<HashMap<String, Arc<HashMap<u32, String>>>>,
}

impl PostgresDriver {
    pub fn new(cfg: DriverConfig) -> Self {
        PostgresDriver { cfg, pools: Default::default(), sessions: Default::default(), type_names: Default::default() }
    }

    fn default_db(&self) -> String {
        self.cfg.database.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "postgres".into())
    }

    fn db(&self, db: Db<'_>) -> String {
        db.filter(|d| !d.is_empty()).map(str::to_string).unwrap_or_else(|| self.default_db())
    }

    fn config(&self, db: &str) -> Config {
        Config {
            host: self.cfg.host.clone().unwrap_or_else(|| "localhost".into()),
            port: self.cfg.port.filter(|p| *p > 0 && *p < 65536).map_or(5432, |p| p as u16),
            user: self.cfg.user.clone().unwrap_or_else(|| std::env::var("USER").unwrap_or_default()),
            password: self.cfg.password.clone(),
            database: db.to_string(),
            ssl: self.cfg.ssl,
        }
    }

    fn pool(&self, db: &str) -> Arc<Pool> {
        let mut pools = self.pools.lock().unwrap();
        pools
            .entry(db.to_string())
            .or_insert_with(|| Arc::new(Pool { idle: Default::default(), slots: Some(Semaphore::new(POOL_SIZE)) }))
            .clone()
    }

    // A metadata query on the database's pool. A pooled connection found dead is replaced once.
    async fn q(&self, db: Db<'_>, sql: &str, params: &[Option<String>]) -> Result<Rows> {
        let db = self.db(db);
        let pool = self.pool(&db);
        let _slot = pool.slots.as_ref().unwrap().acquire().await.map_err(|_| Error::new("Connection closed"))?;
        let mut retried = false;
        loop {
            let reused = pool.idle.lock().unwrap().pop();
            let was_idle = reused.is_some();
            let mut c = match reused {
                Some(c) => c,
                None => PgConn::connect(&self.config(&db)).await?,
            };
            match c.query(sql, params).await {
                Ok(r) => {
                    pool.idle.lock().unwrap().push(c);
                    return Ok(Rows::from(r));
                }
                Err(e) if c.broken && was_idle && !retried => {
                    retried = true;
                    let _ = e;
                }
                Err(e) => {
                    if !c.broken {
                        pool.idle.lock().unwrap().push(c);
                    }
                    return Err(e);
                }
            }
        }
    }

    async fn type_name(&self, db: &str, oid: u32) -> Result<String> {
        let mut cache = self.type_names.lock().await;
        let names = match cache.get(db) {
            Some(m) => m.clone(),
            None => {
                let rows = self.q(Some(db), "select oid::int, typname from pg_type", &[]).await?;
                let m: HashMap<u32, String> = rows.iter().filter_map(|r| Some((r.s("oid").parse().ok()?, r.s("typname")))).collect();
                let m = Arc::new(m);
                cache.insert(db.to_string(), m.clone());
                m
            }
        };
        Ok(names.get(&oid).cloned().unwrap_or_else(|| oid.to_string()))
    }

    async fn columns_of(&self, db: &str, fields: &[Field]) -> Result<Vec<ResultColumn>> {
        let mut out = Vec::new();
        for f in fields {
            out.push(ResultColumn { name: f.name.clone(), kind: self.type_name(db, f.type_oid).await? });
        }
        Ok(out)
    }

    async fn session(&self, db: &str) -> Result<Arc<Session>> {
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.get(db) {
            return Ok(s.clone());
        }
        let c = PgConn::connect(&self.config(db)).await?;
        let s = Arc::new(Session { pid: c.pid, conn: Mutex::new(Some(c)), busy: AtomicBool::new(false) });
        sessions.insert(db.to_string(), s.clone());
        Ok(s)
    }

    // Forgets a session whose connection died (the next run opens a new one)
    async fn drop_if_broken(&self, db: &str, s: &Arc<Session>, conn: &Option<PgConn>) {
        if conn.as_ref().is_none_or(|c| c.broken) {
            let mut sessions = self.sessions.lock().await;
            if sessions.get(db).is_some_and(|x| Arc::ptr_eq(x, s)) {
                sessions.remove(db);
            }
        }
    }

    async fn use_schema(c: &mut PgConn, schema: Db<'_>) -> Result<()> {
        if let Some(schema) = schema.filter(|s| !s.is_empty()) {
            if c.schema.as_deref() != Some(schema) {
                c.execute(&format!("set search_path to {}{}", ident(schema), if schema == "public" { "" } else { ", public" })).await?;
                c.schema = Some(schema.to_string());
            }
        }
        Ok(())
    }

    // Reads one row more than max_rows through a portal, to know whether the result was truncated.
    async fn cursor_query(c: &mut PgConn, sql: &str, max_rows: usize) -> Result<QueryResult> {
        let fields = c.open_portal(sql).await?;
        let mut rows = Vec::new();
        let tag = c.fetch(i32::try_from(max_rows + 1).unwrap_or(i32::MAX), &mut rows).await?;
        c.close_portal().await?;
        Ok(QueryResult { fields, rows, tag })
    }

    // Runs the statement through a portal, skips `offset` rows (read by batches, never all kept) and returns the next `count`.
    async fn cursor_rows(c: &mut PgConn, sql: &str, offset: usize, count: usize) -> Result<Vec<Row>> {
        c.open_portal(sql).await?;
        let mut skip = offset;
        let mut done = false;
        while skip > 0 && !done {
            let mut batch = Vec::new();
            done = c.fetch(skip.min(5000) as i32, &mut batch).await?.is_some();
            if batch.is_empty() {
                c.close_portal().await?;
                return Ok(vec![]);
            }
            skip = skip.saturating_sub(batch.len());
        }
        let mut rows = Vec::new();
        if !done {
            c.fetch(i32::try_from(count).unwrap_or(i32::MAX), &mut rows).await?;
        }
        c.close_portal().await?;
        Ok(rows)
    }

    // EXPLAIN ANALYZE runs the statement: open a transaction (or a savepoint inside the user's own); returns what undoes it.
    async fn rollback_guard(c: &mut PgConn) -> Result<Option<&'static [&'static str]>> {
        match c.tx_status {
            b'E' => Ok(None), // failed transaction: the statement will be refused anyway
            b'T' => {
                c.execute("savepoint webgrip_explain").await?;
                Ok(Some(&["rollback to savepoint webgrip_explain", "release savepoint webgrip_explain"]))
            }
            _ => {
                c.execute("begin").await?;
                Ok(Some(&["rollback"]))
            }
        }
    }

    async fn run_one(
        &self,
        db: &str,
        c: &mut PgConn,
        st: &Statement,
        max_rows: usize,
        explain: Option<ExplainMode>,
    ) -> (Map<String, Value>, bool) {
        c.notices.clear();
        let prefix = explain_prefix(&st.sql, explain);
        let sql = format!("{prefix}{}", st.sql);
        let mut out = statement_json(st);
        let t0 = Instant::now();
        let mut undo = None;
        let result: Result<Map<String, Value>> = async {
            // (a failure here, e.g. in an aborted transaction, is the statement's error: it is not run)
            if !prefix.is_empty() && explain == Some(ExplainMode::Analyze) {
                undo = Self::rollback_guard(c).await?;
            }
            let r = if ROW_STATEMENT.is_match(strip_leading_comments(&sql)) {
                Self::cursor_query(c, &sql, max_rows).await?
            } else {
                c.simple(&sql).await?.pop().unwrap_or_default()
            };
            self.format(db, r, max_rows).await
        }
        .await;
        let ms = ms_since(t0);
        if let Some(undo) = undo {
            for sql in undo {
                // connection lost: the server rolls back anyway
                if c.execute(sql).await.is_err() {
                    break;
                }
            }
        }
        let notices: Vec<Value> = std::mem::take(&mut c.notices).into_iter().map(Value::from).collect();
        let failed = result.is_err();
        match result {
            Ok(fields) => out.extend(fields),
            Err(e) => {
                let position = e.position.map(|p| p - prefix.len() as i64).filter(|p| *p > 0);
                let mut error = Map::new();
                error.insert("message".into(), e.message.into());
                for (k, v) in [("detail", e.detail), ("hint", e.hint), ("code", e.code)] {
                    if let Some(v) = v {
                        error.insert(k.into(), v.into());
                    }
                }
                if let Some(p) = position {
                    error.insert("position".into(), p.into());
                }
                out.insert("kind".into(), "error".into());
                out.insert("error".into(), Value::Object(error));
            }
        }
        out.insert("ms".into(), json!(ms));
        out.insert("notices".into(), Value::Array(notices));
        if !prefix.is_empty() {
            out.insert("explain".into(), json!(explain));
        }
        (out, failed)
    }

    async fn format(&self, db: &str, r: QueryResult, max_rows: usize) -> Result<Map<String, Value>> {
        let mut out = Map::new();
        match r.fields.as_ref().filter(|f| !f.is_empty()) {
            Some(fields) => {
                let columns = self.columns_of(db, fields).await?;
                let truncated = r.rows.len() > max_rows;
                let rows: Vec<Vec<Value>> = r
                    .rows
                    .into_iter()
                    .take(max_rows)
                    .map(|row| row.into_iter().map(|v| v.map_or(Value::Null, Value::from)).collect())
                    .collect();
                // an EXPLAIN (FORMAT JSON) result, ours or typed by the user: also give it parsed
                let parsed = plan::plan_of(&columns, &rows);
                let editable = if parsed.is_none() { self.edit_target(db, fields).await } else { None };
                out.insert("kind".into(), "rows".into());
                out.insert("columns".into(), json!(columns));
                out.insert("rows".into(), json!(rows));
                out.insert("truncated".into(), truncated.into());
                if let Some(p) = parsed {
                    out.insert("plan".into(), json!(p));
                }
                if let Some(e) = editable {
                    out.insert("editable".into(), json!(e));
                }
            }
            None => {
                let (command, affected) = r.command();
                out.insert("kind".into(), "command".into());
                out.insert("command".into(), command.map_or(Value::Null, Value::from));
                if let Some(a) = affected {
                    out.insert("affected".into(), a.into());
                }
            }
        }
        Ok(out)
    }

    // Which table the rows can be updated in: the fields tell each column's table (oid) and column number.
    // A failure here only makes the result read-only.
    async fn edit_target(&self, db: &str, fields: &[Field]) -> Option<EditTarget> {
        let mut oids: Vec<u32> = Vec::new();
        for f in fields {
            if f.table_oid != 0 && !oids.contains(&f.table_oid) {
                oids.push(f.table_oid);
            }
        }
        if oids.is_empty() {
            return None;
        }
        let list = format!("{{{}}}", oids.iter().map(u32::to_string).collect::<Vec<_>>().join(","));
        let cols = self
            .q(
                Some(db),
                "
        select a.attrelid::int as rel, a.attnum as num, a.attname as name, n.nspname as s, c.relname as t,
               coalesce(a.attnum = any(i.indkey), false) as pk, a.attgenerated <> '' as ro
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid and c.relkind in ('r', 'p')
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_index i on i.indrelid = c.oid and i.indisprimary
        where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped
        order by a.attrelid, array_position(i.indkey::int2[], a.attnum)",
                &[Some(list)],
            )
            .await
            .ok()?;
        let mut tables: Vec<(String, SourceTable)> = Vec::new();
        let mut names: HashMap<String, String> = HashMap::new(); // "oid:attnum" -> column name
        for c in cols.iter() {
            let rel = c.s("rel");
            let i = match tables.iter().position(|(id, _)| *id == rel) {
                Some(i) => i,
                None => {
                    tables.push((rel.clone(), SourceTable { schema: c.s("s"), name: c.s("t"), key: vec![], readonly: Default::default() }));
                    tables.len() - 1
                }
            };
            if c.b("pk") {
                tables[i].1.key.push(c.s("name"));
            }
            if c.b("ro") {
                tables[i].1.readonly.insert(c.s("name"));
            }
            names.insert(format!("{rel}:{}", c.s("num")), c.s("name"));
        }
        let sources: Vec<Option<ColumnSource>> = fields
            .iter()
            .map(|f| {
                names
                    .get(&format!("{}:{}", f.table_oid, f.column_id))
                    .map(|column| ColumnSource { table: f.table_oid.to_string(), column: column.clone() })
            })
            .collect();
        edit_target_of(&sources, &tables)
    }

    fn schemas_query() -> &'static str {
        "
      select nspname from pg_namespace
      where nspname !~ '^pg_(toast|temp_|toast_temp_)'
      order by nspname in ('pg_catalog', 'information_schema'), nspname"
    }
}

fn system_schema(s: &str) -> bool {
    s == "pg_catalog" || s == "information_schema"
}

static INDEX_DEF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^CREATE (?:UNIQUE )?INDEX \S+ ON \S+ ").unwrap());

#[async_trait]
impl Driver for PostgresDriver {
    fn has_schemas(&self) -> bool {
        true
    }

    async fn test(&self) -> Result<String> {
        let r = self.q(None, "select version() as v", &[]).await?;
        let v = r.iter().next().map(|r| r.s("v")).unwrap_or_default();
        Ok(v)
    }

    async fn databases(&self) -> Result<Vec<String>> {
        let r = self.q(None, "select datname from pg_database where not datistemplate and datallowconn order by 1", &[]).await?;
        Ok(r.iter().map(|r| r.s("datname")).collect())
    }

    async fn schemas(&self, db: Db<'_>) -> Result<Vec<String>> {
        let r = self.q(db, Self::schemas_query(), &[]).await?;
        Ok(r.iter().map(|r| r.s("nspname")).collect())
    }

    async fn tables(&self, db: Db<'_>, schema: Db<'_>) -> Result<Vec<TableInfo>> {
        let r = self
            .q(
                db,
                "
      select c.relname, c.relkind from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r','p','v','m','f') and not c.relispartition
      order by c.relname",
                &[schema.map(str::to_string)],
            )
            .await?;
        Ok(r.iter().map(|r| TableInfo { name: r.s("relname"), kind: kind_of(&r.s("relkind")) }).collect())
    }

    async fn columns(&self, db: Db<'_>, schema: Db<'_>, table: &str) -> Result<Vec<ColumnInfo>> {
        let r = self
            .q(
                db,
                "
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as notnull,
             exists (select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary
                     and a.attnum = any(i.indkey)) as pk
      from pg_attribute a
      where a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum",
                &[schema.map(str::to_string), Some(table.to_string())],
            )
            .await?;
        Ok(r.iter().map(|r| ColumnInfo { name: r.s("name"), kind: r.s("type"), notnull: r.b("notnull"), pk: r.b("pk") }).collect())
    }

    // Editor autocompletion: every user schema (plus the current one), its tables / views with typed columns, and functions.
    async fn completion(&self, db: Db<'_>, schema: Db<'_>) -> Result<CompletionInfo> {
        let user = "(n.nspname !~ '^pg_' and n.nspname <> 'information_schema' or n.nspname = $1)";
        let p = [schema.map(str::to_string)];
        let cols_sql = format!(
            "
        select n.nspname as s, c.relname as t, c.relkind as k, a.attname as c,
               format_type(a.atttypid, a.atttypmod) as type,
               exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)) as pk
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where {user} and c.relkind in ('r','p','v','m','f') and not c.relispartition
        order by n.nspname, c.relname, a.attnum limit 50000"
        );
        let funcs_sql = format!(
            "
        select n.nspname as s, p.proname as name, pg_get_function_arguments(p.oid) as args,
               pg_get_function_result(p.oid) as result
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where {user} and p.prokind in ('f','a','w') order by 1, 2 limit 5000"
        );
        let (cols, funcs, schemas) = tokio::try_join!(self.q(db, &cols_sql, &p), self.q(db, &funcs_sql, &p), self.schemas(db))?;
        let mut tables: Vec<CompletionTable> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for r in cols.iter() {
            let key = format!("{}.{}", r.s("s"), r.s("t"));
            let i = *index.entry(key).or_insert_with(|| {
                tables.push(CompletionTable { schema: r.s("s"), name: r.s("t"), kind: kind_of(&r.s("k")), columns: vec![] });
                tables.len() - 1
            });
            tables[i].columns.push(CompletionColumn { name: r.s("c"), kind: r.s("type"), pk: r.b("pk") });
        }
        Ok(CompletionInfo {
            current: schema.map(str::to_string),
            schemas: schemas.into_iter().filter(|s| !system_schema(s) || Some(s.as_str()) == schema).collect(),
            tables,
            functions: funcs
                .iter()
                .map(|f| CompletionFunction { schema: f.s("s"), name: f.s("name"), args: f.s("args"), result: f.s("result") })
                .collect(),
        })
    }

    // Structure of one schema for the chat export (no data).
    async fn describe(&self, db: Db<'_>, schema: Db<'_>) -> Result<SchemaDescription> {
        let schema = schema.filter(|s| !s.is_empty()).unwrap_or("public").to_string();
        let p = [Some(schema.clone())];
        let where_ = "n.nspname = $1 and c.relkind in ('r','p','v','m','f') and not c.relispartition";
        let tables_sql = format!(
            "select c.relname as t, c.relkind as k, c.reltuples as rows, obj_description(c.oid, 'pg_class') as comment
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where {where_} order by c.relname"
        );
        let columns_sql = format!(
            "select c.relname as t, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
          pg_get_expr(d.adbin, d.adrelid) as def,
          exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)) as pk
        from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where {where_} and a.attnum > 0 and not a.attisdropped order by c.relname, a.attnum"
        );
        let fks_sql = "select c.relname as t, con.conname as name, pg_get_constraintdef(con.oid) as def
        from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and con.contype = 'f' order by c.relname, con.conname";
        let indexes_sql = "select c.relname as t, i.relname as name, ix.indisunique as unique, pg_get_indexdef(ix.indexrelid) as def
        from pg_index ix join pg_class c on c.oid = ix.indrelid join pg_class i on i.oid = ix.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and not ix.indisprimary order by c.relname, i.relname";
        let (ver, tables, columns, fks, indexes, schemas) = tokio::try_join!(
            self.q(db, "select version() as v", &[]),
            self.q(db, &tables_sql, &p),
            self.q(db, &columns_sql, &p),
            self.q(db, fks_sql, &p),
            self.q(db, indexes_sql, &p),
            self.schemas(db),
        )?;
        let version = ver.iter().next().map(|r| r.s("v")).unwrap_or_default();
        let mut cols = group_by(columns.iter().collect(), |r| r.s("t"));
        let mut fk = group_by(fks.iter().collect(), |r| r.s("t"));
        let mut idx = group_by(indexes.iter().collect(), |r| r.s("t"));
        let tables = tables
            .iter()
            .map(|t| {
                let name = t.s("t");
                let k = t.s("k");
                let rows = crate::js::parse_num(&t.s("rows"));
                DescribedTable {
                    rows: if k == "v" || k == "f" || rows < 0.0 { None } else { Some(rows.round()) },
                    kind: kind_name(&k).into(),
                    comment: t.opt("comment"),
                    columns: cols
                        .take(&name)
                        .into_iter()
                        .map(|c| DescribedColumn {
                            name: c.s("name"),
                            kind: c.s("type"),
                            notnull: c.b("notnull"),
                            default: c.opt("def"),
                            pk: c.b("pk"),
                        })
                        .collect(),
                    foreign_keys: fk.take(&name).into_iter().map(|f| ForeignKey { name: f.s("name"), def: f.s("def") }).collect(),
                    indexes: idx
                        .take(&name)
                        .into_iter()
                        .map(|i| IndexInfo {
                            name: i.s("name"),
                            unique: i.b("unique"),
                            def: INDEX_DEF.replace(&i.s("def"), "").into_owned(),
                        })
                        .collect(),
                    name,
                }
            })
            .collect();
        Ok(SchemaDescription {
            engine: "PostgreSQL".into(),
            version: version.split(" on ").next().unwrap_or("").to_string(),
            database: self.db(db),
            schemas: Some(schemas.into_iter().filter(|s| *s == schema || !system_schema(s)).collect()),
            schema: Some(schema),
            tables,
        })
    }

    async fn run(
        &self,
        db: Db<'_>,
        schema: Db<'_>,
        statements: Vec<Statement>,
        max_rows: usize,
        explain: Option<ExplainMode>,
    ) -> Result<Vec<Value>> {
        let db = self.db(db);
        let s = self.session(&db).await?;
        let _busy = Busy::take(&s.busy)?;
        let mut guard = s.conn.lock().await;
        let result = async {
            let c = guard.as_mut().ok_or_else(|| Error::new("Connection closed"))?;
            Self::use_schema(c, schema).await?;
            let mut results = Vec::new();
            let mut failed = false;
            for st in &statements {
                if failed {
                    let mut m = statement_json(st);
                    m.insert("kind".into(), "skipped".into());
                    results.push(Value::Object(m));
                    continue;
                }
                let (r, err) = self.run_one(&db, c, st, max_rows, explain).await;
                failed = err;
                results.push(Value::Object(r));
            }
            Ok(results)
        }
        .await;
        self.drop_if_broken(&db, &s, &guard).await;
        result
    }

    async fn page(&self, db: Db<'_>, schema: Db<'_>, sql: &str, offset: usize, count: usize) -> Result<Value> {
        if !is_pageable(sql) {
            return Err(Error::new("Only a read-only query can fetch more rows"));
        }
        let db = self.db(db);
        let s = self.session(&db).await?;
        let _busy = Busy::take(&s.busy)?;
        let mut guard = s.conn.lock().await;
        let result = async {
            let c = guard.as_mut().ok_or_else(|| Error::new("Connection closed"))?;
            Self::use_schema(c, schema).await?;
            let rows = Self::cursor_rows(c, sql, offset, count + 1).await?;
            let truncated = rows.len() > count;
            let rows: Vec<Vec<Value>> =
                rows.into_iter().take(count).map(|r| r.into_iter().map(|v| v.map_or(Value::Null, Value::from)).collect()).collect();
            Ok(json!({ "rows": rows, "truncated": truncated }))
        }
        .await;
        self.drop_if_broken(&db, &s, &guard).await;
        result
    }

    async fn save(&self, db: Db<'_>, _schema: Db<'_>, target: &TableRef, changes: &[RowChange]) -> Result<usize> {
        let db = self.db(db);
        let s = self.session(&db).await?;
        let _busy = Busy::take(&s.busy)?;
        let mut guard = s.conn.lock().await;
        let result = async {
            let c = guard.as_mut().ok_or_else(|| Error::new("Connection closed"))?;
            if c.tx_status == b'E' {
                return Err(Error::new("The current transaction has failed: roll it back before saving"));
            }
            let in_tx = c.tx_status == b'T';
            c.execute(if in_tx { "savepoint webgrip_save" } else { "begin" }).await?;
            let table = format!("{}.{}", ident(&target.schema), ident(&target.table));
            let applied: Result<()> = async {
                for change in changes {
                    let (sql, values) = update_of(&table, change, ident, |i| format!("${i}"))?;
                    let params: Vec<Option<String>> = values.iter().map(param_text).collect();
                    let (_, count) = c.query(&sql, &params).await?.command();
                    check_updated(change, count.unwrap_or(0))?;
                }
                c.execute(if in_tx { "release savepoint webgrip_save" } else { "commit" }).await
            }
            .await;
            if let Err(e) = applied {
                let undo: &[&str] =
                    if in_tx { &["rollback to savepoint webgrip_save", "release savepoint webgrip_save"] } else { &["rollback"] };
                for sql in undo {
                    let _ = c.execute(sql).await;
                }
                return Err(e);
            }
            Ok(changes.len())
        }
        .await;
        self.drop_if_broken(&db, &s, &guard).await;
        result
    }

    async fn explore(&self, db: Db<'_>, schema: Db<'_>, sql: &str, max_rows: usize) -> Result<ExploreResult> {
        let db = self.db(db);
        let mut c = PgConn::connect(&self.config(&db)).await?;
        let result = async {
            c.execute("begin transaction read only").await?;
            c.execute(&format!("set local statement_timeout = {EXPLORE_TIMEOUT_MS}")).await?;
            if let Some(schema) = schema.filter(|s| !s.is_empty()) {
                c.execute(&format!("set local search_path to {}{}", ident(schema), if schema == "public" { "" } else { ", public" }))
                    .await?;
            }
            let r = if ROW_STATEMENT.is_match(strip_leading_comments(sql)) {
                Self::cursor_query(&mut c, sql, max_rows).await?
            } else {
                c.simple(sql).await?.pop().unwrap_or_default()
            };
            match r.fields.as_ref().filter(|f| !f.is_empty()) {
                None => Ok(ExploreResult::Command { command: r.command().0.unwrap_or_default() }),
                Some(fields) => {
                    let columns = self.columns_of(&db, fields).await?;
                    let truncated = r.rows.len() > max_rows;
                    let rows = r
                        .rows
                        .into_iter()
                        .take(max_rows)
                        .map(|row| row.into_iter().map(|v| v.map_or(Value::Null, Value::from)).collect())
                        .collect();
                    Ok(ExploreResult::Rows { columns, rows, truncated })
                }
            }
        }
        .await;
        let _ = c.execute("rollback").await;
        c.terminate().await;
        result
    }

    async fn cancel(&self, db: Db<'_>) -> Result<bool> {
        let db = self.db(db);
        let s = self.sessions.lock().await.get(&db).cloned();
        let Some(s) = s.filter(|s| s.busy.load(std::sync::atomic::Ordering::SeqCst)) else { return Ok(false) };
        self.q(Some(&db), "select pg_cancel_backend($1)", &[Some(s.pid.to_string())]).await?;
        Ok(true)
    }

    async fn close(&self) {
        let sessions: Vec<Arc<Session>> = self.sessions.lock().await.drain().map(|(_, s)| s).collect();
        for s in sessions {
            // a running query keeps its session until it ends; the connection closes when dropped
            if let Ok(mut g) = s.conn.try_lock() {
                if let Some(c) = g.take() {
                    c.terminate().await;
                }
            }
        }
        let pools: Vec<Arc<Pool>> = self.pools.lock().unwrap().drain().map(|(_, p)| p).collect();
        for p in pools {
            let idle: Vec<PgConn> = p.idle.lock().unwrap().drain(..).collect();
            for c in idle {
                c.terminate().await;
            }
        }
    }
}
