import mysql from 'mysql2'
import { groupBy } from '../describe.js'

const typeNames = Object.fromEntries(Object.entries(mysql.Types).map(([k, v]) => [v, k]))
const BINARY_CHARSET = 63

const options = (cfg, database) => ({
  host: cfg.host, port: cfg.port || 3306, user: cfg.user, password: cfg.password, database,
  ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, jsonStrings: true,
  connectTimeout: 10000,
})

const cell = (v) => (Buffer.isBuffer(v) ? '0x' + v.toString('hex') : v)

export class MariadbDriver {
  hasSchemas = false

  constructor(cfg) {
    this.cfg = cfg
    this.meta = mysql.createPool({ ...options(cfg, cfg.database || undefined), connectionLimit: 3 }).promise()
    this.sessions = new Map() // db -> { conn, busy }
  }

  async q(sql, params) {
    return (await this.meta.query(sql, params))[0]
  }

  async test() {
    const [r] = await this.q('select version() as v')
    return r.v
  }

  async databases() {
    return (await this.q('show databases')).map((r) => r.Database)
  }

  async schemas() { return [] }

  async tables(db) {
    const rows = await this.q(`
      select table_name as name, table_type as type from information_schema.tables
      where table_schema = ? order by table_name`, [db])
    return rows.map((r) => ({ name: r.name, type: /view/i.test(r.type) ? 'view' : 'table' }))
  }

  async columns(db, _schema, table) {
    const rows = await this.q(`
      select column_name as name, column_type as type, is_nullable as nullable, column_key as \`key\`
      from information_schema.columns where table_schema = ? and table_name = ?
      order by ordinal_position`, [db, table])
    return rows.map((r) => ({ name: r.name, type: String(r.type), notnull: r.nullable === 'NO', pk: r.key === 'PRI' }))
  }

  // Editor autocompletion: tables / views with typed columns and routines of every user database (plus the current one).
  async completion(db) {
    const user = `(%s not in ('information_schema', 'mysql', 'performance_schema', 'sys') or %s = ?)`
    const [cols, funcs] = await Promise.all([
      this.q(`
        select c.table_schema as s, c.table_name as t, t.table_type as k, c.column_name as c,
               c.column_type as type, c.column_key as \`key\`
        from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where ${user.replaceAll('%s', 'c.table_schema')}
        order by c.table_schema, c.table_name, c.ordinal_position limit 50000`, [db]),
      this.q(`
        select routine_schema as s, routine_name as name, routine_type as kind, dtd_identifier as result
        from information_schema.routines where ${user.replaceAll('%s', 'routine_schema')} order by 1, 2 limit 5000`, [db]),
    ])
    const tables = new Map()
    for (const r of cols) {
      const key = r.s + '.' + r.t
      if (!tables.has(key)) tables.set(key, { schema: r.s, name: r.t, kind: /view/i.test(r.k) ? 'view' : 'table', columns: [] })
      tables.get(key).columns.push({ name: r.c, type: String(r.type), pk: r.key === 'PRI' })
    }
    return {
      current: db,
      schemas: await this.databases(),
      tables: [...tables.values()],
      functions: funcs.map((f) => ({ schema: f.s, name: f.name, args: '', result: f.result || f.kind.toLowerCase() })),
    }
  }

