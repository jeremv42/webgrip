// What travels as JSON between the API and the SPA: the Rust side of shared/types.ts (keep both in sync).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    #[default]
    Postgres,
    Mariadb,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: Dialect,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u32>,
    pub user: String,
    pub password: String,
    pub database: String,
    pub ssl: bool,
}

// What a driver connects with: a connection may be tested before it is saved (no id, fields left empty)
#[derive(Clone, Debug, Default)]
pub struct DriverConfig {
    pub kind: Dialect,
    pub host: Option<String>,
    pub port: Option<u32>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl: bool,
}

impl From<&ConnectionConfig> for DriverConfig {
    fn from(c: &ConnectionConfig) -> Self {
        let some = |s: &str| (!s.is_empty()).then(|| s.to_string());
        DriverConfig {
            kind: c.kind,
            host: some(&c.host),
            port: c.port,
            user: some(&c.user),
            password: some(&c.password),
            database: some(&c.database),
            ssl: c.ssl,
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
    Matview,
    Foreign,
}

#[derive(Serialize, Clone, Debug)]
pub struct TableInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: TableKind,
}

#[derive(Serialize, Clone, Debug)]
pub struct ColumnInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub notnull: bool,
    pub pk: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct CompletionColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub pk: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct CompletionTable {
    pub schema: String,
    pub name: String,
    pub kind: TableKind,
    pub columns: Vec<CompletionColumn>,
}

#[derive(Serialize, Clone, Debug)]
pub struct CompletionFunction {
    pub schema: String,
    pub name: String,
    pub args: String,
    pub result: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct CompletionInfo {
    pub current: Option<String>,
    pub schemas: Vec<String>,
    pub tables: Vec<CompletionTable>,
    pub functions: Vec<CompletionFunction>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DescribedColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub notnull: bool,
    pub default: Option<String>,
    pub pk: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ForeignKey {
    pub name: String,
    pub def: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IndexInfo {
    pub name: String,
    pub unique: bool,
    pub def: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DescribedTable {
    pub name: String,
    // "table" | "view" | "matview" | "foreign"
    pub kind: String,
    pub rows: Option<f64>,
    pub comment: Option<String>,
    pub columns: Vec<DescribedColumn>,
    pub foreign_keys: Vec<ForeignKey>,
    pub indexes: Vec<IndexInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SchemaDescription {
    pub engine: String,
    pub version: String,
    pub database: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub schemas: Option<Vec<String>>,
    pub tables: Vec<DescribedTable>,
}

// One statement of a script, with its offsets (UTF-16 code units, as the editor counts) in the text it was split from
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Statement {
    pub sql: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ResultColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExplainMode {
    Plan,
    Analyze,
}

// The table a result's rows can be updated in
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TableRef {
    pub schema: String,
    pub table: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EditTarget {
    pub schema: String,
    pub table: String,
    pub columns: Vec<Option<String>>,
    pub key: Vec<String>,
}

// One row to update: its primary key (values as read) and the new values, by table column name
#[derive(Deserialize, Clone, Debug)]
pub struct RowChange {
    pub key: serde_json::Map<String, Value>,
    pub set: serde_json::Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct PlanNode {
    pub title: String,
    pub details: Vec<String>,
    #[serde(rename = "estRows", skip_serializing_if = "Option::is_none", default)]
    pub est_rows: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub rows: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub loops: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub time: Option<f64>,
    #[serde(rename = "self", skip_serializing_if = "Option::is_none", default)]
    pub self_time: Option<f64>,
    #[serde(rename = "selfCost", skip_serializing_if = "Option::is_none", default)]
    pub self_cost: Option<f64>,
    pub children: Vec<PlanNode>,
    // MySQL / MariaDB: a query block, whose time is its total (not serialized)
    #[serde(skip)]
    pub block: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Plan {
    pub analyze: bool,
    pub root: PlanNode,
    pub summary: Vec<String>,
    pub total: f64,
}

// What a read-only query run for the chat returned
pub enum ExploreResult {
    Rows { columns: Vec<ResultColumn>, rows: Vec<Vec<Value>>, truncated: bool },
    Command { command: String },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub chat: bool,
    pub chat_run_query: bool,
    pub desktop: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    Session {
        id: String,
    },
    Text {
        text: String,
    },
    Tool {
        id: Value,
        name: String,
        input: Value,
    },
    ToolResult {
        id: Value,
        text: String,
        error: bool,
    },
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}
