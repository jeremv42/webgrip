// MySQL / MariaDB EXPLAIN output → webgrip's plan tree:
// EXPLAIN FORMAT=JSON (both), ANALYZE FORMAT=JSON (MariaDB), EXPLAIN ANALYZE / FORMAT=TREE (MySQL, indented text).

use crate::drivers::plan::{cell_text, fill_self, num, obj, round, scalar, Json};
use crate::js;
use crate::types::{Plan, PlanNode, ResultColumn};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

// ---------------- JSON ----------------

const MY_ROWS: &[&str] = &["rows_produced_per_join", "rows", "rows_examined_per_scan"];
const MY_SHOWN: &[&str] = &[
    "table_name",
    "access_type",
    "key",
    "select_id",
    "r_rows",
    "r_loops",
    "r_total_time_ms",
    "r_table_time_ms",
    "r_other_time_ms",
    "cost",
    "loops",
    "rows_produced_per_join",
    "rows",
    "rows_examined_per_scan",
];

fn label(k: &str) -> String {
    let k = match k.strip_prefix("r_") {
        Some(rest) => format!("actual {rest}"),
        None => k.to_string(),
    };
    k.replace('_', " ")
}

fn my_title(key: &str, o: &Json) -> String {
    if let Some(table) = o.get("table_name").and_then(Value::as_str) {
        let access = match o.get("access_type") {
            None | Some(Value::Null) => "scan".to_string(),
            v => js::template(v),
        };
        let mut t = format!("{access} on {table}");
        if js::truthy(o.get("key")) {
            t += &format!(" using {}", js::template(o.get("key")));
        }
        return t;
    }
    let t = label(key);
    match o.get("select_id") {
        None | Some(Value::Null) => t,
        id => format!("{t} #{}", js::template(id)),
    }
}

fn pairs(v: &Json) -> String {
    v.iter().map(|(a, b)| format!("{} {}", label(a), js::template(Some(b)))).collect::<Vec<_>>().join(", ")
}

// Every nested object (or array of objects) is a child, except small objects of scalars that read as details (cost_info…)
fn my_node(key: &str, o: &Json) -> PlanNode {
    let mut node = PlanNode { title: my_title(key, o), ..Default::default() };
    let add_child = |node: &mut PlanNode, k: &str, v: &Json| {
        // { "table": {…} } items of a nested_loop: the table itself
        let mut keys = v.keys();
        match (keys.next(), keys.next()) {
            (Some(only), None) if v[only].is_object() => node.children.push(my_node(only, v[only].as_object().unwrap())),
            _ => node.children.push(my_node(k, v)),
        }
    };
    for (k, v) in o {
        match v {
            Value::Object(inner) => {
                if inner.values().all(|x| !x.is_object() && !x.is_array()) {
                    // cost_info: { query_cost, read_cost, eval_cost, prefix_cost… }
                    if k == "cost_info" {
                        // prefix_cost adds up the tables joined so far: the table's own share is read + eval
                        if let Some(c) = num(inner.get("prefix_cost")).or_else(|| num(inner.get("query_cost"))) {
                            node.cost = Some(c);
                        }
                        if let Some(read) = num(inner.get("read_cost")) {
                            node.self_cost = Some(round(read + num(inner.get("eval_cost")).unwrap_or(0.0)));
                        }
                        node.details.push(format!("cost: {}", pairs(inner)));
                    } else {
                        node.details.push(format!("{}: {}", label(k), pairs(inner)));
                    }
                } else {
                    add_child(&mut node, k, inner);
                }
            }
            Value::Array(items) => {
                if items.iter().any(Value::is_object) {
                    for item in items.iter().filter_map(Value::as_object) {
                        add_child(&mut node, k, item);
                    }
                } else if !items.is_empty() {
                    node.details.push(format!("{}: {}", label(k), js::join(items, ", ")));
                }
            }
            Value::Null => {}
            v if !MY_SHOWN.contains(&k.as_str()) => {
                node.details.push(format!("{}: {}", label(k), scalar(v).unwrap_or_default()));
            }
            _ => {}
        }
    }
    let est = MY_ROWS.iter().find_map(|k| num(o.get(*k)));
    let loops = num(o.get("r_loops"));
    // MariaDB counts rows per loop (its estimated "loops" since 11.0)
    let est_loops = if o.get("rows").is_some_and(|r| !r.is_null()) { num(o.get("loops")).or(loops).unwrap_or(1.0) } else { 1.0 };
    if let Some(e) = est {
        node.est_rows = Some(round(e * est_loops));
    }
    if let Some(c) = num(o.get("cost")) {
        node.cost = Some(c);
    }
    if let Some(r) = num(o.get("r_rows")) {
        node.rows = Some(round(r * loops.unwrap_or(1.0)));
    }
    if loops.is_some() {
        node.loops = loops;
    }
    // a query block's time is its total; a table's or a sort's is its own
    let table_time = num(o.get("r_table_time_ms"));
    let time = num(o.get("r_total_time_ms")).or_else(|| table_time.map(|t| t + num(o.get("r_other_time_ms")).unwrap_or(0.0)));
    if let Some(time) = time {
        if key == "query_block" {
            node.time = Some(round(time));
        } else {
            node.self_time = Some(round(time));
        }
    }
    node.block = key == "query_block";
    node
}

