// MySQL / MariaDB: metadata through a small pool, the SQL editor on one dedicated session per database.
// Values keep the shapes the first version (mysql2) gave them: integers and floats as numbers; BIGINT, DECIMAL, dates
// and JSON as text; binary strings as 0x… hex.

pub mod errors;
pub mod plan;

use crate::describe::group_by;
use crate::drivers::edit::{check_updated, edit_target_of, update_of, ColumnSource, SourceTable};
use crate::drivers::{ms_since, statement_json, Busy, Db, Driver, EXPLORE_TIMEOUT_MS};
use crate::error::{Error, Result};
use crate::sql::is_pageable;
use crate::types::*;
use async_trait::async_trait;
use mysql_async::consts::StatusFlags;
use mysql_async::prelude::Queryable;
use mysql_async::{Column, Conn, OptsBuilder, Pool, PoolConstraints, PoolOpts, Row, SslOpts, Value as MyValue};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, OnceCell};

const BINARY_CHARSET: u16 = 63;
static EXPLAIN_STATEMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*(explain|analyze|describe|desc)(?-u:\b)").unwrap());

// The EXPLAIN put in front of a statement (none when it already is one). MariaDB's ANALYZE FORMAT=JSON and MySQL's
// EXPLAIN FORMAT=JSON give a JSON tree; MySQL's EXPLAIN ANALYZE (8.0.18+) only gives an indented text tree.
pub fn explain_prefix(sql: &str, mode: Option<ExplainMode>, mariadb: bool) -> &'static str {
    match mode {
        None => "",
        Some(_) if EXPLAIN_STATEMENT.is_match(sql) => "",
        Some(ExplainMode::Plan) => "EXPLAIN FORMAT=JSON ",
        Some(ExplainMode::Analyze) if mariadb => "ANALYZE FORMAT=JSON ",
        Some(ExplainMode::Analyze) => "EXPLAIN ANALYZE ",
    }
}

pub fn ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

// mysql2's name of a column type
pub fn type_name(t: u8) -> String {
    match t {
        0x00 => "DECIMAL",
        0x01 => "TINY",
        0x02 => "SHORT",
        0x03 => "LONG",
        0x04 => "FLOAT",
        0x05 => "DOUBLE",
        0x06 => "NULL",
        0x07 => "TIMESTAMP",
        0x08 => "LONGLONG",
        0x09 => "INT24",
        0x0a => "DATE",
        0x0b => "TIME",
        0x0c => "DATETIME",
        0x0d => "YEAR",
        0x0e => "NEWDATE",
        0x0f => "VARCHAR",
        0x10 => "BIT",
        0xf2 => "VECTOR",
        0xf5 => "JSON",
        0xf6 => "NEWDECIMAL",
        0xf7 => "ENUM",
        0xf8 => "SET",
        0xf9 => "TINY_BLOB",
        0xfa => "MEDIUM_BLOB",
        0xfb => "LONG_BLOB",
        0xfc => "BLOB",
        0xfd => "VAR_STRING",
        0xfe => "STRING",
        0xff => "GEOMETRY",
        t => return t.to_string(),
    }
    .to_string()
}

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 + b.len() * 2);
    s.push_str("0x");
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

// A text-protocol value as mysql2 gave it (typeCast with dateStrings, bigNumberStrings, jsonStrings)
pub fn cell(v: MyValue, t: u8, charset: u16) -> Value {
    let MyValue::Bytes(b) = v else {
        return match v {
            MyValue::NULL => Value::Null,
            v => Value::String(value_text(&v).unwrap_or_default()),
        };
    };
    let text = || String::from_utf8_lossy(&b).into_owned();
    match t {
        // TINY, SHORT, LONG, INT24, YEAR
        0x01 | 0x02 | 0x03 | 0x09 | 0x0d => {
            let s = text();
            s.parse::<i64>().map(Value::from).or_else(|_| s.parse::<u64>().map(Value::from)).unwrap_or(Value::String(s))
        }
        // FLOAT, DOUBLE
        0x04 | 0x05 => {
            let n = crate::js::parse_num(&text());
            serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
        }
        // BIT, GEOMETRY: bytes
        0x10 | 0xff => Value::String(hex(&b)),
        // DECIMAL, LONGLONG, dates, JSON: text
        0x00 | 0xf6 | 0x08 | 0x07 | 0x0a | 0x0b | 0x0c | 0x0e | 0xf5 => Value::String(text()),
        _ if charset == BINARY_CHARSET => Value::String(hex(&b)),
        _ => Value::String(text()),
    }
}

