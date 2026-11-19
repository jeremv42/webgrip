import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { unseal } from './vault.ts'
import type { Driver, DriverConfig } from './drivers/types.ts'
import type { ExplainMode, PublicConnection, RowChange, Statement, TableRef } from '../shared/types.ts'

// A driver that records what the API asks of it
function fakeDriver(cfg: DriverConfig) {
  return {
    cfg,
    hasSchemas: cfg.type !== 'mariadb',
    test: vi.fn(async () => `fake ${cfg.type} for ${cfg.user}:${cfg.password}`),
    databases: vi.fn(async () => ['app', 'postgres']),
    schemas: vi.fn(async () => ['public']),
    tables: vi.fn(async () => [{ name: 't', type: 'table' as const }]),
    columns: vi.fn(async () => []),
    completion: vi.fn(async () => ({ current: null, schemas: [], tables: [], functions: [] })),
    describe: vi.fn(async (db?: string) => ({ engine: 'Fake', version: '1', database: db ?? '', tables: [] })),
    run: vi.fn(
      async (_db: string | undefined, _schema: string | undefined, statements: Statement[], _maxRows: number, _explain?: ExplainMode) =>
        statements.map((st) => ({ ...st, kind: 'command' as const, command: 'OK', ms: 1 })),
    ),
    page: vi.fn(async (_db: string | undefined, _schema: string | undefined, _sql: string, offset: number, count: number) => ({
      rows: [[offset], [offset + count - 1]],
      truncated: true,
    })),
    save: vi.fn(async (_db: string | undefined, _schema: string | undefined, _target: TableRef, changes: RowChange[]) => changes.length),
    explore: vi.fn(async (_db: string | undefined, _schema: string | undefined, sql: string, _maxRows: number) => ({
      kind: 'rows' as const,
      columns: [{ name: 'sql', type: 'text' }],
      rows: [[sql], [null]],
      truncated: false,
    })),
    cancel: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  } satisfies Driver & { cfg: DriverConfig }
}

let dir: string
let dataFile: string
let server: Server
let base: string
let made: ReturnType<typeof fakeDriver>[]
let cookie: string

const secret = 'test-secret-0123456789'
const password = 'pw'
const options = { secret, password }
// what is stored on disk, decrypted
const stored = () => JSON.parse(unseal(JSON.parse(fs.readFileSync(dataFile, 'utf8')), secret))

