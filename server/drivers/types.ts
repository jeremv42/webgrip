import type {
  ColumnInfo,
  CompletionInfo,
  ConnectionConfig,
  SchemaDescription,
  Statement,
  StatementResult,
  TableInfo,
} from '../../shared/types.ts'

// A connection may be tested before it is saved: it has no id yet, and the form may leave fields empty.
export type DriverConfig = Partial<ConnectionConfig> & Pick<ConnectionConfig, 'type'>

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
  run(db: string | undefined, schema: string | undefined, statements: Statement[], maxRows: number): Promise<StatementResult[]>
  cancel(db?: string): Promise<boolean>
  close(): Promise<void>
}