// A binary-protocol value (metadata queries) as text
fn value_text(v: &MyValue) -> Option<String> {
    Some(match v {
        MyValue::NULL => return None,
        MyValue::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        MyValue::Int(i) => i.to_string(),
        MyValue::UInt(u) => u.to_string(),
        MyValue::Float(f) => crate::js::num_str(f64::from(*f)),
        MyValue::Double(d) => crate::js::num_str(*d),
        MyValue::Date(y, m, d, h, i, s, us) => {
            let mut t = format!("{y:04}-{m:02}-{d:02} {h:02}:{i:02}:{s:02}");
            if *us > 0 {
                t += &format!(".{us:06}");
            }
            t
        }
        MyValue::Time(neg, d, h, i, s, us) => {
            let mut t = format!("{}{:02}:{i:02}:{s:02}", if *neg { "-" } else { "" }, u32::from(*h) + d * 24);
            if *us > 0 {
                t += &format!(".{us:06}");
            }
            t
        }
    })
}

pub fn my_err(e: mysql_async::Error) -> Error {
    match e {
        mysql_async::Error::Server(s) => Error { message: s.message, code: errors::name(s.code).map(str::to_string), ..Default::default() },
        e @ (mysql_async::Error::Io(_) | mysql_async::Error::Driver(_)) => Error::fatal(e.to_string()),
        e => Error::new(e.to_string()),
    }
}

// Rows of a metadata query, read by column name
struct Rows {
    names: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
}

impl Rows {
    fn from(rows: Vec<Row>) -> Rows {
        let names = rows.first().map(|r| r.columns_ref().iter().map(|c| c.name_str().into_owned()).collect()).unwrap_or_default();
        let rows = rows.into_iter().map(|r| r.unwrap().iter().map(value_text).collect()).collect();
        Rows { names, rows }
    }
    fn iter(&self) -> impl Iterator<Item = R<'_>> {
        self.rows.iter().map(|row| R { names: &self.names, row })
    }
}

#[derive(Clone, Copy)]
struct R<'a> {
    names: &'a [String],
    row: &'a Vec<Option<String>>,
}

impl R<'_> {
    fn opt(&self, k: &str) -> Option<String> {
        let i = self.names.iter().position(|n| n.eq_ignore_ascii_case(k))?;
        self.row.get(i).cloned().flatten()
    }
    fn s(&self, k: &str) -> String {
        self.opt(k).unwrap_or_default()
    }
}

// The real table and column of a result column (empty when computed); binary columns are shown as hex, so read-only
#[derive(Clone, Debug)]
pub struct FieldSource {
    pub db: String,
    pub table: String,
    pub column: String,
    pub binary: bool,
}

enum Exec {
    Rows { columns: Vec<ResultColumn>, rows: Vec<Vec<Value>>, truncated: bool, total: u64, sources: Vec<FieldSource> },
    Command { command: String, affected: u64, info: String, warnings: u16 },
}

struct Session {
    conn: Mutex<Option<Conn>>,
    busy: AtomicBool,
    id: u32,
}

pub struct MariadbDriver {
    cfg: DriverConfig,
    meta: Pool,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    flavor: OnceCell<bool>, // true for MariaDB, false for MySQL
}

fn opts(cfg: &DriverConfig, database: Option<&str>) -> OptsBuilder {
    let mut o = OptsBuilder::default()
        .ip_or_hostname(cfg.host.clone().unwrap_or_else(|| "localhost".into()))
        .tcp_port(cfg.port.filter(|p| *p > 0 && *p < 65536).map_or(3306, |p| p as u16))
        .user(cfg.user.clone())
        .pass(cfg.password.clone())
        .db_name(database.filter(|d| !d.is_empty()).map(str::to_string))
        .prefer_socket(false);
    if cfg.ssl {
        o = o.ssl_opts(SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true));
    }
    o
}

async fn connect(o: OptsBuilder) -> Result<Conn> {
    match tokio::time::timeout(Duration::from_secs(10), Conn::new(o)).await {
        Ok(r) => r.map_err(my_err),
        Err(_) => Err(Error::fatal("connect ETIMEDOUT")),
    }
}

