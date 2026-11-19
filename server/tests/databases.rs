// The drivers against real databases. Skipped unless these point at a scratch database (tables are created in it):
//   WEBGRIP_TEST_PG=host:port:user:password:database
//   WEBGRIP_TEST_MYSQL=host:port:user:password:database   (MySQL or MariaDB; several separated by spaces)
// e.g. docker run -d -p 55442:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=t postgres:18
//      WEBGRIP_TEST_PG=127.0.0.1:55442:postgres:pw:t cargo test --test databases

use serde_json::{json, Value};
use std::sync::Arc;
use webgrip_server::drivers::{default_driver, Driver};
use webgrip_server::sql::split_sql;
use webgrip_server::types::*;

fn targets(var: &str, kind: Dialect) -> Vec<(String, Arc<dyn Driver>)> {
    let Ok(list) = std::env::var(var) else { return vec![] };
    list.split_whitespace()
        .map(|spec| {
            let p: Vec<&str> = spec.splitn(5, ':').collect();
            let cfg = DriverConfig {
                kind,
                host: Some(p[0].into()),
                port: p[1].parse().ok(),
                user: Some(p[2].into()),
                password: Some(p[3].into()).filter(|s: &String| !s.is_empty()),
                database: Some(p[4].into()),
                ssl: false,
            };
            (spec.to_string(), default_driver(&cfg))
        })
        .collect()
}

async fn run(d: &dyn Driver, sql: &str, max_rows: usize, explain: Option<ExplainMode>) -> Vec<Value> {
    let dialect = if d.has_schemas() { Dialect::Postgres } else { Dialect::Mariadb };
    d.run(None, None, split_sql(sql, dialect), max_rows, explain).await.unwrap()
}

async fn one(d: &dyn Driver, sql: &str) -> Value {
    run(d, sql, 500, None).await.remove(0)
}

const SETUP: &str = "drop table if exists wg_items; create table wg_items (a int, b int, v text, primary key (a, b));
insert into wg_items values (1, 1, 'one'), (1, 2, 'two'), (2, 1, null), (3, 1, 'x'), (3, 2, 'y')";

