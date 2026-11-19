// Types shared by the API (server/) and the SPA (client/): what travels as JSON between them.

export type Dialect = 'postgres' | 'mariadb'

export interface ConnectionConfig {
  id: string
  name: string
  type: Dialect
  host: string
  port?: number
  user: string
  password: string
  database: string
  ssl: boolean
}

// What the API returns: never the password
export type PublicConnection = Omit<ConnectionConfig, 'password'> & { hasPassword: boolean }

// Body of POST /connections and /connections/test (the connection dialog's form)
export interface ConnectionForm {
  id?: string | null
  name?: string
  type?: string
  host?: string
  port?: string | number
  user?: string
  password?: string
  database?: string
  ssl?: boolean
  // empty password on edit = keep the stored one
  keepPassword?: boolean
}

export interface ConnectionInfo {
  hasSchemas: boolean
  databases: string[]
}

export type TableKind = 'table' | 'view' | 'matview' | 'foreign'

export interface TableInfo {
  name: string
  type: TableKind
}

export interface ColumnInfo {
  name: string
  type: string
  notnull: boolean
  pk: boolean
}

// ---- editor autocompletion ----
export interface CompletionColumn {
  name: string
  type: string
  pk: boolean
}
export interface CompletionTable {
  schema: string
  name: string
  kind: TableKind
  columns: CompletionColumn[]
}
export interface CompletionFunction {
  schema: string
  name: string
  args: string
  result: string
}
export interface CompletionInfo {
  current: string | null
  schemas: string[]
  tables: CompletionTable[]
  functions: CompletionFunction[]
}

// ---- schema export (structure only) ----
export interface DescribedColumn {
  name: string
  type: string
  notnull: boolean
  default: string | null
  pk: boolean
}
export interface DescribedTable {
  name: string
  kind: TableKind
  rows: number | null
  comment: string | null
  columns: DescribedColumn[]
  foreignKeys: { name: string; def: string }[]
  indexes: { name: string; unique: boolean; def: string }[]
}
export interface SchemaDescription {
  engine: string
  version: string
  database: string
  schema?: string
  schemas?: string[]
  tables: DescribedTable[]
}

// ---- running SQL ----

// One statement of a script, with its offsets in the text it was split from
export interface Statement {
  sql: string
  start: number
  end: number
}

export type Cell = string | number | null
export interface ResultColumn {
  name: string
  type: string
}
export interface QueryError {
  message: string
  detail?: string
  hint?: string
  code?: string
  // 1-based character position in the statement (PostgreSQL)
  position?: number
}

// EXPLAIN (estimated plan) or EXPLAIN ANALYZE (runs the statement, then rolls it back)
export type ExplainMode = 'plan' | 'analyze'

interface Timed {
  ms: number
  notices?: string[]
  // set when the statement was wrapped in EXPLAIN by the API
  explain?: ExplainMode
}
// `plan`: the result read as an execution plan (EXPLAIN output), parsed by the driver
// `editable`: the rows come from one table whose primary key is in the result, so their cells can be updated
export type RowsResult = Statement &
  Timed & {
    kind: 'rows'
    columns: ResultColumn[]
    rows: Cell[][]
    truncated: boolean
    total?: number
    plan?: Plan
    editable?: EditTarget
  }
export type CommandResult = Statement & Timed & { kind: 'command'; command?: string; affected?: number; info?: string }
export type ErrorResult = Statement & Timed & { kind: 'error'; error: QueryError }
export type SkippedResult = Statement & { kind: 'skipped'; ms?: undefined; notices?: undefined; explain?: undefined }
export type StatementResult = RowsResult | CommandResult | ErrorResult | SkippedResult

// Rows after the row limit: POST /api/c/:id/rows { db, schema, sql, offset, count } runs the statement again
// (read-only statements only, see pageable.ts) and returns `count` rows from `offset`
export interface RowsPage {
  rows: Cell[][]
  // there are rows after these
  truncated: boolean
  // MySQL/MariaDB: the statement's total row count
  total?: number
}

// ---- cell editing ----

// The table a result's rows can be updated in
export interface TableRef {
  // PostgreSQL schema, MySQL/MariaDB database
  schema: string
  table: string
}
export interface EditTarget extends TableRef {
  // for each result column, the table column it shows (null: computed, from another table, or read-only)
  columns: (string | null)[]
  // primary key columns of the table, all in the result
  key: string[]
}
// One row to update: its primary key (values as read) and the new values, by table column name
export interface RowChange {
  key: Record<string, Cell>
  set: Record<string, Cell>
}
// Body of POST /api/c/:id/save
export interface SaveRequest {
  db?: string | null
  schema?: string | null
  target: TableRef
  changes: RowChange[]
}

// ---- execution plans: every engine's EXPLAIN output, normalized by its driver for the plan view ----
export interface PlanNode {
  title: string
  // "Key: value" lines (conditions, sort keys, buffers…)
  details: string[]
  // estimated rows (all loops)
  estRows?: number
  // actual rows (all loops)
  rows?: number
  loops?: number
  // the engine's total cost (inclusive)
  cost?: number
  // actual time in ms, inclusive and exclusive of the children (all loops)
  time?: number
  self?: number
  // cost of the node alone, used to rank nodes when there is no timing
  selfCost?: number
  children: PlanNode[]
}

export interface Plan {
  analyze: boolean
  root: PlanNode
  // summary lines: planning / execution time, triggers…
  summary: string[]
  // total of the measure used for the bars (time if analyzed, else cost)
  total: number
}

// ---- chat with Claude (WEBGRIP_CHAT) ----

// What the API enables, read once logged in
export interface Features {
  chat: boolean
  // Claude may run read-only queries itself (else it never sees a row unless the user attaches a result)
  chatRunQuery: boolean
  // desktop app: no login, no logout
  desktop: boolean
}

export interface ChatRequest {
  message: string
  // the conversation to continue (from a previous `session` event)
  sessionId?: string
  // the database / schema selected in the UI: the defaults of Claude's queries
  db?: string | null
  schema?: string | null
}

// One line (NDJSON) of the answer to POST /api/c/:id/chat
export type ChatEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; text: string; error: boolean }
  | { type: 'done'; error?: string }
