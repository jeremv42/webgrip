import pg from 'pg'
import type { CustomTypesConfig, DatabaseError, FieldDef, QueryResultRow } from 'pg'
import Cursor from 'pg-cursor'
import { groupBy } from '../../describe.ts'
import type {
  Cell,
  ColumnInfo,
  CompletionInfo,
  CompletionTable,
  ExplainMode,
  SchemaDescription,
  Statement,
  StatementResult,
  TableInfo,
  TableKind,
} from '../../../shared/types.ts'
import type { Driver, DriverConfig } from '../types.ts'
import { planOf } from './plan.ts'

// Return every value as the raw text sent by the server (no Date/JSON/int8 conversion).
const rawTypes: CustomTypesConfig = { getTypeParser: () => (v: string) => v }
const ROW_STATEMENT = /^\s*(select|with|values|table|show|explain|fetch)\b/i
const EXPLAIN_STATEMENT = /^\s*explain\b/i
const KINDS: Record<string, TableKind> = { r: 'table', p: 'table', v: 'view', m: 'matview', f: 'foreign' }

export const ident = (s: string) => '"' + String(s).replace(/"/g, '""') + '"'

// The EXPLAIN put in front of a statement (none when it already is an EXPLAIN)
export const explainPrefix = (sql: string, mode?: ExplainMode) =>
  !mode || EXPLAIN_STATEMENT.test(sql) ? '' : `EXPLAIN (${mode === 'analyze' ? 'ANALYZE, BUFFERS, ' : ''}FORMAT JSON) `

// processID (the backend's pid, set once connected) is missing from @types/pg
type BackendClient = pg.Client & { processID: number }

interface Session {
  client: BackendClient
  schema: string | null
  notices: string[]
  busy?: boolean
}

// What a statement returned, from a cursor or a plain query
interface RawResult {
  fields?: FieldDef[]
  rows: Cell[][]
  command: string
  rowCount: number | null
}

export class PostgresDriver implements Driver {
  readonly hasSchemas = true
  cfg: DriverConfig
  pools = new Map<string, pg.Pool>() // db -> pool for metadata queries
  sessions = new Map<string, Session>() // db -> session used by the SQL editor
  typeNames = new Map<string, Map<number, string>>() // db -> (oid -> name)

  constructor(cfg: DriverConfig) {
    this.cfg = cfg
  }

  defaultDb() {
    return this.cfg.database || 'postgres'
  }

  clientConfig(db?: string | null): pg.ClientConfig {
    const { host, port, user, password, ssl } = this.cfg
    return {
      host,
      port: port || 5432,
      user,
      password,
      database: db || this.defaultDb(),
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
      application_name: 'webgrip',
      connectionTimeoutMillis: 10000,
    }
  }

  pool(db?: string | null) {
    db ||= this.defaultDb()
    let p = this.pools.get(db)
    if (!p) {
      p = new pg.Pool({ ...this.clientConfig(db), max: 3, idleTimeoutMillis: 60000 })
      p.on('error', () => {})
      this.pools.set(db, p)
    }
    return p
  }

  async q<R extends QueryResultRow>(db: string | null | undefined, sql: string, params?: unknown[]): Promise<R[]> {
    return (await this.pool(db).query<R>(sql, params)).rows
  }

  async test() {
    const [r] = await this.q<{ v: string }>(null, 'select version() as v')
    return r.v
  }

  async databases() {
    const rows = await this.q<{ datname: string }>(
      null,
      `select datname from pg_database where not datistemplate and datallowconn order by 1`,
    )
    return rows.map((r) => r.datname)
  }

  async schemas(db?: string) {
    const rows = await this.q<{ nspname: string }>(
      db,
      `
      select nspname from pg_namespace
      where nspname !~ '^pg_(toast|temp_|toast_temp_)'
      order by nspname in ('pg_catalog', 'information_schema'), nspname`,
    )
    return rows.map((r) => r.nspname)
  }

  async tables(db?: string, schema?: string): Promise<TableInfo[]> {
    const rows = await this.q<{ relname: string; relkind: string }>(
      db,
      `
      select c.relname, c.relkind from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r','p','v','m','f') and not c.relispartition
      order by c.relname`,
      [schema],
    )
    return rows.map((r) => ({ name: r.relname, type: KINDS[r.relkind] }))
  }

  async columns(db: string | undefined, schema: string | undefined, table: string) {
    return this.q<ColumnInfo>(
      db,
      `
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as notnull,
             exists (select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary
                     and a.attnum = any(i.indkey)) as pk
      from pg_attribute a
      where a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass
        and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
      [schema, table],
    )
  }

  // Editor autocompletion: every user schema (plus the current one), its tables / views with typed columns, and functions.
  async completion(db?: string, schema?: string): Promise<CompletionInfo> {
    const user = `(n.nspname !~ '^pg_' and n.nspname <> 'information_schema' or n.nspname = $1)`
    const [cols, funcs] = await Promise.all([
      this.q<{ s: string; t: string; k: string; c: string; type: string; pk: boolean }>(
        db,
        `
        select n.nspname as s, c.relname as t, c.relkind as k, a.attname as c,
               format_type(a.atttypid, a.atttypmod) as type,
               exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)) as pk
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where ${user} and c.relkind in ('r','p','v','m','f') and not c.relispartition
        order by n.nspname, c.relname, a.attnum limit 50000`,
        [schema],
      ),
      this.q<{ s: string; name: string; args: string; result: string }>(
        db,
        `
        select n.nspname as s, p.proname as name, pg_get_function_arguments(p.oid) as args,
               pg_get_function_result(p.oid) as result
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where ${user} and p.prokind in ('f','a','w') order by 1, 2 limit 5000`,
        [schema],
      ),
    ])
    const tables = new Map<string, CompletionTable>()
    for (const r of cols) {
      const key = r.s + '.' + r.t
      let t = tables.get(key)
      if (!t) tables.set(key, (t = { schema: r.s, name: r.t, kind: KINDS[r.k], columns: [] }))
      t.columns.push({ name: r.c, type: r.type, pk: r.pk })
    }
    return {
      current: schema ?? null,
      schemas: (await this.schemas(db)).filter((s) => !/^(pg_catalog|information_schema)$/.test(s) || s === schema),
      tables: [...tables.values()],
      functions: funcs.map((f) => ({ schema: f.s, name: f.name, args: f.args, result: f.result })),
    }
  }

  // Structure of one schema for the chat export (no data).
  async describe(db?: string, schema = 'public'): Promise<SchemaDescription> {
    const where = `n.nspname = $1 and c.relkind in ('r','p','v','m','f') and not c.relispartition`
    const [[ver], tables, columns, fks, indexes, schemas] = await Promise.all([
      this.q<{ v: string }>(db, 'select version() as v'),
      this.q<{ t: string; k: string; rows: string; comment: string | null }>(
        db,
        `select c.relname as t, c.relkind as k, c.reltuples as rows, obj_description(c.oid, 'pg_class') as comment
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${where} order by c.relname`,
        [schema],
      ),
      this.q<{ t: string; name: string; type: string; notnull: boolean; def: string | null; pk: boolean }>(
        db,
        `select c.relname as t, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
          pg_get_expr(d.adbin, d.adrelid) as def,
          exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)) as pk
        from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where ${where} and a.attnum > 0 and not a.attisdropped order by c.relname, a.attnum`,
        [schema],
      ),
      this.q<{ t: string; name: string; def: string }>(
        db,
        `select c.relname as t, con.conname as name, pg_get_constraintdef(con.oid) as def
        from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and con.contype = 'f' order by c.relname, con.conname`,
        [schema],
      ),
      this.q<{ t: string; name: string; unique: boolean; def: string }>(
        db,
        `select c.relname as t, i.relname as name, ix.indisunique as unique, pg_get_indexdef(ix.indexrelid) as def
        from pg_index ix join pg_class c on c.oid = ix.indrelid join pg_class i on i.oid = ix.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and not ix.indisprimary order by c.relname, i.relname`,
        [schema],
      ),
      this.schemas(db),
    ])
    const cols = groupBy(columns, (r) => r.t)
    const fk = groupBy(fks, (r) => r.t)
    const idx = groupBy(indexes, (r) => r.t)
    return {
      engine: 'PostgreSQL',
      version: ver.v.split(' on ')[0],
      database: db || this.defaultDb(),
      schema,
      schemas: schemas.filter((s) => s === schema || !/^(pg_catalog|information_schema)$/.test(s)),
      tables: tables.map((t) => ({
        name: t.t,
        kind: KINDS[t.k],
        rows: t.k === 'v' || t.k === 'f' || Number(t.rows) < 0 ? null : Math.round(Number(t.rows)),
        comment: t.comment,
        columns: (cols.get(t.t) || []).map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, default: c.def, pk: c.pk })),
        foreignKeys: (fk.get(t.t) || []).map((f) => ({ name: f.name, def: f.def })),
        indexes: (idx.get(t.t) || []).map((i) => ({
          name: i.name,
          unique: i.unique,
          def: i.def.replace(/^CREATE (?:UNIQUE )?INDEX \S+ ON \S+ /, ''),
        })),
      })),
    }
  }

  async typeName(db: string, oid: number) {
    let m = this.typeNames.get(db)
    if (!m) {
      const rows = await this.q<{ oid: number; typname: string }>(db, 'select oid::int, typname from pg_type')
      m = new Map(rows.map((r) => [Number(r.oid), r.typname]))
      this.typeNames.set(db, m)
    }
    return m.get(oid) || String(oid)
  }

  async session(db: string) {
    let s = this.sessions.get(db)
    if (!s) {
      const client = new pg.Client({ ...this.clientConfig(db), types: rawTypes }) as BackendClient
      const session: Session = { client, schema: null, notices: [] }
      client.on('error', () => this.sessions.delete(db))
      client.on('end', () => this.sessions.delete(db))
      client.on('notice', (n) => session.notices.push(`${n.severity}: ${n.message}`))
      await client.connect()
      this.sessions.set(db, (s = session))
    }
    return s
  }

  async run(db: string | undefined, schema: string | undefined, statements: Statement[], maxRows: number, explain?: ExplainMode) {
    db ||= this.defaultDb()
    const s = await this.session(db)
    if (s.busy) throw new Error('A query is already running on this database')
    s.busy = true
    try {
      if (schema && schema !== s.schema) {
        await s.client.query(`set search_path to ${ident(schema)}${schema === 'public' ? '' : ', public'}`)
        s.schema = schema
      }
      const results: StatementResult[] = []
      let failed = false
      for (const st of statements) {
        if (failed) {
          results.push({ ...st, kind: 'skipped' })
          continue
        }
        s.notices = []
        const prefix = explainPrefix(st.sql, explain)
        const sql = prefix + st.sql
        const mode = prefix ? { explain } : {}
        const t0 = performance.now()
        let undo: (() => Promise<void>) | null = null
        try {
          // (a failure here, e.g. in an aborted transaction, is the statement's error: it is not run)
          if (prefix && explain === 'analyze') undo = await this.rollbackGuard(s.client)
          const r = ROW_STATEMENT.test(sql)
            ? await this.cursorQuery(s.client, sql, maxRows)
            : await s.client.query<Cell[]>({ text: sql, rowMode: 'array' })
          results.push({ ...st, ...(await this.format(db, r, maxRows)), ms: performance.now() - t0, notices: s.notices, ...mode })
        } catch (err) {
          const e = err as DatabaseError
          const position = e.position ? Number(e.position) - prefix.length : 0
          failed = true
          results.push({
            ...st,
            kind: 'error',
            ms: performance.now() - t0,
            notices: s.notices,
            ...mode,
            error: {
              message: e.message,
              detail: e.detail,
              hint: e.hint,
              code: e.code,
              position: position > 0 ? position : undefined,
            },
          })
        } finally {
          await undo?.()
        }
      }
      return results
    } finally {
      s.busy = false
    }
  }

  // EXPLAIN ANALYZE runs the statement: open a transaction (or a savepoint inside the user's own) and return what undoes it.
  async rollbackGuard(client: pg.Client) {
    const status = client.getTransactionStatus()
    if (status === 'E') return null // failed transaction: the statement will be refused anyway
    const undo = status === 'T' ? ['rollback to savepoint webgrip_explain', 'release savepoint webgrip_explain'] : ['rollback']
    await client.query(status === 'T' ? 'savepoint webgrip_explain' : 'begin')
    return async () => {
      try {
        for (const sql of undo) await client.query(sql)
      } catch {
        /* connection lost: the server rolls back anyway */
      }
    }
  }

  // Reads one row more than maxRows, to know whether the result was truncated.
  cursorQuery(client: pg.Client, sql: string, maxRows: number): Promise<RawResult> {
    const cursor = client.query(new Cursor<Cell[]>(sql, undefined, { rowMode: 'array', types: rawTypes }))
    return new Promise((resolve, reject) => {
      cursor.read(maxRows + 1, (err, rows, result) => {
        if (err) return void cursor.close(() => reject(err))
        cursor.close(() => resolve({ fields: result.fields, rows, command: result.command, rowCount: result.rowCount }))
      })
    })
  }

  async format(db: string, r: RawResult, maxRows: number) {
    if (r.fields?.length) {
      const columns = []
      for (const f of r.fields) columns.push({ name: f.name, type: await this.typeName(db, f.dataTypeID) })
      const truncated = r.rows.length > maxRows
      const rows = truncated ? r.rows.slice(0, maxRows) : r.rows
      // an EXPLAIN (FORMAT JSON) result, ours or typed by the user: also give it parsed
      const plan = planOf(columns, rows)
      return { kind: 'rows' as const, columns, rows, truncated, ...(plan && { plan }) }
    }
    return { kind: 'command' as const, command: r.command, affected: r.rowCount ?? undefined }
  }

  async cancel(db?: string) {
    const s = this.sessions.get(db || this.defaultDb())
    if (!s?.busy) return false
    await this.q(db, 'select pg_cancel_backend($1)', [s.client.processID])
    return true
  }

  async close() {
    for (const s of this.sessions.values()) s.client.end().catch(() => {})
    for (const p of this.pools.values()) p.end().catch(() => {})
    this.sessions.clear()
    this.pools.clear()
  }
}
