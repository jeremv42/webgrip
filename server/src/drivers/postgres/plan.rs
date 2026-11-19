// PostgreSQL EXPLAIN (FORMAT JSON [, ANALYZE]) → webgrip's plan tree

use crate::drivers::plan::{fill_self, num, obj, round, scalar, Json};
use crate::js;
use crate::types::{Plan, PlanNode, ResultColumn};
use serde_json::Value;

// Keys shown in the node's title or columns, not in its details
const PG_SHOWN: &[&str] = &[
    "Node Type",
    "Plans",
    "Relation Name",
    "Schema",
    "Alias",
    "Index Name",
    "Join Type",
    "Strategy",
    "Partial Mode",
    "Parallel Aware",
    "Async Capable",
    "Startup Cost",
    "Total Cost",
    "Plan Rows",
    "Plan Width",
    "Actual Startup Time",
    "Actual Total Time",
    "Actual Rows",
    "Actual Loops",
    "Scan Direction",
    "Inner Unique",
    "Disabled",
];

fn agg(strategy: &str) -> Option<&'static str> {
    match strategy {
        "Hashed" => Some("HashAggregate"),
        "Sorted" => Some("GroupAggregate"),
        "Mixed" => Some("MixedAggregate"),
        _ => None,
    }
}

// The title EXPLAIN's text format would print: "Hash Left Join", "Index Scan Backward using pk on public.t x"…
fn pg_title(p: &Json) -> String {
    let t_ = |k: &str| js::template(p.get(k));
    let truthy = |k: &str| js::truthy(p.get(k));
    // ModifyTable reads "Update on t" in the text format
    let mut t = if p.get("Node Type").and_then(Value::as_str) == Some("ModifyTable") && truthy("Operation") {
        t_("Operation")
    } else if truthy("Node Type") {
        t_("Node Type")
    } else {
        "?".into()
    };
    if t == "Aggregate" {
        if let Some(a) = p.get("Strategy").and_then(Value::as_str).and_then(agg) {
            t = a.into();
        }
    }
    if let Some(jt) = p.get("Join Type").and_then(Value::as_str).filter(|j| *j != "Inner") {
        t = match t.strip_suffix("Join") {
            Some(base) => format!("{base}{jt} Join"),
            None => format!("{t} {jt} Join"),
        };
    }
    if truthy("Partial Mode") && p.get("Partial Mode").and_then(Value::as_str) != Some("Simple") {
        t = format!("{} {t}", t_("Partial Mode"));
    }
    if truthy("Parallel Aware") {
        t = format!("Parallel {t}");
    }
    if p.get("Scan Direction").and_then(Value::as_str) == Some("Backward") {
        t += " Backward";
    }
    if truthy("Index Name") {
        t += &format!(" using {}", t_("Index Name"));
    }
    let rel = ["Relation Name", "CTE Name", "Function Name"].iter().find_map(|k| p.get(*k).filter(|v| !v.is_null()));
    if let Some(rel) = rel.filter(|r| js::truthy(Some(r))) {
        let schema = if truthy("Schema") { format!("{}.", t_("Schema")) } else { String::new() };
        t += &format!(" on {schema}{}", js::template(Some(rel)));
        if truthy("Alias") && !p.get("Alias").is_some_and(|a| same(a, rel)) {
            t += &format!(" {}", t_("Alias"));
        }
    }
    t
}

fn kb(k: &str) -> bool {
    k.ends_with("Memory Usage") || k.ends_with("Space Used") || k.ends_with("Disk Usage")
}

fn pg_detail(k: &str, v: &Value, p: &Json) -> Option<String> {
    if let Value::Array(a) = v {
        let items: Vec<String> = a.iter().filter_map(scalar).collect();
        return (!items.is_empty()).then(|| format!("{k}: {}", items.join(", ")));
    }
    let s = scalar(v)?;
    // zero counters (blocks, rows removed, disk…) and "Original Hash Buckets" equal to the final ones are noise
    if v.as_f64() == Some(0.0) && k != "Workers Launched" {
        return None;
    }
    if let Some(rest) = k.strip_prefix("Original ") {
        if p.get(rest).is_some_and(|o| same(o, v)) {
            return None;
        }
    }
    Some(format!("{k}: {s}{}", if kb(k) { " kB" } else { "" }))
}

