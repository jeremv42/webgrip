import mysql from 'mysql2'
import type { Connection, FieldPacket, Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Connection as CallbackConnection, ConnectionOptions } from 'mysql2'
import { groupBy } from '../describe.ts'
import type {
  Cell,
  CompletionInfo,
  CompletionTable,
  ResultColumn,
  SchemaDescription,
  Statement,
  StatementResult,
  TableInfo,
} from '../../shared/types.ts'
import type { Driver, DriverConfig } from './types.ts'

const typeNames: Record<number, string> = Object.fromEntries(Object.entries(mysql.Types).map(([k, v]) => [v, k]))
const BINARY_CHARSET = 63

const options = (cfg: DriverConfig, database?: string): ConnectionOptions => ({
  host: cfg.host,
  port: cfg.port || 3306,
  user: cfg.user,
  password: cfg.password,
  database,
  ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  decimalNumbers: false,
  jsonStrings: true,
  connectTimeout: 10000,
})

export const cell = (v: unknown): Cell => (Buffer.isBuffer(v) ? '0x' + v.toString('hex') : (v as Cell))

// Rows of a metadata query, typed by the caller
type Rows<R> = (R & RowDataPacket)[]

interface Session {
  conn: CallbackConnection
  busy?: boolean
}

const byName = <T extends { name: string }>(rows: T[]) => groupBy(rows, (r) => r.name)

type ExecResult =
  | { kind: 'rows'; columns: ResultColumn[]; rows: Cell[][]; truncated: boolean; total: number; warnings?: number }
  | { kind: 'command'; command: string; affected?: number; info?: string; warnings?: number }

export class MariadbDriver implements Driver {
  readonly hasSchemas = false
  cfg: DriverConfig
  meta: Pool
  sessions = new Map<string, Session>() // db -> session used by the SQL editor

  constructor(cfg: DriverConfig) {
    this.cfg = cfg
    this.meta = mysql.createPool({ ...options(cfg, cfg.database || undefined), connectionLimit: 3 }).promise()
  }

  async q<R>(sql: string, params?: unknown[]): Promise<Rows<R>> {
    return (await this.meta.query<Rows<R>>(sql, params))[0]
  }

  async test() {
    const [r] = await this.q<{ v: string }>('select version() as v')
    return r.v
  }

  async databases() {
    return (await this.q<{ Database: string }>('show databases')).map((r) => r.Database)
  }

  async schemas(): Promise<string[]> {
    return []
  }

  async tables(db?: string): Promise<TableInfo[]> {
    const rows = await this.q<{ name: string; type: string }>(
      `
      select table_name as name, table_type as type from information_schema.tables
      where table_schema = ? order by table_name`,
      [db],
    )
    return rows.map((r) => ({ name: r.name, type: /view/i.test(r.type) ? 'view' : 'table' }))
  }

  async columns(db: string | undefined, _schema: string | undefined, table: string) {
    const rows = await this.q<{ name: string; type: string; nullable: string; key: string }>(
      `
      select column_name as name, column_type as type, is_nullable as nullable, column_key as \`key\`
      from information_schema.columns where table_schema = ? and table_name = ?
      order by ordinal_position`,
      [db, table],
    )
    return rows.map((r) => ({ name: r.name, type: String(r.type), notnull: r.nullable === 'NO', pk: r.key === 'PRI' }))
  }

  // Editor autocompletion: tables / views with typed columns and routines of every user database (plus the current one).
  async completion(db?: string): Promise<CompletionInfo> {
    const user = `(%s not in ('information_schema', 'mysql', 'performance_schema', 'sys') or %s = ?)`
    const [cols, funcs] = await Promise.all([
      this.q<{ s: string; t: string; k: string; c: string; type: string; key: string }>(
        `
        select c.table_schema as s, c.table_name as t, t.table_type as k, c.column_name as c,
               c.column_type as type, c.column_key as \`key\`
        from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where ${user.replaceAll('%s', 'c.table_schema')}
        order by c.table_schema, c.table_name, c.ordinal_position limit 50000`,
        [db],
      ),
      this.q<{ s: string; name: string; kind: string; result: string | null }>(
        `
        select routine_schema as s, routine_name as name, routine_type as kind, dtd_identifier as result
        from information_schema.routines where ${user.replaceAll('%s', 'routine_schema')} order by 1, 2 limit 5000`,
        [db],
      ),
    ])
    const tables = new Map<string, CompletionTable>()
    for (const r of cols) {
      const key = r.s + '.' + r.t
      let t = tables.get(key)
      if (!t) tables.set(key, (t = { schema: r.s, name: r.t, kind: /view/i.test(r.k) ? 'view' : 'table', columns: [] }))
      t.columns.push({ name: r.c, type: String(r.type), pk: r.key === 'PRI' })
    }
    return {
      current: db ?? null,
      schemas: await this.databases(),
      tables: [...tables.values()],
      functions: funcs.map((f) => ({ schema: f.s, name: f.name, args: '', result: f.result || f.kind.toLowerCase() })),
    }
  }