fn source_of(c: &Column) -> FieldSource {
    let t = type_name(c.column_type() as u8);
    FieldSource {
        db: c.schema_str().into_owned(),
        table: c.org_table_str().into_owned(),
        column: c.org_name_str().into_owned(),
        binary: c.character_set() == BINARY_CHARSET && ["BLOB", "STRING", "BIT", "GEOMETRY"].iter().any(|k| t.contains(k)),
    }
}

fn column_of(c: &Column) -> ResultColumn {
    let mut t = type_name(c.column_type() as u8);
    if t == "BLOB" && c.character_set() != BINARY_CHARSET {
        t = "TEXT".into();
    }
    ResultColumn { name: c.name_str().into_owned(), kind: t }
}

// Streams the rows so that only max_rows (after `offset` skipped ones) are kept in memory.
async fn exec(conn: &mut Conn, sql: &str, max_rows: usize, offset: usize) -> Result<Exec> {
    let mut res = conn.query_iter(sql).await.map_err(my_err)?;
    let cols: Vec<Column> = res.columns_ref().to_vec();
    if cols.is_empty() {
        let out = Exec::Command {
            command: crate::js::trim(sql).split(crate::js::is_space).next().unwrap_or("").to_uppercase(),
            affected: res.affected_rows(),
            info: res.info().into_owned(),
            warnings: res.warnings(),
        };
        res.drop_result().await.map_err(my_err)?;
        return Ok(out);
    }
    let types: Vec<(u8, u16)> = cols.iter().map(|c| (c.column_type() as u8, c.character_set())).collect();
    let mut rows = Vec::new();
    let mut total: u64 = 0;
    // the first result set only (CALL …)
    while let Some(row) = res.next().await.map_err(my_err)? {
        if total >= offset as u64 && rows.len() < max_rows {
            let values = row.unwrap();
            rows.push(values.into_iter().zip(&types).map(|(v, (t, cs))| cell(v, *t, *cs)).collect());
        }
        total += 1;
    }
    res.drop_result().await.map_err(my_err)?;
    Ok(Exec::Rows {
        columns: cols.iter().map(column_of).collect(),
        rows,
        truncated: total > (offset + max_rows) as u64,
        total,
        sources: cols.iter().map(source_of).collect(),
    })
}

async fn in_transaction(conn: &mut Conn) -> Result<bool> {
    conn.query_drop("do 0").await.map_err(my_err)?;
    Ok(conn.last_ok_packet().is_some_and(|ok| ok.status_flags().contains(StatusFlags::SERVER_STATUS_IN_TRANS)))
}

async fn warnings(conn: &mut Conn) -> Vec<Value> {
    let rows: Vec<Row> = conn.query("show warnings").await.unwrap_or_default();
    Rows::from(rows).iter().map(|w| Value::String(format!("{}: {}", w.s("Level"), w.s("Message")))).collect()
}

fn to_my(v: &Value) -> MyValue {
    match v {
        Value::Null => MyValue::NULL,
        Value::Bool(b) => MyValue::Int(i64::from(*b)),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => MyValue::Int(i),
            (_, Some(u)) => MyValue::UInt(u),
            _ => MyValue::Double(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => MyValue::Bytes(s.clone().into_bytes()),
        v => MyValue::Bytes(v.to_string().into_bytes()),
    }
}

static ROWS_MATCHED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Rows matched:\s*(\d+)").unwrap());
static GENERATED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)GENERATED").unwrap());
static VIEW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)view").unwrap());

fn kind_of(table_type: &str) -> TableKind {
    if VIEW.is_match(table_type) {
        TableKind::View
    } else {
        TableKind::Table
    }
}

impl MariadbDriver {
    pub fn new(cfg: DriverConfig) -> Self {
        let pool_opts = PoolOpts::default().with_constraints(PoolConstraints::new(0, 3).unwrap());
        let meta = Pool::new(opts(&cfg, cfg.database.as_deref()).pool_opts(pool_opts));
        MariadbDriver { cfg, meta, sessions: Default::default(), flavor: OnceCell::new() }
    }

