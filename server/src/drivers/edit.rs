// Cell editing, shared by the drivers: which table a result's rows can be updated in, and the UPDATEs that save changes.

use crate::error::{Error, Result};
use crate::js;
use crate::types::{EditTarget, RowChange};
use serde_json::Value;
use std::collections::HashSet;

// Where a result column comes from: a table (any key unique to it, e.g. its oid) and the column's name there
#[derive(Clone, Debug)]
pub struct ColumnSource {
    pub table: String,
    pub column: String,
}

#[derive(Clone, Debug)]
pub struct SourceTable {
    pub schema: String,
    pub name: String,
    // primary key columns (empty: no primary key, so not editable)
    pub key: Vec<String>,
    // columns that cannot be written (generated, binary shown as hex…)
    pub readonly: HashSet<String>,
}

// The rows are editable when exactly one of their tables has its whole primary key in the result, each column of
// that table shown once (a self-join shows them twice: ambiguous). Only that table's columns are then editable.
// `tables` is in the order the tables were found.
pub fn edit_target_of(sources: &[Option<ColumnSource>], tables: &[(String, SourceTable)]) -> Option<EditTarget> {
    let mut found = Vec::new();
    for (id, t) in tables {
        let names: Vec<&str> = sources.iter().flatten().filter(|s| &s.table == id).map(|s| s.column.as_str()).collect();
        let unique: HashSet<&str> = names.iter().copied().collect();
        if t.key.is_empty() || unique.len() != names.len() {
            continue;
        }
        if !t.key.iter().all(|k| names.contains(&k.as_str()) && !t.readonly.contains(k)) {
            continue;
        }
        found.push(EditTarget {
            schema: t.schema.clone(),
            table: t.name.clone(),
            columns: sources
                .iter()
                .map(|s| s.as_ref().filter(|s| &s.table == id && !t.readonly.contains(&s.column)).map(|s| s.column.clone()))
                .collect(),
            key: t.key.clone(),
        });
    }
    if found.len() == 1 {
        found.pop()
    } else {
        None
    }
}

// A parameterized UPDATE of one row; `param(i)` is the engine's placeholder for the i-th value (1-based).
pub fn update_of(
    table: &str,
    change: &RowChange,
    ident: impl Fn(&str) -> String,
    param: impl Fn(usize) -> String,
) -> Result<(String, Vec<Value>)> {
    let mut values = Vec::new();
    let set: Vec<String> = change
        .set
        .iter()
        .map(|(c, v)| {
            values.push(v.clone());
            format!("{} = {}", ident(c), param(values.len()))
        })
        .collect();
    let mut where_ = Vec::new();
    for (c, v) in &change.key {
        if v.is_null() {
            where_.push(format!("{} IS NULL", ident(c)));
        } else {
            values.push(v.clone());
            where_.push(format!("{} = {}", ident(c), param(values.len())));
        }
    }
    if set.is_empty() || where_.is_empty() {
        return Err(Error::new("Nothing to update"));
    }
    Ok((format!("UPDATE {table} SET {} WHERE {}", set.join(", "), where_.join(" AND ")), values))
}

// Each UPDATE must hit exactly one row, else the whole save is rolled back
pub fn check_updated(change: &RowChange, count: u64) -> Result<()> {
    if count == 1 {
        return Ok(());
    }
    let key = change.key.iter().map(|(c, v)| format!("{c} = {}", js::template(Some(v)))).collect::<Vec<_>>().join(", ");
    Err(Error::new(if count == 0 {
        format!("Row {key} not found (deleted or key changed since it was read)")
    } else {
        format!("Row {key} is not unique ({count} rows)")
    }))
}

// A cell value as the text sent for a parameter (None: NULL)
pub fn param_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        v => Some(js::template(Some(v))),
    }
}