// Strict equality of two JSON scalars
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Object(_), _) | (Value::Array(_), _) => false,
        (a, b) => a == b,
    }
}

fn pg_node(p: &Json, analyze: bool) -> PlanNode {
    let loops = num(p.get("Actual Loops")).unwrap_or(1.0);
    let plan_rows = num(p.get("Plan Rows"));
    let actual_rows = num(p.get("Actual Rows"));
    let total_time = num(p.get("Actual Total Time"));
    let disabled = p.get("Disabled") == Some(&Value::Bool(true));
    let mut details: Vec<String> =
        if disabled { vec!["Disabled: its enable_* setting is off, but no other plan was possible".into()] } else { vec![] };
    for (k, v) in p {
        if PG_SHOWN.contains(&k.as_str()) || matches!(k.as_str(), "Relation Name" | "CTE Name" | "Function Name") {
            continue;
        }
        if k == "Parent Relationship" && matches!(js::template(Some(v)).as_str(), "Outer" | "Inner" | "Member") {
            continue;
        }
        if k == "Operation" && p.get("Node Type").and_then(Value::as_str) == Some("ModifyTable") {
            continue;
        }
        if let Some(d) = pg_detail(k, v, p) {
            details.push(d);
        }
    }
    let children = match p.get("Plans") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_object).map(|c| pg_node(c, analyze)).collect(),
        _ => vec![],
    };
    PlanNode {
        // PostgreSQL 18+: a node type turned off by an enable_* setting, used anyway for lack of another plan
        title: pg_title(p) + if disabled { " (disabled)" } else { "" },
        details,
        est_rows: plan_rows.map(|r| r * if analyze { loops } else { 1.0 }),
        rows: actual_rows.map(|r| r * loops),
        loops: analyze.then_some(loops),
        cost: num(p.get("Total Cost")),
        // a node never run ("never executed") has no time
        time: total_time.map(|t| round(t * loops)),
        children,
        ..Default::default()
    }
}

pub fn parse_pg_plan(json: &Value) -> Option<Plan> {
    let top = match json {
        Value::Array(a) => obj(a.first())?,
        v => v.as_object()?,
    };
    let plan = obj(top.get("Plan"))?;
    let present = |v: Option<&Value>| v.is_some_and(|v| !v.is_null());
    let analyze = present(top.get("Execution Time")) || present(plan.get("Actual Loops"));
    let mut root = pg_node(plan, analyze);
    fill_self(&mut root);
    let mut summary = Vec::new();
    let ms = |k: &str| num(top.get(k));
    if let Some(t) = ms("Planning Time") {
        summary.push(format!("Planning {} ms", js::num_str(t)));
    }
    if let Some(t) = ms("Execution Time") {
        summary.push(format!("Execution {} ms", js::num_str(t)));
    }
    if let Some(Value::Array(triggers)) = top.get("Triggers") {
        for t in triggers.iter().filter_map(Value::as_object) {
            let on = if js::truthy(t.get("Relation")) { format!(" on {}", js::template(t.get("Relation"))) } else { String::new() };
            let time = num(t.get("Time")).map_or("?".into(), js::num_str);
            summary.push(format!(
                "Trigger {}{on}: {time} ms, {} call(s)",
                js::template(t.get("Trigger Name")),
                js::template(t.get("Calls"))
            ));
        }
    }
    if let Some(jit) = obj(top.get("JIT")) {
        summary.push(format!("JIT: {} function(s)", num(jit.get("Functions")).map_or("?".into(), js::num_str)));
    }
    let total = if analyze { ms("Execution Time").or(root.time).unwrap_or(0.0) } else { root.cost.unwrap_or(0.0) };
    Some(Plan { analyze, root, summary, total })
}

// The plan held by a result: EXPLAIN (FORMAT JSON) returns one json cell named "QUERY PLAN"
pub fn plan_of(columns: &[ResultColumn], rows: &[Vec<Value>]) -> Option<Plan> {
    if columns.len() != 1 || columns[0].name != "QUERY PLAN" || columns[0].kind != "json" || rows.len() != 1 {
        return None;
    }
    let text = crate::drivers::plan::cell_text(rows[0].first()?);
    parse_pg_plan(&serde_json::from_str(&text).ok()?)
}