    async fn meta_conn(&self) -> Result<Conn> {
        match tokio::time::timeout(Duration::from_secs(10), self.meta.get_conn()).await {
            Ok(r) => r.map_err(my_err),
            Err(_) => Err(Error::fatal("connect ETIMEDOUT")),
        }
    }

    // A metadata query: prepared when it has parameters, plain text otherwise
    async fn q(&self, sql: &str, params: Vec<MyValue>) -> Result<Rows> {
        let mut c = self.meta_conn().await?;
        let rows: Vec<Row> = if params.is_empty() { c.query(sql).await } else { c.exec(sql, params).await }.map_err(my_err)?;
        Ok(Rows::from(rows))
    }

    async fn is_mariadb(&self) -> Result<bool> {
        self.flavor.get_or_try_init(|| async { Ok(self.test().await?.to_lowercase().contains("mariadb")) }).await.copied()
    }

    async fn session(&self, db: Db<'_>) -> Result<Arc<Session>> {
        let key = db.unwrap_or("").to_string();
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.get(&key) {
            return Ok(s.clone());
        }
        let database = db.filter(|d| !d.is_empty()).or(self.cfg.database.as_deref());
        let c = connect(opts(&self.cfg, database)).await?;
        let s = Arc::new(Session { id: c.id(), conn: Mutex::new(Some(c)), busy: AtomicBool::new(false) });
        sessions.insert(key, s.clone());
        Ok(s)
    }

    async fn forget(&self, db: Db<'_>, s: &Arc<Session>) {
        let mut sessions = self.sessions.lock().await;
        let key = db.unwrap_or("");
        if sessions.get(key).is_some_and(|x| Arc::ptr_eq(x, s)) {
            sessions.remove(key);
        }
    }

