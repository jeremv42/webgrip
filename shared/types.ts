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

interface Timed {
  ms: number
  notices?: string[]
}
export type RowsResult = Statement & Timed & { kind: 'rows'; columns: ResultColumn[]; rows: Cell[][]; truncated: boolean; total?: number }
export type CommandResult = Statement & Timed & { kind: 'command'; command?: string; affected?: number; info?: string }
export type ErrorResult = Statement & Timed & { kind: 'error'; error: QueryError }
export type SkippedResult = Statement & { kind: 'skipped'; ms?: undefined; notices?: undefined }
export type StatementResult = RowsResult | CommandResult | ErrorResult | SkippedResult
