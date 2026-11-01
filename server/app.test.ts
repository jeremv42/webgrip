import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import type { Driver, DriverConfig } from './drivers/types.ts'
import type { PublicConnection, Statement } from '../shared/types.ts'

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
    run: vi.fn(async (_db: string | undefined, _schema: string | undefined, statements: Statement[], _maxRows: number) =>
      statements.map((st) => ({ ...st, kind: 'command' as const, command: 'OK', ms: 1 })),
    ),
    cancel: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  } satisfies Driver & { cfg: DriverConfig }
}

let dir: string
let dataFile: string
let server: Server
let base: string
let made: ReturnType<typeof fakeDriver>[]

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webgrip-'))
  dataFile = path.join(dir, 'data', 'connections.json')
  made = []
  const app = createApp({
    dataFile,
    makeDriver: (cfg) => {
      const d = fakeDriver(cfg)
      made.push(d)
      return d
    },
  })
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(dir, { recursive: true, force: true })
})

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
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
    // stored on disk, password included, readable by the owner only
    const stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    expect(stored[0].password).toBe('secret')
    expect(fs.statSync(dataFile).mode & 0o777).toBe(0o600)
  })

  it('keeps the stored password on edit only when asked to', async () => {
    const c = await saveConn({ name: 'db', user: 'bob', password: 'secret', type: 'mariadb' })
    await saveConn({ ...c, name: 'renamed', password: '', keepPassword: true })
    let stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: c.id, name: 'renamed', type: 'mariadb', password: 'secret' })

    await saveConn({ ...c, password: '', keepPassword: false })
    stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    expect(stored[0].password).toBe('')
  })

  it('reloads the saved connections at startup', async () => {
    const c = await saveConn({ user: 'bob', host: 'db' })
    const app = createApp({ dataFile, makeDriver: fakeDriver })
    const other = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => other.once('listening', resolve))
    const res = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/api/connections`)
    expect(await res.json()).toEqual([c])
    await new Promise((resolve) => other.close(resolve))
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
      makeDriver: (cfg) => ({ ...fakeDriver(cfg), test: async () => Promise.reject(new Error('connection refused')) }),
    })
    const other = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => other.once('listening', resolve))
    const res = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/api/connections/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'bob' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'connection refused' })
    await new Promise((resolve) => other.close(resolve))
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
    expect(made[0].run).toHaveBeenLastCalledWith('app', undefined, expect.any(Array), 100000)

    const my = await saveConn({ user: 'bob', type: 'mariadb' })
    await call('POST', `/c/${my.id}/query`, { sql: 'select `a;b`; select 2', maxRows: 0 })
    expect(made[1].run.mock.lastCall?.[2].map((s) => s.sql)).toEqual(['select `a;b`', 'select 2'])
    expect(made[1].run.mock.lastCall?.[3]).toBe(500) // 0 = default
  })

  it('does not call the driver for an empty script', async () => {
    const c = await saveConn({ user: 'bob' })
    expect((await call('POST', `/c/${c.id}/query`, { sql: ' -- nothing ; ' })).body).toEqual({ results: [] })
    expect(made[0].run).not.toHaveBeenCalled()
  })

  it('forwards cancel to the driver', async () => {
    const c = await saveConn({ user: 'bob' })
    expect((await call('POST', `/c/${c.id}/cancel`, { db: 'app' })).body).toEqual({ cancelled: true })
    expect(made[0].cancel).toHaveBeenCalledWith('app')
  })
})