    // ANALYZE runs the statement: open a transaction (or a savepoint inside the user's own); returns what undoes it.
    // Changes to non-transactional tables (MyISAM, Aria…) cannot be undone.
    async fn rollback_guard(conn: &mut Conn) -> Result<&'static [&'static str]> {
        let in_tx = in_transaction(conn).await?;
        conn.query_drop(if in_tx { "savepoint webgrip_explain" } else { "start transaction" }).await.map_err(my_err)?;
        Ok(if in_tx { &["rollback to savepoint webgrip_explain", "release savepoint webgrip_explain"] } else { &["rollback"] })
    }

    // Which table the rows can be updated in: the fields name each column's real database, table and column.
    // A failure here only makes the result read-only.
    async fn edit_target(&self, fields: &[FieldSource]) -> Option<EditTarget> {
        let mut ids: Vec<(String, String)> = Vec::new();
        for f in fields {
            if !f.db.is_empty() && !f.table.is_empty() && !ids.contains(&(f.db.clone(), f.table.clone())) {
                ids.push((f.db.clone(), f.table.clone()));
            }
        }
        if ids.is_empty() {
            return None;
        }
        let cond = ids.iter().map(|_| "(table_schema = ? and table_name = ?)").collect::<Vec<_>>().join(" or ");
        let params = || ids.iter().flat_map(|(s, t)| [MyValue::from(s.as_str()), MyValue::from(t.as_str())]).collect::<Vec<_>>();
        let cols = self
            .q(
                &format!(
                    "
        select table_schema as s, table_name as t, column_name as c, column_key as k, extra
        from information_schema.columns
        where {cond}
        order by table_schema, table_name, ordinal_position"
                ),
                params(),
            )
            .await
            .ok()?;
        let keys = self
            .q(
                &format!(
                    "
        select table_schema as s, table_name as t, column_name as c from information_schema.key_column_usage
        where constraint_name = 'PRIMARY' and ({cond})
        order by ordinal_position"
                ),
                params(),
            )
            .await
            .ok()?;
        let id = |s: &str, t: &str| serde_json::to_string(&[s, t]).unwrap();
        let mut tables: Vec<(String, SourceTable)> = Vec::new();
        for c in cols.iter() {
            let tid = id(&c.s("s"), &c.s("t"));
            let i = match tables.iter().position(|(x, _)| *x == tid) {
                Some(i) => i,
                None => {
                    tables.push((tid, SourceTable { schema: c.s("s"), name: c.s("t"), key: vec![], readonly: Default::default() }));
                    tables.len() - 1
                }
            };
            if GENERATED.is_match(&c.s("extra")) {
                tables[i].1.readonly.insert(c.s("c"));
            }
        }
        for k in keys.iter() {
            let tid = id(&k.s("s"), &k.s("t"));
            if let Some((_, t)) = tables.iter_mut().find(|(x, _)| *x == tid) {
                t.key.push(k.s("c"));
            }
        }
        for f in fields.iter().filter(|f| f.binary) {
            let tid = id(&f.db, &f.table);
            if let Some((_, t)) = tables.iter_mut().find(|(x, _)| *x == tid) {
                t.readonly.insert(f.column.clone());
            }
        }
        let sources: Vec<Option<ColumnSource>> = fields
            .iter()
            .map(|f| {
                (!f.db.is_empty() && !f.table.is_empty()).then(|| ColumnSource { table: id(&f.db, &f.table), column: f.column.clone() })
            })
            .collect();
        edit_target_of(&sources, &tables)
    }

    async fn run_one(
        &self,
        conn: &mut Conn,
        st: &Statement,
        max_rows: usize,
        explain: Option<ExplainMode>,
        mariadb: bool,
    ) -> (Map<String, Value>, bool) {
        let prefix = explain_prefix(&st.sql, explain, mariadb);
        let mut out = statement_json(st);
        let t0 = Instant::now();
        let mut undo: Option<&[&str]> = None;
        let result: Result<(Exec, f64, Vec<Value>)> = async {
            if !prefix.is_empty() && explain == Some(ExplainMode::Analyze) {
                undo = Some(Self::rollback_guard(conn).await?);
            }
            let r = exec(conn, &format!("{prefix}{}", st.sql), max_rows, 0).await?;
            let ms = ms_since(t0);
            // a result set's warnings are not fetched (MySQL adds a note with the rewritten query to every EXPLAIN)
            let w = match &r {
                Exec::Rows { .. } => 0,
                Exec::Command { warnings, .. } => *warnings,
            };
            let notices = if w > 0 { warnings(conn).await } else { vec![] };
            Ok((r, ms, notices))
        }
        .await;
        let failed = result.is_err();
        match result {
            Ok((Exec::Rows { columns, rows, truncated, total, sources, .. }, ms, notices)) => {
                // an EXPLAIN / ANALYZE result, ours or typed by the user: also give it parsed
                let parsed = plan::plan_of(&columns, &rows);
                let editable = if parsed.is_none() { self.edit_target(&sources).await } else { None };
                out.insert("kind".into(), "rows".into());
                out.insert("columns".into(), json!(columns));
                out.insert("rows".into(), json!(rows));
                out.insert("truncated".into(), truncated.into());
                out.insert("total".into(), total.into());
                out.insert("ms".into(), json!(ms));
                out.insert("notices".into(), Value::Array(notices));
                if let Some(p) = parsed {
                    out.insert("plan".into(), json!(p));
                }
                if let Some(e) = editable {
                    out.insert("editable".into(), json!(e));
                }
            }
            Ok((Exec::Command { command, affected, info, .. }, ms, notices)) => {
                out.insert("kind".into(), "command".into());
                out.insert("command".into(), command.into());
                out.insert("affected".into(), affected.into());
                out.insert("info".into(), info.into());
                out.insert("ms".into(), json!(ms));
                out.insert("notices".into(), Value::Array(notices));
            }
            Err(e) => {
                let mut error = Map::new();
                error.insert("message".into(), e.message.into());
                if let Some(code) = e.code {
                    error.insert("code".into(), code.into());
                }
                out.insert("kind".into(), "error".into());
                out.insert("ms".into(), json!(ms_since(t0)));
                out.insert("error".into(), Value::Object(error));
            }
        }
        if !prefix.is_empty() {
            out.insert("explain".into(), json!(explain));
        }
        if let Some(undo) = undo {
            for sql in undo {
                // connection lost: the server rolls back anyway
                if conn.query_drop(*sql).await.is_err() {
                    break;
                }
            }
        }
        (out, failed)
    }
}

#[async_trait]
impl Driver for MariadbDriver {
    fn has_schemas(&self) -> bool {
        false
    }

    async fn test(&self) -> Result<String> {
        let r = self.q("select version() as v", vec![]).await?;
        let v = r.iter().next().map(|r| r.s("v")).unwrap_or_default();
        Ok(v)
    }

