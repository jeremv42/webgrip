// The pure functions against golden outputs written by the first (TypeScript) server: the port must give the same
// results. tests/golden/*.json hold the inputs and the expected outputs.

use serde_json::Value;
use webgrip_server::types::{ChatEvent, Dialect, ResultColumn, SchemaDescription};
use webgrip_server::{auth, chat_text, describe, drivers, sql, vault};

fn golden(name: &str) -> Value {
    let path = format!("{}/tests/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn dialect(v: &Value) -> Dialect {
    serde_json::from_value(v.clone()).unwrap()
}

// JSON values equal, numbers compared as numbers (1 and 1.0 are the same)
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        (a, b) => a == b,
    }
}

#[track_caller]
fn assert_same(got: &Value, want: &Value, what: &str) {
    assert!(same(got, want), "{what}\n got: {got}\nwant: {want}");
}

#[test]
fn splits_sql_like_the_editor() {
    for case in golden("split.json").as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let got = serde_json::to_value(sql::split_sql(text, dialect(&case["dialect"]))).unwrap();
        assert_same(&got, &case["out"], &format!("split {:?} ({})", text, case["dialect"]));
    }
}

#[test]
fn tells_pageable_statements() {
    for case in golden("pageable.json").as_array().unwrap() {
        let s = case["sql"].as_str().unwrap();
        assert_eq!(sql::is_pageable(s), case["pageable"].as_bool().unwrap(), "pageable {s:?}");
        assert_eq!(sql::strip_leading_comments(s), case["stripped"].as_str().unwrap(), "stripped {s:?}");
    }
}

#[test]
fn accepts_only_read_only_statements_for_the_chat() {
    for case in golden("readonly.json").as_array().unwrap() {
        let s = case["sql"].as_str().unwrap();
        let got = sql::read_only_statement(s, dialect(&case["dialect"]));
        match (&got, case.get("ok"), case.get("error")) {
            (Ok(sql), Some(want), _) => assert_eq!(sql, want.as_str().unwrap(), "{s:?}"),
            (Err(e), _, Some(want)) => assert_eq!(e, want.as_str().unwrap(), "{s:?}"),
            _ => panic!("{s:?}: got {got:?}, want {case}"),
        }
    }
}

#[test]
fn parses_plans() {
    for case in golden("plans.json").as_array().unwrap() {
        let columns: Vec<ResultColumn> = serde_json::from_value(case["columns"].clone()).unwrap();
        let rows: Vec<Vec<Value>> = serde_json::from_value(case["rows"].clone()).unwrap();
        let plan = match case["engine"].as_str().unwrap() {
            "pg" => drivers::postgres::plan::plan_of(&columns, &rows),
            _ => drivers::mariadb::plan::plan_of(&columns, &rows),
        };
        let got = serde_json::to_value(plan).unwrap();
        let cell = rows[0][0].as_str().unwrap_or("");
        assert_same(&got, &case["plan"], &format!("{} plan of {}", case["engine"], &cell[..cell.len().min(80)]));
    }
}

#[test]
fn writes_markdown_and_chat_text() {
    let text = golden("text.json");
    let schemas: Vec<SchemaDescription> = serde_json::from_value(text["schemas"].clone()).unwrap();
    for case in text["markdown"].as_array().unwrap() {
        let d = &schemas[case["d"].as_u64().unwrap() as usize];
        assert_eq!(describe::to_markdown(d), case["out"].as_str().unwrap());
    }
    for case in text["describeForChat"].as_array().unwrap() {
        let d = &schemas[case["d"].as_u64().unwrap() as usize];
        let tables: Option<Vec<String>> = serde_json::from_value(case["tables"].clone()).unwrap();
        let budget = case["budget"].as_u64().unwrap() as usize;
        assert_eq!(
            chat_text::describe_for_chat(d, tables.as_deref(), budget),
            case["out"].as_str().unwrap(),
            "describeForChat {} {:?} {budget}",
            d.database,
            tables
        );
    }
    for case in text["tsv"].as_array().unwrap() {
        let columns: Vec<ResultColumn> = serde_json::from_value(case["columns"].clone()).unwrap();
        let rows: Vec<Vec<Value>> = serde_json::from_value(case["rows"].clone()).unwrap();
        assert_eq!(chat_text::to_tsv(&columns, &rows, case["truncated"].as_bool().unwrap()), case["out"].as_str().unwrap());
    }
    for case in text["cap"].as_array().unwrap() {
        let got = chat_text::cap(case["text"].as_str().unwrap(), case["hint"].as_str().unwrap(), case["budget"].as_u64().unwrap() as usize);
        assert_eq!(got, case["out"].as_str().unwrap());
    }
}

#[test]
fn maps_the_cli_stream_to_chat_events() {
    for case in golden("events.json").as_array().unwrap() {
        let got: Vec<ChatEvent> = chat_text::to_events(&case["msg"]);
        assert_same(&serde_json::to_value(&got).unwrap(), &case["out"], &format!("events of {}", case["msg"]));
    }
}

#[test]
fn opens_connection_files_written_by_the_first_version() {
    let v = golden("vault.json");
    let secret = v["secret"].as_str().unwrap();
    let sealed: Value = serde_json::from_str(v["sealed"].as_str().unwrap()).unwrap();
    assert!(vault::is_sealed(&sealed));
    assert_eq!(vault::unseal(&sealed, secret).unwrap(), v["plain"].as_str().unwrap());
    assert!(vault::unseal(&sealed, "another-secret-0123456").unwrap_err().contains("WEBGRIP_SECRET"));
    // and the other way round
    let again: Value = serde_json::from_str(&vault::seal("hello", secret)).unwrap();
    assert_eq!(vault::unseal(&again, secret).unwrap(), "hello");
}

#[test]
fn keeps_the_session_cookies_of_the_first_version() {
    let a = golden("auth.json");
    let now = a["now"].as_u64().unwrap();
    let auth = auth::Auth::with_clock(a["password"].as_str().unwrap(), a["secret"].as_str().unwrap(), Box::new(move || now));
    let cookie = a["cookie"].as_str().unwrap();
    assert_eq!(auth::set_cookie(&auth.token(), 30 * 24 * 3600), cookie);
    let value = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
    assert!(auth.valid(Some(value)));
    assert!(!auth.valid(Some("9999999999.forged")));
    let other = auth::Auth::with_clock("new", a["secret"].as_str().unwrap(), Box::new(move || now));
    assert!(!other.valid(Some(value)));
    let later = auth::Auth::with_clock(
        a["password"].as_str().unwrap(),
        a["secret"].as_str().unwrap(),
        Box::new(move || now + 31 * 24 * 3600 * 1000),
    );
    assert!(!later.valid(Some(value)));
}