// Costs and times are the node's own, except a query block's (its total): derive the missing inclusive / exclusive values.
fn my_rollup(n: &mut PlanNode) -> (Option<f64>, f64) {
    let kids: Vec<(Option<f64>, f64)> = n.children.iter_mut().map(my_rollup).collect();
    let timed = kids.iter().any(|k| k.0.is_some());
    let kids_time: f64 = kids.iter().map(|k| k.0.unwrap_or(0.0)).sum();
    let kids_cost: f64 = kids.iter().map(|k| k.1).sum();
    if n.block {
        if let Some(time) = n.time {
            n.self_time = Some(round((time - kids_time).max(0.0)));
        } else if timed {
            n.time = Some(round(kids_time));
        }
    } else if n.self_time.is_some() || timed {
        let own = *n.self_time.get_or_insert(0.0);
        n.time = Some(round(own + kids_time));
    }
    if n.self_cost.is_none() {
        if let Some(cost) = n.cost {
            n.self_cost = Some(round((cost - kids_cost).max(0.0)));
        }
    }
    (n.time, kids_cost + n.self_cost.unwrap_or(0.0))
}

pub fn parse_my_json_plan(json: &Value) -> Option<Plan> {
    let qb = obj(json.as_object()?.get("query_block"))?;
    let mut root = my_node("query_block", qb);
    let analyze = serde_json::to_string(json).ok()?.contains("\"r_");
    my_rollup(&mut root);
    let mut summary = Vec::new();
    if let Some(t) = num(qb.get("r_total_time_ms")) {
        summary.push(format!("Execution {} ms", js::num_str(round(t))));
    }
    if let Some(ci) = obj(qb.get("cost_info")) {
        if ci.get("query_cost").is_some_and(|c| !c.is_null()) {
            summary.push(format!("Query cost {}", js::template(ci.get("query_cost"))));
        }
    }
    let total = if analyze { root.time.unwrap_or(0.0) } else { root.cost.unwrap_or(0.0) };
    Some(Plan { analyze, root, summary, total })
}

// ---------------- MySQL tree text (EXPLAIN ANALYZE, FORMAT=TREE) ----------------

static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\s*)->\s*([^\n\r  ]*)$").unwrap());
static EST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(cost=([\d.e+]+)(?:\.\.([\d.e+]+))? rows=([\d.e+]+)\)").unwrap());
static ACT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(actual time=([\d.e+]+)\.\.([\d.e+]+) rows=([\d.e+]+) loops=(\d+)\)").unwrap());

// The node at `path` (child indexes from the root)
fn at<'a>(root: &'a mut PlanNode, path: &[usize]) -> &'a mut PlanNode {
    path.iter().fold(root, |n, &i| &mut n.children[i])
}