    async fn databases(&self) -> Result<Vec<String>> {
        let r = self.q("show databases", vec![]).await?;
        Ok(r.iter().map(|r| r.s("Database")).collect())
    }

    async fn schemas(&self, _db: Db<'_>) -> Result<Vec<String>> {
        Ok(vec![])
    }

    async fn tables(&self, db: Db<'_>, _schema: Db<'_>) -> Result<Vec<TableInfo>> {
        let r = self
            .q(
                "
      select table_name as name, table_type as type from information_schema.tables
      where table_schema = ? order by table_name",
                vec![db.map_or(MyValue::NULL, MyValue::from)],
            )
            .await?;
        Ok(r.iter().map(|r| TableInfo { name: r.s("name"), kind: kind_of(&r.s("type")) }).collect())
    }

    async fn columns(&self, db: Db<'_>, _schema: Db<'_>, table: &str) -> Result<Vec<ColumnInfo>> {
        let r = self
            .q(
                "
      select column_name as name, column_type as type, is_nullable as nullable, column_key as `key`
      from information_schema.columns where table_schema = ? and table_name = ?
      order by ordinal_position",
                vec![db.map_or(MyValue::NULL, MyValue::from), MyValue::from(table)],
            )
            .await?;
        Ok(r.iter()
            .map(|r| ColumnInfo { name: r.s("name"), kind: r.s("type"), notnull: r.s("nullable") == "NO", pk: r.s("key") == "PRI" })
            .collect())
    }

    // Editor autocompletion: tables / views with typed columns and routines of every user database (plus the current one).
    async fn completion(&self, db: Db<'_>, _schema: Db<'_>) -> Result<CompletionInfo> {
        let user = "(%s not in ('information_schema', 'mysql', 'performance_schema', 'sys') or %s = ?)";
        let p = || vec![db.map_or(MyValue::NULL, MyValue::from)];
        let cols_sql = format!(
            "
        select c.table_schema as s, c.table_name as t, t.table_type as k, c.column_name as c,
               c.column_type as type, c.column_key as `key`
        from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where {}
        order by c.table_schema, c.table_name, c.ordinal_position limit 50000",
            user.replace("%s", "c.table_schema")
        );
        let funcs_sql = format!(
            "
        select routine_schema as s, routine_name as name, routine_type as kind, dtd_identifier as result
        from information_schema.routines where {} order by 1, 2 limit 5000",
            user.replace("%s", "routine_schema")
        );
        let (cols, funcs, schemas) = tokio::try_join!(self.q(&cols_sql, p()), self.q(&funcs_sql, p()), self.databases())?;
        let mut tables: Vec<CompletionTable> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for r in cols.iter() {
            let i = *index.entry(format!("{}.{}", r.s("s"), r.s("t"))).or_insert_with(|| {
                tables.push(CompletionTable { schema: r.s("s"), name: r.s("t"), kind: kind_of(&r.s("k")), columns: vec![] });
                tables.len() - 1
            });
            tables[i].columns.push(CompletionColumn { name: r.s("c"), kind: r.s("type"), pk: r.s("key") == "PRI" });
        }
        Ok(CompletionInfo {
            current: db.map(str::to_string),
            schemas,
            tables,
            functions: funcs
                .iter()
                .map(|f| CompletionFunction {
                    schema: f.s("s"),
                    name: f.s("name"),
                    args: String::new(),
                    result: f.opt("result").filter(|r| !r.is_empty()).unwrap_or_else(|| f.s("kind").to_lowercase()),
                })
                .collect(),
        })
    }