  // Structure of one database for the chat export (no data).
  async describe(db = ''): Promise<SchemaDescription> {
    const [[ver], tables, columns, fks, indexes] = await Promise.all([
      this.q<{ v: string }>('select version() as v'),
      this.q<{ t: string; k: string; nrows: number | null; comment: string | null }>(
        `select table_name as t, table_type as k, table_rows as nrows, table_comment as comment
        from information_schema.tables where table_schema = ? order by table_name`,
        [db],
      ),
      this.q<{ t: string; name: string; type: string; nullable: string; def: string | null; key: string }>(
        `select table_name as t, column_name as name, column_type as type, is_nullable as nullable,
          column_default as def, column_key as \`key\`
        from information_schema.columns where table_schema = ? order by table_name, ordinal_position`,
        [db],
      ),
      this.q<{ t: string; name: string; col: string; rt: string; rc: string }>(
        `select table_name as t, constraint_name as name, column_name as col, referenced_table_name as rt, referenced_column_name as rc
        from information_schema.key_column_usage where table_schema = ? and referenced_table_name is not null
        order by table_name, constraint_name, ordinal_position`,
        [db],
      ),
      this.q<{ t: string; name: string; nu: number | string; col: string }>(
        `select table_name as t, index_name as name, non_unique as nu, column_name as col
        from information_schema.statistics where table_schema = ? and index_name <> 'PRIMARY'
        order by table_name, index_name, seq_in_index`,
        [db],
      ),
    ])
    const cols = groupBy(columns, (r) => r.t)
    const fk = groupBy(fks, (r) => r.t)
    const idx = groupBy(indexes, (r) => r.t)
    return {
      engine: /mariadb/i.test(ver.v) ? 'MariaDB' : 'MySQL',
      version: ver.v,
      database: db,
      tables: tables.map((t) => ({
        name: t.t,
        kind: /view/i.test(t.k) ? 'view' : 'table',
        rows: /view/i.test(t.k) || t.nrows == null ? null : Number(t.nrows),
        comment: t.comment && !/^VIEW$/.test(t.comment) ? t.comment : null, // MariaDB stores "VIEW" as a view's comment
        columns: (cols.get(t.t) || []).map((c) => ({
          name: c.name,
          type: String(c.type),
          notnull: c.nullable === 'NO',
          default: c.def === 'NULL' ? null : c.def,
          pk: c.key === 'PRI',
        })),
        foreignKeys: [...byName(fk.get(t.t) || []).entries()].map(([name, parts]) => ({
          name,
          def: `FOREIGN KEY (${parts.map((p) => p.col).join(', ')}) REFERENCES ${parts[0].rt} (${parts.map((p) => p.rc).join(', ')})`,
        })),
        indexes: [...byName(idx.get(t.t) || []).entries()].map(([name, parts]) => ({
          name,
          unique: Number(parts[0].nu) === 0,
          def: `(${parts.map((p) => p.col).join(', ')})`,
        })),
      })),
    }
  }

  async session(db?: string) {
    const key = db || ''
    let s = this.sessions.get(key)
    if (!s) {
      const conn = mysql.createConnection(options(this.cfg, db || this.cfg.database || undefined))
      s = { conn }
      conn.on('error', () => this.sessions.delete(key))
      conn.on('end', () => this.sessions.delete(key))
      await new Promise<void>((res, rej) => conn.connect((e) => (e ? rej(e) : res())))
      this.sessions.set(key, s)
    }
    return s
  }

  async run(db: string | undefined, _schema: string | undefined, statements: Statement[], maxRows: number) {
    const s = await this.session(db)
    if (s.busy) throw new Error('A query is already running on this database')
    s.busy = true
    try {
      const results: StatementResult[] = []
      let failed = false
      for (const st of statements) {
        if (failed) {
          results.push({ ...st, kind: 'skipped' })
          continue
        }
        const t0 = performance.now()
        try {
          const { warnings, ...r } = await this.exec(s.conn, st.sql, maxRows)
          const notices = warnings ? await this.warnings(s.conn) : []
          results.push({ ...st, ...r, ms: performance.now() - t0, notices })
        } catch (err) {
          const e = err as { message: string; code?: string }
          failed = true
          results.push({ ...st, kind: 'error', ms: performance.now() - t0, error: { message: e.message, code: e.code } })
        }
      }
      return results
    } finally {
      s.busy = false
    }
  }

  // Streams rows so that only maxRows are kept in memory.
  exec(conn: CallbackConnection, sql: string, maxRows: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      let columns: ResultColumn[] | null = null
      const rows: Cell[][] = []
      let total = 0
      let header: ResultSetHeader | null = null
      conn
        .query({ sql, rowsAsArray: true })
        .on('error', reject)
        .on('fields', (fields: FieldPacket[] | undefined) => {
          if (columns || !fields?.length) return // DML emits empty fields; keep only the first result set (CALL ...)
          columns = fields.map((f) => {
            let type = typeNames[f.columnType ?? -1] || String(f.columnType)
            if (type === 'BLOB' && f.characterSet !== BINARY_CHARSET) type = 'TEXT'
            return { name: f.name, type }
          })
        })
        .on('result', (row: unknown[] | ResultSetHeader) => {
          if (!Array.isArray(row)) {
            header ||= row
            return
          }
          if (rows.length < maxRows) rows.push(row.map(cell))
          total++
        })
        .on('end', () => {
          const h = header as ResultSetHeader | null
          if (columns) resolve({ kind: 'rows', columns, rows, truncated: total > maxRows, total, warnings: h?.warningStatus })
          else
            resolve({
              kind: 'command',
              command: sql.trim().split(/\s+/)[0].toUpperCase(),
              affected: h?.affectedRows,
              info: h?.info,
              warnings: h?.warningStatus,
            })
        })
    })
  }

  async warnings(conn: CallbackConnection) {
    const promised: Connection = conn.promise()
    const rows = await promised
      .query<Rows<{ Level: string; Message: string }>>('show warnings')
      .then(([r]) => r)
      .catch(() => [])
    return rows.map((w) => `${w.Level}: ${w.Message}`)
  }

  async cancel(db?: string) {
    const s = this.sessions.get(db || '')
    if (!s?.busy) return false
    await this.q(`kill query ${Number(s.conn.threadId)}`)
    return true
  }

  async close() {
    for (const s of this.sessions.values()) s.conn.destroy()
    this.sessions.clear()
    await this.meta.end().catch(() => {})
  }
}
