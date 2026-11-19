import express from 'express'
import type { Request, Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PostgresDriver } from './drivers/postgres/driver.ts'
import { MariadbDriver } from './drivers/mariadb/driver.ts'
import type { Driver, DriverConfig } from './drivers/types.ts'
import { splitSql } from '../shared/splitSql.ts'
import { isPageable } from '../shared/pageable.ts'
import { toMarkdown } from './describe.ts'
import { createAuth } from './auth.ts'
import { isSealed, seal, unseal } from './vault.ts'
import { createChat, type ChatOptions } from './chat.ts'
import type { ConnectionConfig, ConnectionForm, Features, PublicConnection, SaveRequest } from '../shared/types.ts'

export class HttpError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export const defaultDriver = (cfg: DriverConfig): Driver => (cfg.type === 'mariadb' ? new MariadbDriver(cfg) : new PostgresDriver(cfg))

export const publicConn = ({ password, ...c }: ConnectionConfig): PublicConnection => ({ ...c, hasPassword: !!password })

// Query string parameters are strings (or arrays / objects when repeated): keep only plain strings.
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)

// the stored password, unless the form brings a new one
const passwordOf = (body: ConnectionForm, prev?: ConnectionConfig) => body.password || (body.keepPassword ? prev?.password : '') || ''

// JSON route: the handler's value, or { error } (400 unless an HttpError says otherwise)
const h = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
  try {
    res.json(await fn(req, res))
  } catch (e) {
    res.status(e instanceof HttpError ? e.status : 400).json({ error: e instanceof Error ? e.message : String(e) })
  }
}

const connId = (req: Request) => String(req.params.id)

export interface AppOptions {
  // saved connections, passwords included, encrypted with `secret`
  dataFile: string
  // encryption key of dataFile, and key of the session cookies
  secret: string
  // the password asked at login
  password: string
  makeDriver?: (cfg: DriverConfig) => Driver
  // chat with Claude through the Claude Code CLI (WEBGRIP_CHAT); off when missing
  chat?: ChatOptions
  // desktop app (server/desktop.ts): `password` is a random token of this launch, given to the window by
  // GET /api/desktop-login, and the UI has no login or logout
  desktop?: boolean
}

