import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PostgresDriver } from './drivers/postgres.js'
import { MariadbDriver } from './drivers/mariadb.js'
import { splitSql } from '../shared/splitSql.js'
import { toMarkdown } from './describe.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataFile = process.env.WEBGRIP_DATA || path.join(root, 'data', 'connections.json')
const PORT = Number(process.env.PORT || 3070)

// ---- saved connections (plain JSON file, passwords included: keep this tool local) ----
const load = () => { try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')) } catch { return [] } }
const save = (list) => {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true })
  fs.writeFileSync(dataFile, JSON.stringify(list, null, 2), { mode: 0o600 })
}
let connections = load()
const publicConn = ({ password, ...c }) => ({ ...c, hasPassword: !!password })

// ---- live drivers, one per saved connection ----
const drivers = new Map()
const makeDriver = (cfg) => (cfg.type === 'mariadb' ? new MariadbDriver(cfg) : new PostgresDriver(cfg))
function driver(id) {
  let d = drivers.get(id)
  if (!d) {
    const cfg = connections.find((c) => c.id === id)
    if (!cfg) throw Object.assign(new Error('Unknown connection'), { status: 404 })
    d = makeDriver(cfg)
    drivers.set(id, d)
  }
  return d
}
async function dropDriver(id) {
  const d = drivers.get(id)
  drivers.delete(id)
  await d?.close()
}

const app = express()
app.use(express.json({ limit: '20mb' }))

const h = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res))
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || String(e) })
  }
}

app.get('/api/connections', h(() => connections.map(publicConn)))

app.post('/api/connections', h(async (req) => {
  const body = req.body
  const prev = connections.find((c) => c.id === body.id)
  const cfg = {
    id: prev?.id || crypto.randomUUID(),
    name: body.name || `${body.user}@${body.host}`,
    type: body.type === 'mariadb' ? 'mariadb' : 'postgres',
    host: body.host || 'localhost',
    port: Number(body.port) || undefined,
    user: body.user,
    // empty password on edit = keep the stored one
    password: body.password || (body.keepPassword ? prev?.password : '') || '',
    database: body.database || '',
    ssl: !!body.ssl,
  }
  connections = prev ? connections.map((c) => (c.id === cfg.id ? cfg : c)) : [...connections, cfg]
  save(connections)
  await dropDriver(cfg.id)
  return publicConn(cfg)
}))

app.delete('/api/connections/:id', h(async (req) => {
  await dropDriver(req.params.id)
  connections = connections.filter((c) => c.id !== req.params.id)
  save(connections)
  return { ok: true }
}))

app.post('/api/connections/test', h(async (req) => {
  const prev = connections.find((c) => c.id === req.body.id)
  const cfg = { ...req.body, password: req.body.password || (req.body.keepPassword ? prev?.password : '') }
  const d = makeDriver(cfg)
  try { return { version: await d.test() } } finally { await d.close() }
}))

app.get('/api/c/:id/info', h(async (req) => {
  const d = driver(req.params.id)
  return { hasSchemas: d.hasSchemas, databases: await d.databases() }
}))
app.get('/api/c/:id/schemas', h((req) => driver(req.params.id).schemas(req.query.db)))
app.get('/api/c/:id/tables', h((req) => driver(req.params.id).tables(req.query.db, req.query.schema)))
app.get('/api/c/:id/columns', h((req) => driver(req.params.id).columns(req.query.db, req.query.schema, req.query.table)))
app.get('/api/c/:id/completion', h((req) => driver(req.params.id).completion(req.query.db, req.query.schema)))
app.get('/api/c/:id/describe', h(async (req) => ({ markdown: toMarkdown(await driver(req.params.id).describe(req.query.db, req.query.schema)) })))

app.post('/api/c/:id/query', h(async (req) => {
  const d = driver(req.params.id)
  const { db, schema, sql } = req.body
  const maxRows = Math.min(Math.max(Number(req.body.maxRows) || 500, 1), 100000)
  const statements = splitSql(sql || '', d.hasSchemas ? 'postgres' : 'mariadb')
  if (!statements.length) return { results: [] }
  return { results: await d.run(db, schema, statements, maxRows) }
}))

app.post('/api/c/:id/cancel', h(async (req) => ({ cancelled: await driver(req.params.id).cancel(req.body.db) })))

// API only, never exposed: the browser reaches it through the Vite proxy (/api).
app.listen(PORT, '127.0.0.1', () => console.log(`webgrip API on http://127.0.0.1:${PORT}`))