    // Structure of one database for the chat export (no data).
    async fn describe(&self, db: Db<'_>, _schema: Db<'_>) -> Result<SchemaDescription> {
        let db = db.unwrap_or("").to_string();
        let p = || vec![MyValue::from(db.as_str())];
        let (ver, tables, columns, fks, indexes) = tokio::try_join!(
            self.q("select version() as v", vec![]),
            self.q(
                "select table_name as t, table_type as k, table_rows as nrows, table_comment as comment
        from information_schema.tables where table_schema = ? order by table_name",
                p()
            ),
            self.q(
                "select table_name as t, column_name as name, column_type as type, is_nullable as nullable,
          column_default as def, column_key as `key`
        from information_schema.columns where table_schema = ? order by table_name, ordinal_position",
                p()
            ),
            self.q(
                "select table_name as t, constraint_name as name, column_name as col, referenced_table_name as rt, referenced_column_name as rc
        from information_schema.key_column_usage where table_schema = ? and referenced_table_name is not null
        order by table_name, constraint_name, ordinal_position",
                p()
            ),
            self.q(
                "select table_name as t, index_name as name, non_unique as nu, column_name as col
        from information_schema.statistics where table_schema = ? and index_name <> 'PRIMARY'
        order by table_name, index_name, seq_in_index",
                p()
            ),
        )?;
        let version = ver.iter().next().map(|r| r.s("v")).unwrap_or_default();
        let mut cols = group_by(columns.iter().collect(), |r| r.s("t"));
        let mut fk = group_by(fks.iter().collect(), |r| r.s("t"));
        let mut idx = group_by(indexes.iter().collect(), |r| r.s("t"));
        let tables = tables
            .iter()
            .map(|t| {
                let name = t.s("t");
                let view = VIEW.is_match(&t.s("k"));
                DescribedTable {
                    kind: if view { "view" } else { "table" }.into(),
                    rows: if view { None } else { t.opt("nrows").map(|n| crate::js::parse_num(&n)) },
                    // MariaDB stores "VIEW" as a view's comment
                    comment: t.opt("comment").filter(|c| !c.is_empty() && c != "VIEW"),
                    columns: cols
                        .take(&name)
                        .into_iter()
                        .map(|c| DescribedColumn {
                            name: c.s("name"),
                            kind: c.s("type"),
                            notnull: c.s("nullable") == "NO",
                            default: c.opt("def").filter(|d| d != "NULL"),
                            pk: c.s("key") == "PRI",
                        })
                        .collect(),
                    foreign_keys: group_by(fk.take(&name), |r| r.s("name"))
                        .into_groups()
                        .into_iter()
                        .map(|(name, parts)| ForeignKey {
                            def: format!(
                                "FOREIGN KEY ({}) REFERENCES {} ({})",
                                parts.iter().map(|p| p.s("col")).collect::<Vec<_>>().join(", "),
                                parts[0].s("rt"),
                                parts.iter().map(|p| p.s("rc")).collect::<Vec<_>>().join(", ")
                            ),
                            name,
                        })
                        .collect(),
                    indexes: group_by(idx.take(&name), |r| r.s("name"))
                        .into_groups()
                        .into_iter()
                        .map(|(name, parts)| IndexInfo {
                            unique: crate::js::parse_num(&parts[0].s("nu")) == 0.0,
                            def: format!("({})", parts.iter().map(|p| p.s("col")).collect::<Vec<_>>().join(", ")),
                            name,
                        })
                        .collect(),
                    name,
                }
            })
            .collect();
        Ok(SchemaDescription {
            engine: if version.to_lowercase().contains("mariadb") { "MariaDB" } else { "MySQL" }.into(),
            version,
            database: db,
            schema: None,
            schemas: None,
            tables,
        })
    }

    async fn run(
        &self,
        db: Db<'_>,
        _schema: Db<'_>,
        statements: Vec<Statement>,
        max_rows: usize,
        explain: Option<ExplainMode>,
    ) -> Result<Vec<Value>> {
        let mariadb = if explain.is_some() { self.is_mariadb().await? } else { true };
        let s = self.session(db).await?;
        let _busy = Busy::take(&s.busy)?;
        let mut guard = s.conn.lock().await;
        let Some(conn) = guard.as_mut() else { return Err(Error::new("Connection closed")) };
        let mut results = Vec::new();
        let mut failed = false;
        let mut fatal = false;
        for st in &statements {
            if failed {
                let mut m = statement_json(st);
                m.insert("kind".into(), "skipped".into());
                results.push(Value::Object(m));
                continue;
            }
            let (r, err) = self.run_one(conn, st, max_rows, explain, mariadb).await;
            failed = err;
            fatal |= err && conn_lost(conn).await;
            results.push(Value::Object(r));
        }
        if fatal {
            guard.take();
            drop(guard);
            self.forget(db, &s).await;
        }
        Ok(results)
    }

