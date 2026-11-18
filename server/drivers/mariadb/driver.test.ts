import { afterEach, describe, expect, it, vi } from 'vitest'
import { MariadbDriver, cell, explainPrefix } from './driver.ts'
import type { Statement } from '../../../shared/types.ts'

const st = (sql: string, start = 0): Statement => ({ sql, start, end: start + sql.length })

const drivers: MariadbDriver[] = []
afterEach(async () => {
  for (const d of drivers.splice(0)) await d.close()
})

function driverWith(exec: (sql: string) => object) {
  const d = new MariadbDriver({ type: 'mariadb', host: '127.0.0.1' })
  drivers.push(d)
  const session = { conn: { destroy: vi.fn(), threadId: 7 }, busy: false }
  vi.spyOn(d, 'session').mockResolvedValue(session as never)
  vi.spyOn(d, 'exec').mockImplementation(async (_conn, sql) => exec(sql) as never)
  vi.spyOn(d, 'warnings').mockResolvedValue(['Warning: Data truncated'])
  return { d, session }
}

describe('cell', () => {
  it('shows binary values as hex and passes the others through', () => {
    expect(cell(Buffer.from([0xca, 0xfe]))).toBe('0xcafe')
    expect(cell('a')).toBe('a')
    expect(cell(12)).toBe(12)
    expect(cell(null)).toBeNull()
  })
})

describe('MariadbDriver.run', () => {
  it('stops at the first error, skips the rest and fetches warnings only when there are some', async () => {
    const { d } = driverWith((sql) => {
      if (sql === 'boom') throw Object.assign(new Error('You have an error in your SQL syntax'), { code: 'ER_PARSE_ERROR' })
      if (sql.startsWith('insert')) return { kind: 'command', command: 'INSERT', affected: 1, warnings: 1 }
      return { kind: 'rows', columns: [{ name: 'a', type: 'LONG' }], rows: [[1]], truncated: false, total: 1, warnings: 0 }
    })
    const results = await d.run(undefined, undefined, [st('select 1'), st('insert into t values (1)'), st('boom'), st('select 2')], 10)
    expect(results.map((r) => r.kind)).toEqual(['rows', 'command', 'error', 'skipped'])
    expect(results[0]).toMatchObject({ notices: [] })
    expect(results[0]).not.toHaveProperty('warnings')
    expect(results[1]).toMatchObject({ command: 'INSERT', affected: 1, notices: ['Warning: Data truncated'] })
    expect(results[2]).toMatchObject({ error: { message: 'You have an error in your SQL syntax', code: 'ER_PARSE_ERROR' } })
    expect(d.warnings).toHaveBeenCalledTimes(1)
  })

  it('refuses a second run while one is in progress', async () => {
    const { d, session } = driverWith(() => ({ kind: 'command', command: 'SET' }))
    session.busy = true
    await expect(d.run('app', undefined, [st('set @a = 1')], 10)).rejects.toThrow('already running')
  })

  it('cancels a busy session with KILL QUERY on its thread', async () => {
    const { d, session } = driverWith(() => ({}))
    const q = vi.spyOn(d, 'q').mockResolvedValue([])
    d.sessions.set('app', session as never)
    expect(await d.cancel('app')).toBe(false)
    session.busy = true
    expect(await d.cancel('app')).toBe(true)
    expect(q).toHaveBeenCalledWith('kill query 7')
  })
})

describe('MariadbDriver.run with explain', () => {
  it('uses the JSON formats, and EXPLAIN ANALYZE on MySQL', () => {
    expect(explainPrefix('select 1', 'plan', true)).toBe('EXPLAIN FORMAT=JSON ')
    expect(explainPrefix('select 1', 'analyze', true)).toBe('ANALYZE FORMAT=JSON ')
    expect(explainPrefix('select 1', 'analyze', false)).toBe('EXPLAIN ANALYZE ')
    expect(explainPrefix('analyze select 1', 'analyze', true)).toBe('')
  })

  it('runs ANALYZE in a transaction, or a savepoint inside an open one, rolled back afterwards', async () => {
    const { d, session } = driverWith(() => ({ kind: 'rows', columns: [{ name: 'ANALYZE', type: 'VAR_STRING' }], rows: [['{}']] }))
    vi.spyOn(d, 'test').mockResolvedValue('10.11.6-MariaDB')
    let serverStatus = 2 // autocommit, no transaction
    const sent: string[] = []
    const query = vi.fn(async (sql: string) => {
      sent.push(sql)
      return [{ serverStatus }]
    })
    Object.assign(session.conn, { promise: () => ({ query }) })
    const [r] = await d.run('app', undefined, [st('update t set a = 1')], 10, 'analyze')
    expect(d.exec).toHaveBeenCalledWith(session.conn, 'ANALYZE FORMAT=JSON update t set a = 1', 10)
    expect(r).toMatchObject({ explain: 'analyze' })
    expect(r).not.toHaveProperty('plan') // '{}' is no plan
    expect(sent).toEqual(['do 0', 'start transaction', 'rollback'])
    sent.length = 0
    serverStatus = 3 // in a transaction
    await d.run('app', undefined, [st('update t set a = 1')], 10, 'analyze')
    expect(sent).toEqual([
      'do 0',
      'savepoint webgrip_explain',
      'rollback to savepoint webgrip_explain',
      'release savepoint webgrip_explain',
    ])
  })
})

