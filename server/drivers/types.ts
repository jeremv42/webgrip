import type {
  ColumnInfo,
  CompletionInfo,
  ConnectionConfig,
  ExplainMode,
  Cell,
  ResultColumn,
  RowChange,
  RowsPage,
  SchemaDescription,
  Statement,
  StatementResult,
  TableInfo,
  TableRef,
} from '../../shared/types.ts'

// A connection may be tested before it is saved: it has no id yet, and the form may leave fields empty.
export type DriverConfig = Partial<ConnectionConfig> & Pick<ConnectionConfig, 'type'>

// What a read-only query run for the chat returned
export type ExploreResult =
  | { kind: 'rows'; columns: ResultColumn[]; rows: Cell[][]; truncated: boolean }
  | { kind: 'command'; command: string }

// Time limit of a chat query
export const EXPLORE_TIMEOUT_MS = 30_000

// What the API needs from a database engine. `db` / `schema` left empty = the connection's defaults.
export interface Driver {
  readonly hasSchemas: boolean
  test(): Promise<string>
  databases(): Promise<string[]>
  schemas(db?: string): Promise<string[]>
  tables(db?: string, schema?: string): Promise<TableInfo[]>
  columns(db: string | undefined, schema: string | undefined, table: string): Promise<ColumnInfo[]>
  completion(db?: string, schema?: string): Promise<CompletionInfo>
  describe(db?: string, schema?: string): Promise<SchemaDescription>
  // Runs the statements in order on the database's dedicated session; stops at the first error.
  // With `explain`, each statement is wrapped in EXPLAIN; ANALYZE runs it in a transaction (or savepoint) rolled back afterwards.
  run(
    db: string | undefined,
    schema: string | undefined,
    statements: Statement[],
    maxRows: number,
    explain?: ExplainMode,
  ): Promise<StatementResult[]>
  // Runs a read-only statement again and returns `count` rows from `offset` (the rows after the row limit).
  page(db: string | undefined, schema: string | undefined, sql: string, offset: number, count: number): Promise<RowsPage>
  // Updates edited rows on the editor session, all or nothing (inside the session's transaction if one is open);
  // each change must hit exactly one row. Returns the number of rows updated.
  save(db: string | undefined, schema: string | undefined, target: TableRef, changes: RowChange[]): Promise<number>
  // Runs one statement for the chat on a fresh connection (never the editor session), inside a read-only transaction
  // that is rolled back, with a time limit (EXPLORE_TIMEOUT_MS). Keeps at most maxRows rows.
  explore(db: string | undefined, schema: string | undefined, sql: string, maxRows: number): Promise<ExploreResult>
  cancel(db?: string): Promise<boolean>
  close(): Promise<void>
}