    async fn page(&self, db: Db<'_>, _schema: Db<'_>, sql: &str, offset: usize, count: usize) -> Result<Value> {
        if !is_pageable(sql) {
            return Err(Error::new("Only a read-only query can fetch more rows"));
        }
        let s = self.session(db).await?;
        let _busy = Busy::take(&s.busy)?;
        let mut guard = s.conn.lock().await;
        let Some(conn) = guard.as_mut() else { return Err(Error::new("Connection closed")) };
        match exec(conn, sql, count, offset).await? {
            Exec::Rows { rows, truncated, total, .. } => Ok(json!({ "rows": rows, "truncated": truncated, "total": total })),
            Exec::Command { .. } => Err(Error::new("The statement returned no rows")),
        }
    }

    async fn save(&self, db: Db<'_>, _schema: Db<'_>, target: &TableRef, changes: &[RowChange]) -> Result<usize> {
        let s = self.session(db).await?;
        let _busy = Busy::take(&s.busy)?;
        let mut guard = s.conn.lock().await;
        let Some(conn) = guard.as_mut() else { return Err(Error::new("Connection closed")) };
        let in_tx = in_transaction(conn).await?;
        conn.query_drop(if in_tx { "savepoint webgrip_save" } else { "start transaction" }).await.map_err(my_err)?;
        let table = format!("{}.{}", ident(&target.schema), ident(&target.table));
        let applied: Result<()> = async {
            for change in changes {
                let (sql, values) = update_of(&table, change, ident, |_| "?".into())?;
                conn.exec_drop(&sql, values.iter().map(to_my).collect::<Vec<_>>()).await.map_err(my_err)?;
                // affectedRows only counts rows really changed: "Rows matched" tells whether the row was found
                let info = conn.info().into_owned();
                let count = ROWS_MATCHED.captures(&info).and_then(|m| m[1].parse().ok()).unwrap_or(conn.affected_rows());
                check_updated(change, count)?;
            }
            conn.query_drop(if in_tx { "release savepoint webgrip_save" } else { "commit" }).await.map_err(my_err)
        }
        .await;
        if let Err(e) = applied {
            let undo: &[&str] =
                if in_tx { &["rollback to savepoint webgrip_save", "release savepoint webgrip_save"] } else { &["rollback"] };
            for sql in undo {
                let _ = conn.query_drop(*sql).await;
            }
            return Err(e);
        }
        Ok(changes.len())
    }

    async fn explore(&self, db: Db<'_>, _schema: Db<'_>, sql: &str, max_rows: usize) -> Result<ExploreResult> {
        let mariadb = self.is_mariadb().await?;
        let database = db.filter(|d| !d.is_empty()).or(self.cfg.database.as_deref());
        let mut conn = connect(opts(&self.cfg, database)).await?;
        let result = async {
            conn.query_drop(if mariadb {
                format!("set session max_statement_time = {}", EXPLORE_TIMEOUT_MS / 1000)
            } else {
                format!("set session max_execution_time = {EXPLORE_TIMEOUT_MS}")
            })
            .await
            .map_err(my_err)?;
            conn.query_drop("start transaction read only").await.map_err(my_err)?;
            Ok(match exec(&mut conn, sql, max_rows, 0).await? {
                Exec::Rows { columns, rows, truncated, .. } => ExploreResult::Rows { columns, rows, truncated },
                Exec::Command { command, .. } => ExploreResult::Command { command },
            })
        }
        .await;
        let _ = conn.disconnect().await; // the server rolls the transaction back
        result
    }

    async fn cancel(&self, db: Db<'_>) -> Result<bool> {
        let s = self.sessions.lock().await.get(db.unwrap_or("")).cloned();
        let Some(s) = s.filter(|s| s.busy.load(std::sync::atomic::Ordering::SeqCst)) else { return Ok(false) };
        self.q(&format!("kill query {}", s.id), vec![]).await?;
        Ok(true)
    }

    async fn close(&self) {
        let sessions: Vec<Arc<Session>> = self.sessions.lock().await.drain().map(|(_, s)| s).collect();
        for s in sessions {
            if let Ok(mut g) = s.conn.try_lock() {
                if let Some(c) = g.take() {
                    let _ = c.disconnect().await;
                }
            }
        }
        let _ = self.meta.clone().disconnect().await;
    }
}

// Whether the session's connection died (after a failed statement)
async fn conn_lost(conn: &mut Conn) -> bool {
    conn.ping().await.is_err()
}
