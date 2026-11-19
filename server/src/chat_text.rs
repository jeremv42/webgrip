// What the chat with Claude sends and reads as text: results as TSV, the schema within a budget, the CLI's
// stream-json messages turned into the browser's events.

use crate::describe::to_markdown;
use crate::js;
use crate::types::{ChatEvent, DescribedTable, ResultColumn, SchemaDescription};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub const SERVER: &str = "webgrip";
const MAX_CELL: usize = 300; // characters kept per value
                             // Characters of a tool result (≈ 4 per token): well under Claude Code's limit on an MCP result (25,000 tokens by
                             // default), above which the CLI saves the result to a file this Claude cannot read (it has no file tool).
pub const MAX_TEXT: usize = 40_000;

fn tsv_cell(v: &Value) -> String {
    if v.is_null() {
        return "NULL".into();
    }
    let s = match v {
        Value::String(s) => s.clone(),
        v => js::template(Some(v)),
    };
    let s = s.replace('\\', "\\\\").replace('\t', "\\t").replace("\r\n", "\\n").replace('\n', "\\n");
    if js::len16(&s) > MAX_CELL {
        format!("{}…", js::take16(&s, MAX_CELL))
    } else {
        s
    }
}

// Rows as TSV for Claude, cut at MAX_TEXT characters
pub fn to_tsv(columns: &[ResultColumn], rows: &[Vec<Value>], truncated: bool) -> String {
    let header = columns.iter().map(|c| format!("{} ({})", c.name, c.kind)).collect::<Vec<_>>().join("\t");
    let mut size = js::len16(&header);
    let mut lines = vec![header];
    let mut shown = 0;
    for r in rows {
        let line = r.iter().map(tsv_cell).collect::<Vec<_>>().join("\t");
        let len = js::len16(&line);
        if size + len > MAX_TEXT {
            break;
        }
        lines.push(line);
        size += len + 1;
        shown += 1;
    }
    let more = truncated || shown < rows.len();
    lines.push(format!("({shown} row{}{})", if shown == 1 { "" } else { "s" }, if more { ", more not shown" } else { "" }));
    lines.join("\n")
}

// Text cut to the budget, saying so
pub fn cap(text: &str, hint: &str, budget: usize) -> String {
    if js::len16(text) <= budget {
        return text.to_string();
    }
    let hint = if hint.is_empty() { String::new() } else { format!(". {hint}") };
    format!("{}\n… (cut at {budget} characters{hint})", js::take16(text, budget))
}

static FOREIGN_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^FOREIGN KEY \(([^)]*)\) REFERENCES (.+?)\s*\(([^)]*)\)").unwrap());
static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^"(.*)"$"#).unwrap());

// One line per table: columns with type, PK, and → for a single-column foreign key (the others at the end)
fn overview_line(t: &DescribedTable) -> String {
    let mut refs = std::collections::HashMap::new();
    let mut multi = Vec::new();
    for fk in &t.foreign_keys {
        let Some(m) = FOREIGN_KEY.captures(&fk.def) else { continue };
        let target = format!("{}({})", &m[2], &m[3]);
        if m[1].contains(',') {
            multi.push(format!("({}) → {target}", &m[1]));
        } else {
            let col = js::trim(&m[1]);
            refs.insert(QUOTED.replace(col, "$1").into_owned(), target);
        }
    }
    let cols: Vec<String> = t
        .columns
        .iter()
        .map(|c| {
            let fk = refs.get(&c.name).map(|r| format!(" → {r}")).unwrap_or_default();
            format!("{} {}{}{fk}", c.name, c.kind, if c.pk { " PK" } else { "" })
        })
        .collect();
    let kind = if t.kind == "table" { String::new() } else { format!(" [{}]", t.kind) };
    let rows = t.rows.map(|r| format!(" ≈{} rows", js::num_str(r))).unwrap_or_default();
    let multi = if multi.is_empty() { String::new() } else { format!(" | {}", multi.join(", ")) };
    format!("{}{kind}{rows}: {}{multi}", t.name, cols.join(", "))
}