describe('MariadbDriver.exec / page', () => {
  // a connection whose query streams `n` rows of one column
  const streaming = (n: number) => ({
    query: () => {
      const handlers: Record<string, (x?: unknown) => void> = {}
      const q = {
        on: (ev: string, fn: (x?: unknown) => void) => ((handlers[ev] = fn), q),
      }
      setTimeout(() => {
        handlers.fields([{ name: 'id', columnType: 3, characterSet: 63, schema: 'shop', orgTable: 't', orgName: 'id' }])
        for (let i = 1; i <= n; i++) handlers.result([i])
        handlers.end()
      })
      return q
    },
  })

  it('keeps the rows after the offset, and counts them all', async () => {
    const d = new MariadbDriver({ type: 'mariadb' })
    drivers.push(d)
    const r = await d.exec(streaming(10) as never, 'select id from t', 3, 5)
    expect(r).toMatchObject({ kind: 'rows', rows: [[6], [7], [8]], truncated: true, total: 10 })
    expect(await d.exec(streaming(10) as never, 'select id from t', 3, 8)).toMatchObject({ rows: [[9], [10]], truncated: false })
  })

  it('pages read-only statements only', async () => {
    const { d } = driverWith(() => ({ kind: 'rows', columns: [], rows: [[6]], truncated: false, total: 6 }))
    expect(await d.page('shop', undefined, 'select id from t', 5, 3)).toEqual({ rows: [[6]], truncated: false, total: 6 })
    expect(d.exec).toHaveBeenCalledWith(expect.anything(), 'select id from t', 3, 5)
    await expect(d.page('shop', undefined, 'delete from t', 0, 3)).rejects.toThrow('read-only')
  })
})

describe('MariadbDriver cell editing', () => {
  const src = (table: string, column: string, binary = false) => ({ db: 'shop', table, column, binary })

  it('finds the table from the fields, binary and generated columns read-only', async () => {
    const { d } = driverWith(() => ({
      kind: 'rows',
      columns: [{ name: 'a', type: 'LONG' }],
      rows: [[1, '0xff', 'x', 2]],
      sources: [src('t', 'id'), src('t', 'img', true), src('t', 'g'), src('', '')],
    }))
    vi.spyOn(d, 'q').mockImplementation(async (sql: string) =>
      sql.includes('key_column_usage')
        ? ([{ s: 'shop', t: 't', c: 'id' }] as never)
        : ([
            { s: 'shop', t: 't', c: 'id', k: 'PRI', extra: '' },
            { s: 'shop', t: 't', c: 'g', k: '', extra: 'VIRTUAL GENERATED' },
          ] as never),
    )
    const [r] = await d.run('shop', undefined, [st('select * from t')], 10)
    expect(r).toMatchObject({ editable: { schema: 'shop', table: 't', columns: ['id', null, null, null], key: ['id'] } })
    expect(r).not.toHaveProperty('sources')
  })

  it('counts matched rows, not changed ones, and rolls back when a row is missing', async () => {
    const { d, session } = driverWith(() => ({}))
    const sent: unknown[] = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      sent.push(values ? [sql, values] : sql)
      if (sql === 'do 0') return [{ serverStatus: 2 }]
      return [{ affectedRows: 0, info: values ? `Rows matched: ${values[1] === '1' ? 1 : 0}  Changed: 0  Warnings: 0` : '' }]
    })
    Object.assign(session.conn, { promise: () => ({ query }) })
    const target = { schema: 'shop', table: 't' }
    expect(await d.save('shop', undefined, target, [{ key: { id: '1' }, set: { a: 'x' } }])).toBe(1)
    expect(sent).toEqual(['do 0', 'start transaction', ['UPDATE `shop`.`t` SET `a` = ? WHERE `id` = ?', ['x', '1']], 'commit'])
    sent.length = 0
    await expect(d.save('shop', undefined, target, [{ key: { id: '9' }, set: { a: 'x' } }])).rejects.toThrow('id = 9 not found')
    expect(sent.at(-1)).toBe('rollback')
  })
})

describe('MariadbDriver.describe', () => {
  it('rebuilds foreign keys and indexes from their columns', async () => {
    const d = new MariadbDriver({ type: 'mariadb' })
    drivers.push(d)
    vi.spyOn(d, 'q').mockImplementation(async (sql: string) => {
      if (sql.includes('version()')) return [{ v: '11.4.2-MariaDB' }] as never
      if (sql.includes('information_schema.tables'))
        return [
          { t: 'lines', k: 'BASE TABLE', nrows: 10, comment: '' },
          { t: 'v', k: 'VIEW', nrows: null, comment: 'VIEW' },
        ] as never
      if (sql.includes('information_schema.columns'))
        return [{ t: 'lines', name: 'note', type: 'text', nullable: 'YES', def: 'NULL', key: '' }] as never
      if (sql.includes('key_column_usage'))
        return [
          { t: 'lines', name: 'fk_order', col: 'order_id', rt: 'orders', rc: 'id' },
          { t: 'lines', name: 'fk_order', col: 'shop_id', rt: 'orders', rc: 'shop_id' },
        ] as never
      return [
        { t: 'lines', name: 'ix', nu: 0, col: 'a' },
        { t: 'lines', name: 'ix', nu: 0, col: 'b' },
      ] as never
    })
    const desc = await d.describe('shop')
    expect(desc.engine).toBe('MariaDB')
    expect(desc.tables[0]).toEqual({
      name: 'lines',
      kind: 'table',
      rows: 10,
      comment: null,
      columns: [{ name: 'note', type: 'text', notnull: false, default: null, pk: false }],
      foreignKeys: [{ name: 'fk_order', def: 'FOREIGN KEY (order_id, shop_id) REFERENCES orders (id, shop_id)' }],
      indexes: [{ name: 'ix', unique: true, def: '(a, b)' }],
    })
    expect(desc.tables[1]).toMatchObject({ kind: 'view', rows: null, comment: null })
  })
})