export function createApp({ dataFile, secret, password, makeDriver = defaultDriver, chat, desktop = false }: AppOptions) {
  const save = (list: ConnectionConfig[]) => {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true })
    fs.writeFileSync(dataFile, seal(JSON.stringify(list), secret), { mode: 0o600 })
    fs.chmodSync(dataFile, 0o600) // the mode above only applies to a new file
  }
  // A missing file means no connection yet; an unreadable one stops the startup (rather than being overwritten).
  const load = (): ConnectionConfig[] => {
    let text: string
    try {
      text = fs.readFileSync(dataFile, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    const stored: unknown = JSON.parse(text)
    if (isSealed(stored)) return JSON.parse(unseal(stored, secret))
    // file written before encryption: encrypt it now
    const list = stored as ConnectionConfig[]
    save(list)
    return list
  }
  let connections = load()

  // ---- live drivers, one per saved connection ----
  const drivers = new Map<string, Driver>()
  function driver(id: string) {
    let d = drivers.get(id)
    if (!d) {
      d = makeDriver(connection(id))
      drivers.set(id, d)
    }
    return d
  }
  async function dropDriver(id: string) {
    const d = drivers.get(id)
    drivers.delete(id)
    await d?.close()
  }

  const connection = (id: string) => {
    const cfg = connections.find((c) => c.id === id)
    if (!cfg) throw new HttpError('Unknown connection', 404)
    return cfg
  }

  const app = express()
  app.use(express.json({ limit: '20mb' }))

  // Outside /api (never proxied to the browser): the chat's database tools, for the Claude Code process only (token).
  const claude = chat && createChat(chat, { dir: path.join(path.dirname(dataFile), 'chat'), driver, connection })
  if (claude) app.all('/mcp', claude.mcp)

  const auth = createAuth({ password, secret })
  app.post('/api/login', auth.login)
  app.post('/api/logout', auth.logout)
  if (desktop) app.get('/api/desktop-login', auth.tokenLogin)
  app.use('/api', auth.guard)

  app.get(
    '/api/features',
    h((): Features => ({ chat: !!claude, chatRunQuery: !!claude && !!chat?.runQuery, desktop })),
  )

  app.get(
    '/api/connections',
    h(() => connections.map(publicConn)),
  )

  app.post(
    '/api/connections',
    h(async (req) => {
      const body: ConnectionForm = req.body
      const prev = connections.find((c) => c.id === body.id)
      const cfg: ConnectionConfig = {
        id: prev?.id || crypto.randomUUID(),
        name: body.name || `${body.user || ''}@${body.host || 'localhost'}`,
        type: body.type === 'mariadb' ? 'mariadb' : 'postgres',
        host: body.host || 'localhost',
        port: Number(body.port) || undefined,
        user: body.user || '',
        password: passwordOf(body, prev),
        database: body.database || '',
        ssl: !!body.ssl,
      }
      connections = prev ? connections.map((c) => (c.id === cfg.id ? cfg : c)) : [...connections, cfg]
      save(connections)
      await dropDriver(cfg.id)
      return publicConn(cfg)
    }),
  )

  app.delete(
    '/api/connections/:id',
    h(async (req) => {
      const id = String(req.params.id)
      await dropDriver(id)
      connections = connections.filter((c) => c.id !== id)
      save(connections)
      return { ok: true }
    }),
  )

  app.post(
    '/api/connections/test',
    h(async (req) => {
      const body: ConnectionForm = req.body
      const prev = connections.find((c) => c.id === body.id)
      const d = makeDriver({
        type: body.type === 'mariadb' ? 'mariadb' : 'postgres',
        host: body.host || 'localhost',
        port: Number(body.port) || undefined,
        user: body.user,
        password: passwordOf(body, prev),
        database: body.database,
        ssl: !!body.ssl,
      })
      try {
        return { version: await d.test() }
      } finally {
        await d.close()
      }
    }),
  )

  app.get(
    '/api/c/:id/info',
    h(async (req) => {
      const d = driver(connId(req))
      return { hasSchemas: d.hasSchemas, databases: await d.databases() }
    }),
  )
  app.get(
    '/api/c/:id/schemas',
    h((req) => driver(connId(req)).schemas(str(req.query.db))),
  )
  app.get(
    '/api/c/:id/tables',
    h((req) => driver(connId(req)).tables(str(req.query.db), str(req.query.schema))),
  )
  app.get(
    '/api/c/:id/columns',
    h((req) => driver(connId(req)).columns(str(req.query.db), str(req.query.schema), str(req.query.table) ?? '')),
  )
  app.get(
    '/api/c/:id/completion',
    h((req) => driver(connId(req)).completion(str(req.query.db), str(req.query.schema))),
  )
  app.get(
    '/api/c/:id/describe',
    h(async (req) => ({
      markdown: toMarkdown(await driver(connId(req)).describe(str(req.query.db), str(req.query.schema))),
    })),
  )

  app.post(
    '/api/c/:id/query',
    h(async (req) => {
      const d = driver(connId(req))
      const { db, schema, sql, explain } = req.body as { db?: string; schema?: string; sql?: string; explain?: unknown }
      const mode = explain === 'plan' || explain === 'analyze' ? explain : undefined
      const maxRows = Math.min(Math.max(Number(req.body.maxRows) || 500, 1), 100000)
      const statements = splitSql(sql || '', d.hasSchemas ? 'postgres' : 'mariadb')
      if (!statements.length) return { results: [] }
      return { results: await d.run(db || undefined, schema || undefined, statements, maxRows, mode) }
    }),
  )

  app.post(
    '/api/c/:id/rows',
    h(async (req) => {
      const { db, schema, sql } = req.body as { db?: string; schema?: string; sql?: unknown }
      if (typeof sql !== 'string' || !isPageable(sql)) throw new Error('Only a read-only query can fetch more rows')
      const offset = Math.max(0, Math.floor(Number(req.body.offset) || 0))
      const count = Math.min(Math.max(Math.floor(Number(req.body.count) || 500), 1), 100000)
      return driver(connId(req)).page(db || undefined, schema || undefined, sql, offset, count)
    }),
  )

  app.post(
    '/api/c/:id/save',
    h(async (req) => {
      const { db, schema, target, changes } = req.body as Partial<SaveRequest>
      if (typeof target?.table !== 'string' || typeof target.schema !== 'string' || !Array.isArray(changes) || !changes.length)
        throw new Error('Invalid save request')
      for (const c of changes)
        if (!c || typeof c.key !== 'object' || typeof c.set !== 'object' || !c.key || !c.set) throw new Error('Invalid save request')
      const updated = await driver(connId(req)).save(db || undefined, schema || undefined, target, changes)
      return { updated }
    }),
  )

  app.post(
    '/api/c/:id/cancel',
    h(async (req) => ({ cancelled: await driver(connId(req)).cancel(req.body.db || undefined) })),
  )

  if (claude) app.post('/api/c/:id/chat', claude.chat)

  return app
}