// The structure for Claude, within budget: the full Markdown when it fits (or for the tables asked), else an overview
// as detailed as fits (columns with types and keys, then column names, then table names).
pub fn describe_for_chat(d: &SchemaDescription, tables: Option<&[String]>, budget: usize) -> String {
    if let Some(tables) = tables.filter(|t| !t.is_empty()) {
        let wanted: Vec<String> = tables.iter().map(|n| n.to_lowercase()).collect();
        let found: Vec<DescribedTable> = d.tables.iter().filter(|t| wanted.contains(&t.name.to_lowercase())).cloned().collect();
        let missing: Vec<&String> = tables.iter().filter(|n| !found.iter().any(|t| t.name.to_lowercase() == n.to_lowercase())).collect();
        let mut text = to_markdown(&SchemaDescription { tables: found, ..d.clone() });
        if !missing.is_empty() {
            let names: Vec<&str> = missing.iter().map(|s| s.as_str()).collect();
            text += &format!("\nNot found: {}\n", names.join(", "));
        }
        return cap(&text, "Ask for fewer tables at a time.", budget);
    }
    let full = to_markdown(d);
    if js::len16(&full) <= budget {
        return full;
    }
    let schema = d.schema.as_deref().filter(|s| !s.is_empty()).map(|s| format!(", schema {s}")).unwrap_or_default();
    let head = format!(
        "{} {}, database {}{schema}: {} tables and views, too many to describe at once. Overview below; call describe_schema with \"tables\" for the full detail of the ones you need.\n\n",
        d.engine,
        d.version,
        d.database,
        d.tables.len()
    );
    let names = |t: &DescribedTable| format!("{}: {}", t.name, t.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", "));
    let levels: [&dyn Fn(&DescribedTable) -> String; 2] = [&overview_line, &names];
    for line in levels {
        let text = head.clone() + &d.tables.iter().map(line).collect::<Vec<_>>().join("\n");
        if js::len16(&text) <= budget {
            return text;
        }
    }
    let list = d.tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", ");
    cap(&(head + &list), "Use list_tables, or ask for specific tables.", budget)
}

fn strip_prefix(name: &str) -> String {
    name.replacen(&format!("mcp__{SERVER}__"), "", 1)
}

// One CLI message (stream-json) → what the browser needs from it
pub fn to_events(msg: &Value) -> Vec<ChatEvent> {
    let get = |v: &Value, k: &str| v.get(k).cloned().unwrap_or(Value::Null);
    match msg.get("type").and_then(Value::as_str) {
        Some("system") => {
            let id = msg.get("session_id").filter(|v| js::truthy(Some(v)));
            match (msg.get("subtype").and_then(Value::as_str), id) {
                (Some("init"), Some(id)) => vec![ChatEvent::Session { id: js::template(Some(id)) }],
                _ => vec![],
            }
        }
        Some("stream_event") => {
            if js::truthy(msg.get("parent_tool_use_id")) {
                return vec![];
            }
            let e = get(msg, "event");
            let delta = get(&e, "delta");
            if e.get("type").and_then(Value::as_str) == Some("content_block_delta")
                && delta.get("type").and_then(Value::as_str) == Some("text_delta")
            {
                vec![ChatEvent::Text { text: js::template(delta.get("text")) }]
            } else {
                vec![]
            }
        }
        Some("assistant") => {
            let content = msg.pointer("/message/content").and_then(Value::as_array).cloned().unwrap_or_default();
            content
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .map(|b| ChatEvent::Tool {
                    id: get(b, "id"),
                    name: strip_prefix(&js::template(b.get("name"))),
                    input: b.get("input").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::Object(Default::default())),
                })
                .collect()
        }
        Some("user") => {
            let Some(content) = msg.pointer("/message/content").and_then(Value::as_array) else { return vec![] };
            content
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                .map(|b| {
                    let text = match b.get("content") {
                        Some(Value::String(s)) => s.clone(),
                        Some(Value::Array(parts)) => parts
                            .iter()
                            .map(|c| match c.get("text") {
                                None | Some(Value::Null) => String::new(),
                                t => js::template(t),
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    };
                    ChatEvent::ToolResult {
                        id: get(b, "tool_use_id"),
                        error: js::truthy(b.get("is_error")),
                        text: js::take16(&text, 4000).to_string(),
                    }
                })
                .collect()
        }
        Some("result") => {
            let error = js::truthy(msg.get("is_error")).then(|| {
                for k in ["result", "subtype"] {
                    if js::truthy(msg.get(k)) {
                        return js::template(msg.get(k));
                    }
                }
                "Claude failed".to_string()
            });
            vec![ChatEvent::Done { error }]
        }
        _ => vec![],
    }
}