async function listen(app: ReturnType<typeof createApp>) {
  const s = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => s.once('listening', resolve))
  return { server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}/api` }
}

async function login(url: string, pw: string) {
  return fetch(url + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webgrip-'))
  dataFile = path.join(dir, 'data', 'connections.json')
  made = []
  const app = createApp({
    dataFile,
    ...options,
    makeDriver: (cfg) => {
      const d = fakeDriver(cfg)
      made.push(d)
      return d
    },
  })
  ;({ server, base } = await listen(app))
  cookie = (await login(base, password)).headers.get('set-cookie')!.split(';')[0]
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(dir, { recursive: true, force: true })
})

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json', cookie } : { cookie },
    body: body ? JSON.stringify(body) : undefined,
  })
  // oxlint-disable-next-line typescript/no-explicit-any -- each test knows the shape it expects
  return { status: res.status, body: (await res.json()) as any }
}

const saveConn = async (form: object): Promise<PublicConnection> => (await call('POST', '/connections', form)).body

describe('connections', () => {
  it('saves a connection with defaults and never returns its password', async () => {
    const c = await saveConn({ user: 'bob', password: 'secret', port: '6543' })
    expect(c).toEqual({
      id: expect.any(String),
      name: 'bob@localhost',
      type: 'postgres',
      host: 'localhost',
      port: 6543,
      user: 'bob',
      database: '',
      ssl: false,
      hasPassword: true,
    })
    expect((await call('GET', '/connections')).body).toEqual([c])
    // stored on disk encrypted, password included, readable by the owner only
    expect(fs.readFileSync(dataFile, 'utf8')).not.toContain('secret')
    expect(stored()[0].password).toBe('secret')
    expect(fs.statSync(dataFile).mode & 0o777).toBe(0o600)
  })

  it('keeps the stored password on edit only when asked to', async () => {
    const c = await saveConn({ name: 'db', user: 'bob', password: 'secret', type: 'mariadb' })
    await saveConn({ ...c, name: 'renamed', password: '', keepPassword: true })
    expect(stored()).toHaveLength(1)
    expect(stored()[0]).toMatchObject({ id: c.id, name: 'renamed', type: 'mariadb', password: 'secret' })

    await saveConn({ ...c, password: '', keepPassword: false })
    expect(stored()[0].password).toBe('')
  })

  it('reloads the saved connections at startup', async () => {
    const c = await saveConn({ user: 'bob', host: 'db' })
    const other = await listen(createApp({ dataFile, ...options, makeDriver: fakeDriver }))
    // the session cookie stays valid across restarts
    const res = await fetch(other.base + '/connections', { headers: { cookie } })
    expect(await res.json()).toEqual([c])
    await new Promise((resolve) => other.server.close(resolve))
  })

  it('encrypts a plain-text connections file written by an older version', async () => {
    const plain = [{ id: 'x', name: 'old', type: 'postgres', host: 'h', user: 'u', password: 'p', database: '', ssl: false }]
    fs.mkdirSync(path.dirname(dataFile))
    fs.writeFileSync(dataFile, JSON.stringify(plain), { mode: 0o644 })
    const other = await listen(createApp({ dataFile, ...options, makeDriver: fakeDriver }))
    expect(fs.readFileSync(dataFile, 'utf8')).not.toContain('"p"')
    expect(stored()).toEqual(plain)
    expect(fs.statSync(dataFile).mode & 0o777).toBe(0o600)
    const res = await fetch(other.base + '/connections', { headers: { cookie } })
    const { password: _, ...pub } = plain[0]
    expect(await res.json()).toEqual([{ ...pub, hasPassword: true }])
    await new Promise((resolve) => other.server.close(resolve))
  })

  it('refuses to start with the wrong secret instead of losing the connections', async () => {
    await saveConn({ user: 'bob' })
    expect(() => createApp({ dataFile, secret: 'another-secret-012345', password })).toThrow(/WEBGRIP_SECRET/)
    expect(stored()).toHaveLength(1)
  })

  it('deletes a connection and closes its driver', async () => {
    const c = await saveConn({ user: 'bob' })
    await call('GET', `/c/${c.id}/info`)
    expect((await call('DELETE', `/connections/${c.id}`)).body).toEqual({ ok: true })
    expect(made[0].close).toHaveBeenCalled()
    expect((await call('GET', '/connections')).body).toEqual([])
  })

  it('drops the live driver when a connection is edited', async () => {
    const c = await saveConn({ user: 'bob' })
    await call('GET', `/c/${c.id}/info`)
    await saveConn({ ...c, host: 'elsewhere' })
    expect(made[0].close).toHaveBeenCalled()
    await call('GET', `/c/${c.id}/info`)
    expect(made[1].cfg.host).toBe('elsewhere')
  })

  it('tests a configuration with the stored password, then closes the driver', async () => {
    const c = await saveConn({ user: 'bob', password: 'secret' })
    const { body } = await call('POST', '/connections/test', { ...c, password: '', keepPassword: true })
    expect(body).toEqual({ version: 'fake postgres for bob:secret' })
    expect(made[0].close).toHaveBeenCalled()
  })

  it('reports a failed test as a 400 with the error message', async () => {
    const app = createApp({
      dataFile,
      ...options,
      makeDriver: (cfg) => ({ ...fakeDriver(cfg), test: async () => Promise.reject(new Error('connection refused')) }),
    })
    const other = await listen(app)
    const res = await fetch(other.base + '/connections/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ user: 'bob' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'connection refused' })
    await new Promise((resolve) => other.server.close(resolve))
  })
})

describe('database routes', () => {
  it('answers 404 for an unknown connection', async () => {
    expect(await call('GET', '/c/nope/info')).toEqual({ status: 404, body: { error: 'Unknown connection' } })
  })

  it('reuses one driver per connection and passes query parameters', async () => {
    const c = await saveConn({ user: 'bob' })
    expect((await call('GET', `/c/${c.id}/info`)).body).toEqual({ hasSchemas: true, databases: ['app', 'postgres'] })
    await call('GET', `/c/${c.id}/tables?db=app&schema=sales`)
    await call('GET', `/c/${c.id}/columns?db=app&schema=sales&table=orders`)
    await call('GET', `/c/${c.id}/schemas?db=`)
    expect(made).toHaveLength(1)
    expect(made[0].tables).toHaveBeenCalledWith('app', 'sales')
    expect(made[0].columns).toHaveBeenCalledWith('app', 'sales', 'orders')
    expect(made[0].schemas).toHaveBeenCalledWith(undefined)
  })

  it('exports the structure as Markdown', async () => {
    const c = await saveConn({ user: 'bob' })
    const { body } = await call('GET', `/c/${c.id}/describe?db=app`)
    expect(body.markdown).toMatch(/^# app — 1\n/)
  })

  it('splits the script with the connection dialect and clamps maxRows', async () => {
    const pg = await saveConn({ user: 'bob' })
    const { body } = await call('POST', `/c/${pg.id}/query`, { sql: 'select `a;b`; select 2', db: 'app', maxRows: 10 ** 9 })
    expect(body.results.map((r: { sql: string }) => r.sql)).toEqual(['select `a', 'b`', 'select 2'])
    expect(made[0].run).toHaveBeenLastCalledWith('app', undefined, expect.any(Array), 100000, undefined)

    const my = await saveConn({ user: 'bob', type: 'mariadb' })
    await call('POST', `/c/${my.id}/query`, { sql: 'select `a;b`; select 2', maxRows: 0 })
    expect(made[1].run.mock.lastCall?.[2].map((s) => s.sql)).toEqual(['select `a;b`', 'select 2'])
    expect(made[1].run.mock.lastCall?.[3]).toBe(500) // 0 = default
  })

  it('forwards a valid explain mode only', async () => {
    const c = await saveConn({ user: 'bob' })
    await call('POST', `/c/${c.id}/query`, { sql: 'select 1', explain: 'analyze' })
    expect(made[0].run.mock.lastCall?.[4]).toBe('analyze')
    await call('POST', `/c/${c.id}/query`, { sql: 'select 1', explain: 'drop' })
    expect(made[0].run.mock.lastCall?.[4]).toBeUndefined()
  })

  it('does not call the driver for an empty script', async () => {
    const c = await saveConn({ user: 'bob' })
    expect((await call('POST', `/c/${c.id}/query`, { sql: ' -- nothing ; ' })).body).toEqual({ results: [] })
    expect(made[0].run).not.toHaveBeenCalled()
  })

  it('fetches more rows of a read-only statement only, with a clamped count', async () => {
    const c = await saveConn({ user: 'bob' })
    const { body } = await call('POST', `/c/${c.id}/rows`, { db: 'app', sql: 'select * from t', offset: 500, count: 10 ** 9 })
    expect(body).toEqual({ rows: [[500], [100499]], truncated: true })
    expect(made[0].page).toHaveBeenCalledWith('app', undefined, 'select * from t', 500, 100000)
    const refused = await call('POST', `/c/${c.id}/rows`, { sql: 'delete from t returning *', offset: 0 })
    expect(refused).toEqual({ status: 400, body: { error: 'Only a read-only query can fetch more rows' } })
    expect(made[0].page).toHaveBeenCalledTimes(1)
  })

  it('forwards edited rows to the driver, and rejects a malformed save', async () => {
    const c = await saveConn({ user: 'bob' })
    const target = { schema: 'public', table: 'orders' }
    const changes = [{ key: { id: '1' }, set: { note: 'x' } }]
    expect((await call('POST', `/c/${c.id}/save`, { db: 'app', schema: '', target, changes })).body).toEqual({ updated: 1 })
    expect(made[0].save).toHaveBeenCalledWith('app', undefined, target, changes)
    for (const body of [
      { target, changes: [] },
      { target: { table: 't' }, changes },
      { target, changes: [{ key: 1 }] },
    ])
      expect((await call('POST', `/c/${c.id}/save`, body)).status).toBe(400)
    expect(made[0].save).toHaveBeenCalledTimes(1)
  })

  it('forwards cancel to the driver', async () => {
    const c = await saveConn({ user: 'bob' })
    expect((await call('POST', `/c/${c.id}/cancel`, { db: 'app' })).body).toEqual({ cancelled: true })
    expect(made[0].cancel).toHaveBeenCalledWith('app')
  })
})

describe('authentication', () => {
  it('answers 401 to every route without a valid session cookie', async () => {
    for (const c of [undefined, `webgrip_session=9999999999.forged`, 'webgrip_session=']) {
      const res = await fetch(base + '/connections', { headers: c ? { cookie: c } : {} })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Not authenticated' })
    }
    expect((await fetch(base + '/c/x/query', { method: 'POST' })).status).toBe(401)
  })

  it('logs in with the right password only, with a cookie restricted to the API', async () => {
    const bad = await login(base, 'wrong')
    expect(bad.status).toBe(401)
    expect(bad.headers.get('set-cookie')).toBeNull()
    const ok = await login(base, password)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('set-cookie')).toMatch(/^webgrip_session=\d+\.[\w-]+; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=2592000$/)
  })

  it('invalidates the sessions when the password changes', async () => {
    const other = await listen(createApp({ dataFile, secret, password: 'new', makeDriver: fakeDriver }))
    expect((await fetch(other.base + '/connections', { headers: { cookie } })).status).toBe(401)
    await new Promise((resolve) => other.server.close(resolve))
  })

  it('clears the cookie on logout', async () => {
    const res = await fetch(base + '/logout', { method: 'POST', headers: { cookie } })
    expect(res.headers.get('set-cookie')).toMatch(/^webgrip_session=; .*Max-Age=0$/)
  })
})
