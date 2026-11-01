import { describe, expect, it, vi } from 'vitest'
import { PostgresDriver, ident } from './postgres.ts'
import type { Statement } from '../../shared/types.ts'

const st = (sql: string, start = 0): Statement => ({ sql, start, end: start + sql.length })

// A driver whose editor session is a fake client: `answer` maps a statement to its result (or throws)
function driverWith(answer: (sql: string) => object) {
  const d = new PostgresDriver({ type: 'postgres', database: 'app' })
  const query = vi.fn(async (q: string | { text: string }) => answer(typeof q === 'string' ? q : q.text))
  const session = { client: { query, processID: 42 }, schema: null as string | null, notices: [] as string[], busy: false }
  vi.spyOn(d, 'session').mockResolvedValue(session as never)
  vi.spyOn(d, 'cursorQuery').mockImplementation(async (_client, sql) => answer(sql) as never)
  vi.spyOn(d, 'typeName').mockImplementation(async (_db, oid) => (oid === 23 ? 'int4' : 'text'))
  return { d, query, session }
}

describe('ident', () => {
  it('double-quotes identifiers', () => {
    expect(ident('my "table"')).toBe('"my ""table"""')
  })
})

describe('PostgresDriver.run', () => {
  const rows = (n: number) => ({
    fields: [{ name: 'id', dataTypeID: 23 }],
    rows: Array.from({ length: n }, (_, i) => [String(i)]),
    command: 'SELECT',
    rowCount: n,
  })

  it('returns typed columns and marks a truncated result', async () => {
    const { d } = driverWith(() => rows(3))
    const [r] = await d.run('app', undefined, [st('select id from t')], 2)
    expect(r).toMatchObject({ kind: 'rows', columns: [{ name: 'id', type: 'int4' }], rows: [['0'], ['1']], truncated: true })
    const [all] = await d.run('app', undefined, [st('select id from t')], 3)
    expect(all).toMatchObject({ truncated: false, rows: [['0'], ['1'], ['2']] })
  })

  it('reads row statements through a cursor, the others with a plain query', async () => {
    const { d, query } = driverWith((sql) => (sql.startsWith('update') ? { command: 'UPDATE', rowCount: 4, rows: [] } : rows(1)))
    const results = await d.run('app', undefined, [st('  with x as (select 1) select * from x'), st('update t set a = 1')], 10)
    expect(d.cursorQuery).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith({ text: 'update t set a = 1', rowMode: 'array' })
    expect(results[1]).toMatchObject({ kind: 'command', command: 'UPDATE', affected: 4 })
  })

  it('stops at the first error and reports its position', async () => {
    const { d } = driverWith((sql) => {
      if (sql === 'selec 2') throw Object.assign(new Error('syntax error at or near "selec"'), { code: '42601', position: '1' })
      return rows(1)
    })
    const results = await d.run('app', undefined, [st('select 1'), st('selec 2', 10), st('select 3', 20)], 10)
    expect(results.map((r) => r.kind)).toEqual(['rows', 'error', 'skipped'])
    expect(results[1]).toMatchObject({ start: 10, error: { message: 'syntax error at or near "selec"', code: '42601', position: 1 } })
    expect(results[2]).toEqual({ ...st('select 3', 20), kind: 'skipped' })
  })

  it('sets the search_path once per schema, keeping public reachable', async () => {
    const { d, query } = driverWith(() => rows(0))
    await d.run('app', 'sales', [st('select 1')], 10)
    await d.run('app', 'sales', [st('select 1')], 10)
    await d.run('app', 'public', [st('select 1')], 10)
    expect(query.mock.calls.map(([q]) => q)).toEqual(['set search_path to "sales", public', 'set search_path to "public"'])
  })

  it('refuses a second run while one is in progress, and frees the session after an error', async () => {
    const { d, session } = driverWith(() => rows(0))
    session.busy = true
    await expect(d.run('app', undefined, [st('select 1')], 10)).rejects.toThrow('already running')
    session.busy = false
    vi.mocked(d.cursorQuery).mockRejectedValueOnce(new Error('boom'))
    await d.run('app', undefined, [st('select 1')], 10)
    expect(session.busy).toBe(false)
  })

  it('cancels only a busy session, through pg_cancel_backend', async () => {
    const { d, session } = driverWith(() => rows(0))
    const q = vi.spyOn(d, 'q').mockResolvedValue([])
    d.sessions.set('app', session as never)
    expect(await d.cancel('app')).toBe(false)
    session.busy = true
    expect(await d.cancel('app')).toBe(true)
    expect(q).toHaveBeenCalledWith('app', 'select pg_cancel_backend($1)', [42])
  })
})

describe('PostgresDriver.describe', () => {
  it('assembles tables, columns, keys and indexes of a schema', async () => {
    const d = new PostgresDriver({ type: 'postgres' })
    vi.spyOn(d, 'schemas').mockResolvedValue(['pg_catalog', 'public', 'sales'])
    vi.spyOn(d, 'q').mockImplementation(async (_db, sql: string) => {
      if (sql.includes('version()')) return [{ v: 'PostgreSQL 17.2 on x86_64-pc-linux-gnu' }]
      if (sql.includes('reltuples'))
        return [
          { t: 'orders', k: 'r', rows: '1234.0', comment: null },
          { t: 'v', k: 'v', rows: '-1', comment: 'a view' },
        ]
      if (sql.includes('pg_attrdef')) return [{ t: 'orders', name: 'id', type: 'integer', notnull: true, def: null, pk: true }]
      if (sql.includes('pg_constraint')) return [{ t: 'orders', name: 'fk', def: 'FOREIGN KEY (c) REFERENCES c(id)' }]
      return [{ t: 'orders', name: 'orders_c_idx', unique: true, def: 'CREATE UNIQUE INDEX orders_c_idx ON public.orders USING btree (c)' }]
    })
    expect(await d.describe(undefined, 'public')).toEqual({
      engine: 'PostgreSQL',
      version: 'PostgreSQL 17.2',
      database: 'postgres',
      schema: 'public',
      schemas: ['public', 'sales'],
      tables: [
        {
          name: 'orders',
          kind: 'table',
          rows: 1234,
          comment: null,
          columns: [{ name: 'id', type: 'integer', notnull: true, default: null, pk: true }],
          foreignKeys: [{ name: 'fk', def: 'FOREIGN KEY (c) REFERENCES c(id)' }],
          indexes: [{ name: 'orders_c_idx', unique: true, def: 'USING btree (c)' }],
        },
        { name: 'v', kind: 'view', rows: null, comment: 'a view', columns: [], foreignKeys: [], indexes: [] },
      ],
    })
  })
})
