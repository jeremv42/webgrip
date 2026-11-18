import { describe, expect, it, vi } from 'vitest'
import { PostgresDriver, explainPrefix, ident } from './driver.ts'
import type { Statement } from '../../../shared/types.ts'

const st = (sql: string, start = 0): Statement => ({ sql, start, end: start + sql.length })

// A driver whose editor session is a fake client: `answer` maps a statement to its result (or throws)
function driverWith(answer: (sql: string) => object) {
  const d = new PostgresDriver({ type: 'postgres', database: 'app' })
  const query = vi.fn(async (q: string | { text: string }) => answer(typeof q === 'string' ? q : q.text))
  const tx = { status: 'I' }
  const client = { query, processID: 42, getTransactionStatus: () => tx.status }
  const session = { client, schema: null as string | null, notices: [] as string[], busy: false }
  vi.spyOn(d, 'session').mockResolvedValue(session as never)
  vi.spyOn(d, 'cursorQuery').mockImplementation(async (_client, sql) => answer(sql) as never)
  vi.spyOn(d, 'typeName').mockImplementation(async (_db, oid) => (oid === 23 ? 'int4' : oid === 114 ? 'json' : 'text'))
  return { d, query, session, tx }
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

describe('PostgresDriver.page', () => {
  it('runs the statement again in the schema, from the offset, and tells whether more rows follow', async () => {
    const { d, query } = driverWith(() => ({}))
    const rows = vi.spyOn(d, 'cursorRows').mockResolvedValue([['501'], ['502'], ['503']])
    expect(await d.page('app', 'sales', 'select * from t', 500, 2)).toEqual({ rows: [['501'], ['502']], truncated: true })
    expect(rows).toHaveBeenCalledWith(expect.anything(), 'select * from t', 500, 3)
    expect(query).toHaveBeenCalledWith('set search_path to "sales", public')
    rows.mockResolvedValue([['501']])
    expect(await d.page('app', 'sales', 'select * from t', 500, 2)).toEqual({ rows: [['501']], truncated: false })
    await expect(d.page('app', undefined, 'update t set a = 1 returning *', 0, 2)).rejects.toThrow('read-only')
  })
})

describe('PostgresDriver cell editing', () => {
  const fields = [
    { name: 'id', dataTypeID: 23, tableID: 100, columnID: 1 },
    { name: 'note', dataTypeID: 25, tableID: 100, columnID: 2 },
    { name: 'n', dataTypeID: 23, tableID: 0, columnID: 0 },
  ]
  const attributes = [
    { rel: 100, num: 1, name: 'id', s: 'public', t: 'orders', pk: true, ro: false },
    { rel: 100, num: 2, name: 'note', s: 'public', t: 'orders', pk: false, ro: false },
  ]

  it('marks rows read from one table with its primary key as editable', async () => {
    const { d } = driverWith(() => ({ fields, rows: [['1', 'a', '3']], command: 'SELECT', rowCount: 1 }))
    const q = vi.spyOn(d, 'q').mockResolvedValue(attributes)
    const [r] = await d.run('app', undefined, [st('select id, note, 1 + 2 n from orders')], 10)
    expect(q.mock.lastCall?.[2]).toEqual([[100]])
    expect(r).toMatchObject({ editable: { schema: 'public', table: 'orders', columns: ['id', 'note', null], key: ['id'] } })
  })

  it('updates in a transaction, checks each row was found, and rolls back otherwise', async () => {
    const { d, query, tx } = driverWith((sql) => ({ rowCount: sql.includes('UPDATE') ? (sql.includes('IS NULL') ? 0 : 1) : null }))
    const target = { schema: 'sales', table: 'orders' }
    expect(await d.save('app', undefined, target, [{ key: { id: '1', k: 'a' }, set: { note: 'x', n: null } }])).toBe(1)
    expect(query.mock.calls).toEqual([
      ['begin'],
      ['UPDATE "sales"."orders" SET "note" = $1, "n" = $2 WHERE "id" = $3 AND "k" = $4', ['x', null, '1', 'a']],
      ['commit'],
    ])
    query.mockClear()
    tx.status = 'T'
    await expect(d.save('app', undefined, target, [{ key: { id: null }, set: { note: 'x' } }])).rejects.toThrow('not found')
    expect(query.mock.calls.map(([q]) => q)).toEqual([
      'savepoint webgrip_save',
      'UPDATE "sales"."orders" SET "note" = $1 WHERE "id" IS NULL',
      'rollback to savepoint webgrip_save',
      'release savepoint webgrip_save',
    ])
    tx.status = 'E'
    await expect(d.save('app', undefined, target, [{ key: { id: '1' }, set: { note: 'x' } }])).rejects.toThrow('failed')
  })
})

describe('PostgresDriver.run with explain', () => {
  const plan = {
    fields: [{ name: 'QUERY PLAN', dataTypeID: 114 }],
    rows: [['[{"Plan":{"Node Type":"Seq Scan","Relation Name":"t"}}]']],
    command: 'EXPLAIN',
    rowCount: 1,
  }

  it('builds the EXPLAIN prefix, and leaves an EXPLAIN alone', () => {
    expect(explainPrefix('select 1', 'plan')).toBe('EXPLAIN (FORMAT JSON) ')
    expect(explainPrefix('select 1', 'analyze')).toBe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ')
    expect(explainPrefix('  explain select 1', 'analyze')).toBe('')
    expect(explainPrefix('select 1', undefined)).toBe('')
  })

  it('wraps the statement, through a cursor, and marks the result', async () => {
    const { d, query } = driverWith(() => plan)
    const [r] = await d.run('app', undefined, [st('update t set a = 1')], 10, 'plan')
    expect(d.cursorQuery).toHaveBeenCalledWith(expect.anything(), 'EXPLAIN (FORMAT JSON) update t set a = 1', 10)
    expect(query).not.toHaveBeenCalled() // no transaction for a plain EXPLAIN
    expect(r).toMatchObject({ kind: 'rows', explain: 'plan', sql: 'update t set a = 1' })
    // the raw output, plus its parsed tree
    expect(r).toMatchObject({
      rows: [['[{"Plan":{"Node Type":"Seq Scan","Relation Name":"t"}}]']],
      plan: { root: { title: 'Seq Scan on t' } },
    })
  })

  it('runs ANALYZE in a transaction rolled back afterwards, even when it fails', async () => {
    const { d, query } = driverWith((sql) => {
      if (sql.includes('boom')) throw Object.assign(new Error('syntax error'), { position: '48' })
      return plan
    })
    await d.run('app', undefined, [st('delete from t')], 10, 'analyze')
    expect(query.mock.calls.map(([q]) => q)).toEqual(['begin', 'rollback'])
    const [r] = await d.run('app', undefined, [st('select boom')], 10, 'analyze')
    expect(query.mock.calls.map(([q]) => q).slice(2)).toEqual(['begin', 'rollback'])
    // position given in the wrapped text, brought back into the statement
    expect(r).toMatchObject({
      kind: 'error',
      explain: 'analyze',
      error: { position: 48 - 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '.length },
    })
  })

  it("uses a savepoint inside the user's transaction, and nothing in a failed one", async () => {
    const { d, query, tx } = driverWith(() => plan)
    tx.status = 'T'
    await d.run('app', undefined, [st('delete from t')], 10, 'analyze')
    expect(query.mock.calls.map(([q]) => q)).toEqual([
      'savepoint webgrip_explain',
      'rollback to savepoint webgrip_explain',
      'release savepoint webgrip_explain',
    ])
    query.mockClear()
    tx.status = 'E'
    await d.run('app', undefined, [st('delete from t')], 10, 'analyze')
    expect(query).not.toHaveBeenCalled()
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