async fn common(name: &str, driver: Arc<dyn Driver>) {
    let d = driver.as_ref();
    let setup = run(d, SETUP, 500, None).await;
    assert!(setup.iter().all(|r| r["kind"] != "error"), "{name}: {setup:?}");

    // rows, truncation, editability
    let r = run(d, "select * from wg_items order by a, b", 2, None).await.remove(0);
    assert_eq!(r["kind"], "rows", "{name}");
    assert_eq!(r["rows"].as_array().unwrap().len(), 2);
    assert_eq!(r["truncated"], true);
    assert_eq!(r["editable"]["key"], json!(["a", "b"]), "{name}: {r}");
    assert_eq!(one(d, "select v from wg_items").await["editable"], Value::Null, "{name}: no key, not editable");

    // stops at the first error
    let rs = run(d, "select 1; selec 2; select 3", 500, None).await;
    assert_eq!(rs.iter().map(|r| r["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["rows", "error", "skipped"], "{name}");
    assert!(rs[1]["error"]["code"].is_string(), "{name}: {}", rs[1]);

    // commands
    let u = one(d, "update wg_items set v = v where a = 3").await;
    assert_eq!((u["kind"].clone(), u["affected"].as_u64().is_some()), (json!("command"), true), "{name}: {u}");

    // EXPLAIN ANALYZE changes nothing
    let e = run(d, "delete from wg_items", 500, Some(ExplainMode::Analyze)).await.remove(0);
    assert_eq!(e["explain"], "analyze", "{name}: {e}");
    assert!(e["plan"]["root"]["title"].is_string(), "{name}: {e}");
    assert_eq!(one(d, "select count(*) from wg_items").await["rows"][0][0].to_string().trim_matches('"'), "5", "{name}");

    // more rows
    let page = d.page(None, None, "select a, b from wg_items order by a, b", 3, 10).await.unwrap();
    assert_eq!(page["rows"].as_array().unwrap().len(), 2, "{name}: {page}");
    assert_eq!(page["truncated"], false);
    assert!(d.page(None, None, "delete from wg_items", 0, 10).await.is_err());

    // saving edits, all or nothing
    let table = TableRef { schema: if d.has_schemas() { "public".into() } else { db_of(name) }, table: "wg_items".into() };
    let change = |a: i64, b: i64, v: &str| RowChange {
        key: serde_json::from_value(json!({ "a": a, "b": b })).unwrap(),
        set: serde_json::from_value(json!({ "v": v })).unwrap(),
    };
    assert_eq!(d.save(None, None, &table, &[change(1, 1, "ONE")]).await.unwrap(), 1, "{name}");
    let err = d.save(None, None, &table, &[change(1, 2, "TWO"), change(9, 9, "none")]).await.unwrap_err();
    assert!(err.message.contains("not found"), "{name}: {}", err.message);
    let vs = one(d, "select v from wg_items where a = 1 order by b").await;
    assert_eq!(vs["rows"], json!([["ONE"], ["two"]]), "{name}: the failed save was rolled back");

    // the chat's read-only queries
    match d.explore(None, None, "select * from wg_items", 2).await.unwrap() {
        ExploreResult::Rows { rows, truncated, .. } => assert_eq!((rows.len(), truncated), (2, true), "{name}"),
        ExploreResult::Command { .. } => panic!("{name}: explore gave no rows"),
    }
    assert!(d.explore(None, None, "delete from wg_items", 10).await.is_err(), "{name}: a write in a read-only transaction");
    assert_eq!(one(d, "select count(*) from wg_items").await["rows"][0][0].to_string().trim_matches('"'), "5");

    // cancel a running query
    let sleep = if d.has_schemas() { "select pg_sleep(20)" } else { "select sleep(20)" };
    let d2 = driver.clone();
    let running = tokio::spawn(async move { run(d2.as_ref(), sleep, 500, None).await });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(d.run(None, None, split_sql("select 1", Dialect::Postgres), 10, None).await.is_err(), "{name}: busy");
    assert!(d.cancel(None).await.unwrap(), "{name}");
    let t0 = std::time::Instant::now();
    running.await.unwrap();
    assert!(t0.elapsed().as_secs() < 10, "{name}: cancelled");
    assert_eq!(one(d, "select 42").await["kind"], "rows", "{name}: the session still works");

    run(d, "drop table wg_items", 500, None).await;
    d.close().await;
}

fn db_of(spec: &str) -> String {
    spec.splitn(5, ':').nth(4).unwrap_or("").to_string()
}

#[tokio::test]
async fn postgres() {
    for (name, d) in targets("WEBGRIP_TEST_PG", Dialect::Postgres) {
        // text values exactly as PostgreSQL prints them
        let r = one(d.as_ref(), "select 1::int8, 1.50::numeric, array[1,2], '1 day'::interval, null::text, '\\x01ff'::bytea").await;
        assert_eq!(r["rows"], json!([["1", "1.50", "{1,2}", "1 day", null, "\\x01ff"]]), "{name}");
        assert_eq!(r["columns"][2]["type"], "_int4");
        // notices, and an error position shifted back past our EXPLAIN prefix
        let n = one(d.as_ref(), "do $$ begin raise notice 'hello'; end $$").await;
        assert_eq!(n["notices"], json!(["NOTICE: hello"]), "{name}");
        let e = run(d.as_ref(), "select * fro x", 500, Some(ExplainMode::Plan)).await.remove(0);
        let pos = e["error"]["position"].as_i64().unwrap_or(0);
        assert!((1..=14).contains(&pos), "{name}: the position is in the statement, not in our prefix: {e}");
        // a transaction left open by the user is kept: ANALYZE uses a savepoint
        run(d.as_ref(), "begin; create temp table wg_t (a int)", 500, None).await;
        run(d.as_ref(), "insert into wg_t values (1)", 500, Some(ExplainMode::Analyze)).await;
        assert_eq!(one(d.as_ref(), "select count(*) from wg_t").await["rows"], json!([["0"]]), "{name}");
        run(d.as_ref(), "rollback", 500, None).await;
        common(&name, d).await;
    }
}

#[tokio::test]
async fn mysql_and_mariadb() {
    for (name, d) in targets("WEBGRIP_TEST_MYSQL", Dialect::Mariadb) {
        // mysql2's shapes: integers as numbers, BIGINT / DECIMAL / dates as text, binary as hex
        run(
            d.as_ref(),
            "create temporary table wg_n (i int, b bigint, f double, d decimal(5,2), dt date, bin varbinary(4), n text)",
            500,
            None,
        )
        .await;
        run(d.as_ref(), "insert into wg_n values (1, 2, 0.5, 1.5, '2024-01-02', x'01ff', null)", 500, None).await;
        let r = one(d.as_ref(), "select * from wg_n").await;
        assert_eq!(r["rows"], json!([[1, "2", 0.5, "1.50", "2024-01-02", "0x01ff", null]]), "{name}: {r}");
        // a command's warnings become notices
        let w = one(d.as_ref(), "drop temporary table if exists wg_missing_table").await;
        assert_eq!(w["notices"].as_array().map(Vec::len), Some(1), "{name}: {w}");
        let e = one(d.as_ref(), "select * from wg_missing_table").await;
        assert_eq!(e["error"]["code"], "ER_NO_SUCH_TABLE", "{name}: {e}");
        common(&name, d).await;
    }
}
