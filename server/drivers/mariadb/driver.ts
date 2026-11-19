import mysql from 'mysql2'
import type { Connection, FieldPacket, Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { Connection as CallbackConnection, ConnectionOptions } from 'mysql2'
import { groupBy } from '../../describe.ts'
import type {
  Cell,
  CompletionInfo,
  CompletionTable,
  ExplainMode,
  RowChange,
  RowsPage,
  ResultColumn,
  SchemaDescription,
  Statement,
  StatementResult,
  TableInfo,
  TableRef,
} from '../../../shared/types.ts'
import { EXPLORE_TIMEOUT_MS, type Driver, type DriverConfig, type ExploreResult } from '../types.ts'
import { planOf } from './plan.ts'
import { isPageable } from '../../../shared/pageable.ts'
import { checkUpdated, editTargetOf, updateOf, type ColumnSource, type SourceTable } from '../edit.ts'

const typeNames: Record<number, string> = Object.fromEntries(Object.entries(mysql.Types).map(([k, v]) => [v, k]))
const BINARY_CHARSET = 63

const SERVER_STATUS_IN_TRANS = 1
const EXPLAIN_STATEMENT = /^\s*(explain|analyze|describe|desc)\b/i

// The EXPLAIN put in front of a statement (none when it already is one). MariaDB's ANALYZE FORMAT=JSON and MySQL's
// EXPLAIN FORMAT=JSON give a JSON tree; MySQL's EXPLAIN ANALYZE (8.0.18+) only gives an indented text tree.
export function explainPrefix(sql: string, mode: ExplainMode | undefined, mariadb: boolean) {
  if (!mode || EXPLAIN_STATEMENT.test(sql)) return ''
  if (mode === 'plan') return 'EXPLAIN FORMAT=JSON '
  return mariadb ? 'ANALYZE FORMAT=JSON ' : 'EXPLAIN ANALYZE '
}

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

export const ident = (s: string) => '`' + String(s).replace(/`/g, '``') + '`'

export const cell = (v: unknown): Cell => (Buffer.isBuffer(v) ? '0x' + v.toString('hex') : (v as Cell))

// Rows of a metadata query, typed by the caller
type Rows<R> = (R & RowDataPacket)[]

interface Session {
  conn: CallbackConnection
  busy?: boolean
}

const byName = <T extends { name: string }>(rows: T[]) => groupBy(rows, (r) => r.name)

// The real table and column of a result column (empty when computed); binary columns are shown as hex, so read-only
export interface FieldSource {
  db: string
  table: string
  column: string
  binary: boolean
}

type ExecResult =
  | {
      kind: 'rows'
      columns: ResultColumn[]
      rows: Cell[][]
      truncated: boolean
      total: number
      warnings?: number
      // where each column comes from (database, table, column), for cell editing
      sources?: FieldSource[]
    }
  | { kind: 'command'; command: string; affected?: number; info?: string; warnings?: number }

export class MariadbDriver implements Driver {
  readonly hasSchemas = false
  cfg: DriverConfig
  meta: Pool
  sessions = new Map<string, Session>() // db -> session used by the SQL editor
  flavor?: Promise<boolean> // true for MariaDB, false for MySQL

  constructor(cfg: DriverConfig) {
    this.cfg = cfg
    this.meta = mysql.createPool({ ...options(cfg, cfg.database || undefined), connectionLimit: 3 }).promise()
  }

  async q<R>(sql: string, params?: unknown[]): Promise<Rows<R>> {
    return (await this.meta.query<Rows<R>>(sql, params))[0]
  }

  isMariadb() {
    this.flavor ||= this.test().then((v) => /mariadb/i.test(v))
    return this.flavor
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

  async run(db: string | undefined, _schema: string | undefined, statements: Statement[], maxRows: number, explain?: ExplainMode) {
    const mariadb = explain ? await this.isMariadb() : true
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
        const prefix = explainPrefix(st.sql, explain, mariadb)
        const mode = prefix ? { explain } : {}
        const t0 = performance.now()
        let undo: (() => Promise<void>) | null = null
        try {
          if (prefix && explain === 'analyze') undo = await this.rollbackGuard(s.conn)
          const { warnings, ...r } = await this.exec(s.conn, prefix + st.sql, maxRows)
          const ms = performance.now() - t0
          const notices = warnings ? await this.warnings(s.conn) : []
          if (r.kind === 'rows') {
            const { sources, ...rows } = r
            // an EXPLAIN / ANALYZE result, ours or typed by the user: also give it parsed
            const plan = planOf(r.columns, r.rows)
            const editable = plan || !sources ? undefined : await this.editTarget(sources)
            results.push({ ...st, ...rows, ms, notices, ...mode, ...(plan && { plan }), ...(editable && { editable }) })
          } else results.push({ ...st, ...r, ms, notices, ...mode })
        } catch (err) {
          const e = err as { message: string; code?: string }
          failed = true
          results.push({ ...st, kind: 'error', ms: performance.now() - t0, ...mode, error: { message: e.message, code: e.code } })
        } finally {
          await undo?.()
        }
      }
      return results
    } finally {
      s.busy = false
    }
  }

  async page(db: string | undefined, _schema: string | undefined, sql: string, offset: number, count: number): Promise<RowsPage> {
    if (!isPageable(sql)) throw new Error('Only a read-only query can fetch more rows')
    const s = await this.session(db)
    if (s.busy) throw new Error('A query is already running on this database')
    s.busy = true
    try {
      const r = await this.exec(s.conn, sql, count, offset)
      if (r.kind !== 'rows') throw new Error('The statement returned no rows')
      return { rows: r.rows, truncated: r.truncated, total: r.total }
    } finally {
      s.busy = false
    }
  }

  // Streams rows so that only maxRows (after `offset` skipped ones) are kept in memory.
  exec(conn: CallbackConnection, sql: string, maxRows: number, offset = 0): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      let columns: ResultColumn[] | null = null
      let sources: FieldSource[] = []
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
          sources = fields.map((f) => ({
            db: f.schema ?? '',
            table: f.orgTable ?? '',
            column: f.orgName ?? '',
            binary: f.characterSet === BINARY_CHARSET && /BLOB|STRING|BIT|GEOMETRY/.test(typeNames[f.columnType ?? -1] ?? ''),
          }))
        })
        .on('result', (row: unknown[] | ResultSetHeader) => {
          if (!Array.isArray(row)) {
            header ||= row
            return
          }
          if (total >= offset && rows.length < maxRows) rows.push(row.map(cell))
          total++
        })
        .on('end', () => {
          const h = header as ResultSetHeader | null
          if (columns)
            resolve({ kind: 'rows', columns, rows, truncated: total > offset + maxRows, total, warnings: h?.warningStatus, sources })
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

  // ANALYZE runs the statement: open a transaction (or a savepoint inside the user's own) and return what undoes it.
  // Changes to non-transactional tables (MyISAM, Aria…) cannot be undone.
  async rollbackGuard(conn: CallbackConnection) {
    const promised: Connection = conn.promise()
    const [status] = await promised.query<ResultSetHeader>('do 0')
    const inTx = status.serverStatus & SERVER_STATUS_IN_TRANS
    const undo = inTx ? ['rollback to savepoint webgrip_explain', 'release savepoint webgrip_explain'] : ['rollback']
    await promised.query(inTx ? 'savepoint webgrip_explain' : 'start transaction')
    return async () => {
      try {
        for (const sql of undo) await promised.query(sql)
      } catch {
        /* connection lost: the server rolls back anyway */
      }
    }
  }

  // Which table the rows can be updated in: the fields name each column's real database, table and column.
  // A failure here only makes the result read-only.
  async editTarget(fields: FieldSource[]) {
    const ids = new Map<string, [string, string]>()
    for (const f of fields) if (f.db && f.table) ids.set(JSON.stringify([f.db, f.table]), [f.db, f.table])
    if (!ids.size) return undefined
    try {
      const cols = await this.q<{ s: string; t: string; c: string; k: string; extra: string }>(
        `
        select table_schema as s, table_name as t, column_name as c, column_key as k, extra
        from information_schema.columns
        where ${[...ids.values()].map(() => '(table_schema = ? and table_name = ?)').join(' or ')}
        order by table_schema, table_name, ordinal_position`,
        [...ids.values()].flat(),
      )
      const keys = await this.q<{ s: string; t: string; c: string }>(
        `
        select table_schema as s, table_name as t, column_name as c from information_schema.key_column_usage
        where constraint_name = 'PRIMARY' and (${[...ids.values()].map(() => '(table_schema = ? and table_name = ?)').join(' or ')})
        order by ordinal_position`,
        [...ids.values()].flat(),
      )
      const tables = new Map<string, SourceTable>()
      for (const c of cols) {
        const id = JSON.stringify([c.s, c.t])
        let t = tables.get(id)
        if (!t) tables.set(id, (t = { schema: c.s, name: c.t, key: [], readonly: new Set() }))
        if (/GENERATED/i.test(c.extra)) t.readonly.add(c.c)
      }
      for (const k of keys) tables.get(JSON.stringify([k.s, k.t]))?.key.push(k.c)
      for (const f of fields) if (f.binary) tables.get(JSON.stringify([f.db, f.table]))?.readonly.add(f.column)
      const sources: ColumnSource[] = fields.map((f) =>
        f.db && f.table ? { table: JSON.stringify([f.db, f.table]), column: f.column } : null,
      )
      return editTargetOf(sources, tables)
    } catch {
      return undefined
    }
  }

  async save(db: string | undefined, _schema: string | undefined, target: TableRef, changes: RowChange[]) {
    const s = await this.session(db)
    if (s.busy) throw new Error('A query is already running on this database')
    s.busy = true
    try {
      const promised: Connection = s.conn.promise()
      const [status] = await promised.query<ResultSetHeader>('do 0')
      const inTx = status.serverStatus & SERVER_STATUS_IN_TRANS
      await promised.query(inTx ? 'savepoint webgrip_save' : 'start transaction')
      try {
        const table = ident(target.schema) + '.' + ident(target.table)
        for (const change of changes) {
          const { sql, values } = updateOf(table, change, ident, () => '?')
          const [r] = await promised.query<ResultSetHeader>(sql, values)
          // affectedRows only counts rows really changed: "Rows matched" tells whether the row was found
          const matched = /Rows matched:\s*(\d+)/.exec(r.info || '')
          checkUpdated(change, matched ? Number(matched[1]) : r.affectedRows)
        }
        await promised.query(inTx ? 'release savepoint webgrip_save' : 'commit')
      } catch (e) {
        const undo = inTx ? ['rollback to savepoint webgrip_save', 'release savepoint webgrip_save'] : ['rollback']
        for (const sql of undo) await promised.query(sql).catch(() => {})
        throw e
      }
      return changes.length
    } finally {
      s.busy = false
    }
  }

  async warnings(conn: CallbackConnection) {
    const promised: Connection = conn.promise()
    const rows = await promised
      .query<Rows<{ Level: string; Message: string }>>('show warnings')
      .then(([r]) => r)
      .catch(() => [])
    return rows.map((w) => `${w.Level}: ${w.Message}`)
  }

  async explore(db: string | undefined, _schema: string | undefined, sql: string, maxRows: number): Promise<ExploreResult> {
    const mariadb = await this.isMariadb()
    const conn = mysql.createConnection(options(this.cfg, db || this.cfg.database || undefined))
    conn.on('error', () => {})
    try {
      await new Promise<void>((res, rej) => conn.connect((e) => (e ? rej(e) : res())))
      const promised: Connection = conn.promise()
      await promised.query(
        mariadb
          ? `set session max_statement_time = ${EXPLORE_TIMEOUT_MS / 1000}`
          : `set session max_execution_time = ${EXPLORE_TIMEOUT_MS}`,
      )
      await promised.query('start transaction read only')
      const r = await this.exec(conn, sql, maxRows)
      return r.kind === 'rows'
        ? { kind: 'rows', columns: r.columns, rows: r.rows, truncated: r.truncated }
        : { kind: 'command', command: r.command }
    } finally {
      conn.destroy() // the server rolls the transaction back
    }
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