  // Structure of one database for the chat export (no data).
  async describe(db) {
    const [[ver], tables, columns, fks, indexes] = await Promise.all([
      this.q('select version() as v'),
      this.q(`select table_name as t, table_type as k, table_rows as nrows, table_comment as comment
        from information_schema.tables where table_schema = ? order by table_name`, [db]),
      this.q(`select table_name as t, column_name as name, column_type as type, is_nullable as nullable,
          column_default as def, column_key as \`key\`
        from information_schema.columns where table_schema = ? order by table_name, ordinal_position`, [db]),
      this.q(`select table_name as t, constraint_name as name, column_name as col, referenced_table_name as rt, referenced_column_name as rc
        from information_schema.key_column_usage where table_schema = ? and referenced_table_name is not null
        order by table_name, constraint_name, ordinal_position`, [db]),
      this.q(`select table_name as t, index_name as name, non_unique as nu, column_name as col
        from information_schema.statistics where table_schema = ? and index_name <> 'PRIMARY'
        order by table_name, index_name, seq_in_index`, [db]),
    ])
    const cols = groupBy(columns, (r) => r.t), fk = groupBy(fks, (r) => r.t), idx = groupBy(indexes, (r) => r.t)
    const byName = (rows) => groupBy(rows, (r) => r.name)
    return {
      engine: /mariadb/i.test(ver.v) ? 'MariaDB' : 'MySQL', version: ver.v, database: db,
      tables: tables.map((t) => ({
        name: t.t, kind: /view/i.test(t.k) ? 'view' : 'table', rows: /view/i.test(t.k) || t.nrows == null ? null : Number(t.nrows), comment: t.comment && !/^VIEW$/.test(t.comment) ? t.comment : null, // MariaDB stores "VIEW" as a view's comment
        columns: (cols.get(t.t) || []).map((c) => ({ name: c.name, type: String(c.type), notnull: c.nullable === 'NO', default: c.def === 'NULL' ? null : c.def, pk: c.key === 'PRI' })),
        foreignKeys: [...byName(fk.get(t.t) || []).entries()].map(([name, parts]) => ({
          name, def: `FOREIGN KEY (${parts.map((p) => p.col).join(', ')}) REFERENCES ${parts[0].rt} (${parts.map((p) => p.rc).join(', ')})`,
        })),
        indexes: [...byName(idx.get(t.t) || []).entries()].map(([name, parts]) => ({
          name, unique: Number(parts[0].nu) === 0, def: `(${parts.map((p) => p.col).join(', ')})`,
        })),
      })),
    }
  }

  async session(db) {
    const key = db || ''
    let s = this.sessions.get(key)
    if (!s) {
      const conn = mysql.createConnection(options(this.cfg, db || this.cfg.database || undefined))
      s = { conn }
      conn.on('error', () => this.sessions.delete(key))
      conn.on('end', () => this.sessions.delete(key))
      await new Promise((res, rej) => conn.connect((e) => (e ? rej(e) : res())))
      this.sessions.set(key, s)
    }
    return s
  }

  async run(db, _schema, statements, maxRows) {
    const s = await this.session(db)
    if (s.busy) throw new Error('A query is already running on this database')
    s.busy = true
    try {
      const results = []
      let failed = false
      for (const st of statements) {
        if (failed) { results.push({ ...st, kind: 'skipped' }); continue }
        const t0 = performance.now()
        try {
          const r = await this.exec(s.conn, st.sql, maxRows)
          const notices = r.warnings ? await this.warnings(s.conn) : []
          results.push({ ...st, ...r, ms: performance.now() - t0, notices })
        } catch (e) {
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
  exec(conn, sql, maxRows) {
    return new Promise((resolve, reject) => {
      let columns = null
      const rows = []
      let total = 0
      let header = null
      conn.query({ sql, rowsAsArray: true })
        .on('error', reject)
        .on('fields', (fields) => {
          if (columns || !fields?.length) return // DML emits empty fields; keep only the first result set (CALL ...)
          columns = fields.map((f) => {
            let type = typeNames[f.columnType] || String(f.columnType)
            if (type === 'BLOB' && f.characterSet !== BINARY_CHARSET) type = 'TEXT'
            return { name: f.name, type }
          })
        })
        .on('result', (row) => {
          if (!Array.isArray(row)) { header ||= row; return }
          if (rows.length < maxRows) rows.push(row.map(cell))
          total++
        })
        .on('end', () => {
          if (columns) resolve({ kind: 'rows', columns, rows, truncated: total > maxRows, total, warnings: header?.warningStatus })
          else resolve({ kind: 'command', command: sql.trim().split(/\s+/)[0].toUpperCase(), affected: header?.affectedRows, info: header?.info, warnings: header?.warningStatus })
        })
    })
  }

  async warnings(conn) {
    const rows = await conn.promise().query('show warnings').then(([r]) => r).catch(() => [])
    return rows.map((w) => `${w.Level}: ${w.Message}`)
  }

  async cancel(db) {
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
