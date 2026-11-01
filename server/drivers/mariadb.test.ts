import { afterEach, describe, expect, it, vi } from 'vitest'
import { MariadbDriver, cell } from './mariadb.ts'
import type { Statement } from '../../shared/types.ts'

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