// "-> Filter: (t.a > 1)  (cost=0.35 rows=1) (actual time=0.03..0.04 rows=2 loops=3)"
pub fn parse_my_tree_plan(text: &str) -> Option<Plan> {
    let lines: Vec<&str> = text.split('\n').collect();
    if !lines.first()?.trim_start_matches(js::is_space).starts_with("->") {
        return None;
    }
    let mut root: Option<PlanNode> = None;
    // (depth, path to the node)
    let mut stack: Vec<(usize, Vec<usize>)> = Vec::new();
    let mut last: Option<Vec<usize>> = None;
    let mut analyze = false;
    for line in lines {
        let Some(m) = LINE.captures(line) else {
            // a long title wrapped on the next line
            if let (Some(path), Some(r)) = (&last, root.as_mut()) {
                if !js::trim(line).is_empty() {
                    let n = at(r, path);
                    n.title += &format!(" {}", js::trim(line));
                }
            }
            continue;
        };
        let depth = js::len16(&m[1]);
        let mut body = m[2].to_string();
        let mut node = PlanNode::default();
        if let Some(est) = EST.captures(&body.clone()) {
            node.cost = Some(js::parse_num(est.get(2).unwrap_or_else(|| est.get(1).unwrap()).as_str()));
            node.est_rows = Some(js::parse_num(&est[3]));
            body = body.replacen(&est[0], "", 1);
        }
        if let Some(act) = ACT.captures(&body.clone()) {
            analyze = true;
            let loops = js::parse_num(&act[4]);
            node.loops = Some(loops);
            node.rows = Some(round(js::parse_num(&act[3]) * loops));
            node.time = Some(round(js::parse_num(&act[2]) * loops));
            if let Some(e) = node.est_rows {
                node.est_rows = Some(round(e * loops));
            }
            body = body.replacen(&act[0], "", 1);
        } else if body.contains("(never executed)") {
            analyze = true;
            body = body.replacen("(never executed)", "", 1);
            node.details.push("never executed".into());
        }
        node.title = js::trim(&body).to_string();
        while stack.last().is_some_and(|(d, _)| *d >= depth) {
            stack.pop();
        }
        let path = if let Some((_, parent)) = stack.last() {
            let parent_node = at(root.as_mut().unwrap(), parent);
            parent_node.children.push(node);
            let mut p = parent.clone();
            p.push(parent_node.children.len() - 1);
            p
        } else if root.is_none() {
            root = Some(node);
            vec![]
        } else {
            // several top-level nodes: put them under a common root
            let r = root.take().unwrap();
            let mut top = if r.title != "plan" { PlanNode { title: "plan".into(), children: vec![r], ..Default::default() } } else { r };
            top.children.push(node);
            let p = vec![top.children.len() - 1];
            root = Some(top);
            // paths recorded under the old root moved one level down
            for (_, sp) in stack.iter_mut() {
                sp.insert(0, 0);
            }
            p
        };
        stack.push((depth, path.clone()));
        last = Some(path);
    }
    let mut root = root?;
    fill_self(&mut root);
    let total = if analyze { root.time.unwrap_or(0.0) } else { root.cost.unwrap_or(0.0) };
    Some(Plan { analyze, root, summary: vec![], total })
}

static EXPLAIN_COLUMN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(EXPLAIN|ANALYZE)$").unwrap());

// The plan held by a result: one cell under the column EXPLAIN (or ANALYZE) prints, JSON or a "->" tree
pub fn plan_of(columns: &[ResultColumn], rows: &[Vec<Value>]) -> Option<Plan> {
    if columns.len() != 1 || !EXPLAIN_COLUMN.is_match(&columns[0].name) || rows.len() != 1 {
        return None;
    }
    let v = match rows[0].first() {
        None | Some(Value::Null) => String::new(),
        Some(c) => cell_text(c),
    };
    let v = js::trim(&v);
    if v.starts_with('{') {
        parse_my_json_plan(&serde_json::from_str(v).ok()?)
    } else {
        parse_my_tree_plan(v)
    }
}
