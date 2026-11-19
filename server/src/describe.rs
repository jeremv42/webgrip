// Schema export for pasting into a chat: structure only, never data.

use crate::js;
use crate::types::SchemaDescription;
use regex::Regex;
use std::sync::LazyLock;

pub fn kind_label(kind: &str) -> &str {
    match kind {
        "table" => "Table",
        "view" => "View",
        "matview" => "Materialized view",
        "foreign" => "Foreign table",
        k => k,
    }
}

static NEWLINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\n\s*").unwrap());

fn cell(v: Option<&str>) -> String {
    NEWLINE.replace_all(&v.unwrap_or("").replace('|', "\\|"), " ").into_owned()
}

pub fn to_markdown(d: &SchemaDescription) -> String {
    let mut lines = vec![
        format!("# {} — {}", d.database, d.version),
        String::new(),
        format!("- Engine: {}", d.engine),
        format!("- Database: `{}`", d.database),
    ];
    if let Some(s) = d.schema.as_deref().filter(|s| !s.is_empty()) {
        lines.push(format!("- Schema: `{s}`"));
    }
    if let Some(schemas) = d.schemas.as_ref().filter(|s| !s.is_empty()) {
        let list: Vec<String> = schemas.iter().map(|s| format!("`{s}`")).collect();
        lines.push(format!("- Schemas of the database: {}", list.join(", ")));
    }
    lines.push(String::new());
    lines.push("Structure only, no data. Row counts are estimates.".into());

    for t in &d.tables {
        let rows = t.rows.map(|r| format!(" (≈ {} rows)", js::num_str(r))).unwrap_or_default();
        lines.push(String::new());
        lines.push(format!("## {} `{}`{}", kind_label(&t.kind), t.name, rows));
        if let Some(c) = t.comment.as_deref().filter(|c| !c.is_empty()) {
            lines.push(String::new());
            lines.push(c.to_string());
        }
        lines.push(String::new());
        lines.push("| Column | Type | Nullable | Default | Key |".into());
        lines.push("|---|---|---|---|---|".into());
        for c in &t.columns {
            lines.push(format!(
                "| {} | {} | {} | {} | {} |",
                cell(Some(&c.name)),
                cell(Some(&c.kind)),
                if c.notnull { "NOT NULL" } else { "NULL" },
                cell(c.default.as_deref()),
                if c.pk { "PK" } else { "" }
            ));
        }
        if !t.foreign_keys.is_empty() {
            lines.push(String::new());
            lines.push("**Foreign keys**".into());
            lines.extend(t.foreign_keys.iter().map(|f| format!("- {}: {}", f.name, f.def)));
        }
        if !t.indexes.is_empty() {
            lines.push(String::new());
            lines.push("**Indexes**".into());
            lines.extend(t.indexes.iter().map(|i| format!("- {}{}: {}", i.name, if i.unique { " (unique)" } else { "" }, i.def)));
        }
    }
    lines.join("\n") + "\n"
}

// Rows grouped by a key, in the order the keys first appear
pub fn group_by<T, K: std::hash::Hash + Eq + Clone>(rows: Vec<T>, key: impl Fn(&T) -> K) -> GroupMap<K, T> {
    let mut order: Vec<K> = Vec::new();
    let mut map: std::collections::HashMap<K, Vec<T>> = std::collections::HashMap::new();
    for r in rows {
        let k = key(&r);
        if !map.contains_key(&k) {
            order.push(k.clone());
        }
        map.entry(k).or_default().push(r);
    }
    GroupMap { order, map }
}

pub struct GroupMap<K, T> {
    pub order: Vec<K>,
    pub map: std::collections::HashMap<K, Vec<T>>,
}

impl<K: std::hash::Hash + Eq + Clone, T> GroupMap<K, T> {
    pub fn take(&mut self, k: &K) -> Vec<T> {
        self.map.remove(k).unwrap_or_default()
    }
    // The groups, in order
    pub fn into_groups(mut self) -> Vec<(K, Vec<T>)> {
        let order = std::mem::take(&mut self.order);
        order.into_iter().map(|k| (k.clone(), self.take(&k))).collect()
    }
}
