import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { cap, describeForChat, readOnlyStatement, toEvents, toTsv } from './chat.ts'
import { toMarkdown } from './describe.ts'
import type { DescribedTable, SchemaDescription } from '../shared/types.ts'
import type { Driver } from './drivers/types.ts'
import type { ChatEvent } from '../shared/types.ts'

describe('readOnlyStatement', () => {
  it('accepts one read-only statement, leading comments included', () => {
    expect(readOnlyStatement('-- count\nselect count(*) from t;', 'postgres')).toBe('-- count\nselect count(*) from t')
    for (const sql of ['with x as (select 1) select * from x', 'explain select 1', 'show tables', 'describe t', 'values (1)'])
      expect(readOnlyStatement(sql, 'mariadb')).toBe(sql)
  })

  it('refuses writes, several statements and files written by MySQL', () => {
    expect(() => readOnlyStatement('delete from t', 'postgres')).toThrow(/read-only/)
    expect(() => readOnlyStatement('drop table t', 'mariadb')).toThrow(/read-only/)
    expect(() => readOnlyStatement('select 1; drop table t', 'postgres')).toThrow(/exactly one/)
    expect(() => readOnlyStatement('', 'postgres')).toThrow(/exactly one/)
    expect(() => readOnlyStatement("select * from t into outfile '/tmp/x'", 'mariadb')).toThrow(/OUTFILE/)
  })
})

describe('toTsv', () => {
  it('writes a header with types, escapes values and tells the row count', () => {
    const tsv = toTsv(
      [
        { name: 'id', type: 'int4' },
        { name: 'note', type: 'text' },
      ],
      [
        [1, 'a\tb\nc'],
        [2, null],
      ],
      true,
    )
    expect(tsv).toBe('id (int4)\tnote (text)\n1\ta\\tb\\nc\n2\tNULL\n(2 rows, more not shown)')
  })

  it('cuts long values', () => {
    const tsv = toTsv([{ name: 'v', type: 'text' }], [['x'.repeat(1000)]], false)
    expect(tsv.split('\n')[1]).toBe('x'.repeat(300) + '…')
  })
})

describe('describeForChat', () => {
  const col = (name: string, type = 'int4', pk = false) => ({ name, type, notnull: pk, default: null, pk })
  const table = (name: string, extra: Partial<DescribedTable> = {}): DescribedTable => ({
    name,
    kind: 'table',
    rows: 10,
    comment: null,
    columns: [col('id', 'int4', true), col('name', 'text')],
    foreignKeys: [],
    indexes: [],
    ...extra,
  })
  const orders = table('orders', {
    columns: [col('id', 'int4', true), col('customer_id'), col('a'), col('b')],
    foreignKeys: [
      { name: 'fk1', def: 'FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE' },
      { name: 'fk2', def: 'FOREIGN KEY (a, b) REFERENCES `pairs` (x, y)' },
    ],
  })
  const schema = (tables: DescribedTable[]): SchemaDescription => ({
    engine: 'PostgreSQL',
    version: '17',
    database: 'shop',
    schema: 'public',
    tables,
  })

  it('gives the full Markdown when it fits', () => {
    const d = schema([table('customers'), orders])
    expect(describeForChat(d)).toBe(toMarkdown(d))
  })

  it('falls back to an overview with keys, then to column names, then to table names', () => {
    const d = schema([table('customers'), orders])
    const overview = describeForChat(d, undefined, 400)
    expect(overview).toContain('2 tables and views, too many to describe at once')
    expect(overview).toContain('customers ≈10 rows: id int4 PK, name text')
    expect(overview).toContain('orders ≈10 rows: id int4 PK, customer_id int4 → customers(id), a int4, b int4 | (a, b) → `pairs`(x, y)')
    expect(describeForChat(d, undefined, 240)).toMatch(/\ncustomers: id, name\norders: id, customer_id, a, b$/)
    expect(describeForChat(d, undefined, 230)).toMatch(/\n\ncustomers, orders$/)
  })

  it('details only the tables asked for, case-insensitively', () => {
    const d = schema([table('customers'), orders])
    const text = describeForChat(d, ['ORDERS', 'nope'])
    expect(text).toContain('`orders`')
    expect(text).not.toContain('`customers`')
    expect(text).toMatch(/Not found: nope\n$/)
  })

  it('stays within budget on a very large schema', () => {
    const d = schema(Array.from({ length: 3000 }, (_, i) => table(`table_${i}_with_a_rather_long_name`)))
    const text = describeForChat(d)
    expect(text.length).toBeLessThan(40_200)
    expect(text).toMatch(/cut at 40000 characters/)
  })
})

describe('cap', () => {
  it('cuts and says so', () => {
    expect(cap('abc', '', 5)).toBe('abc')
    expect(cap('abcdef', 'Ask less.', 3)).toBe('abc\n… (cut at 3 characters. Ask less.)')
  })
})

describe('toEvents', () => {
  it('maps the CLI stream to chat events', () => {
    expect(toEvents({ type: 'system', subtype: 'init', session_id: 's1' })).toEqual([{ type: 'session', id: 's1' }])
    expect(toEvents({ type: 'system', subtype: 'status' })).toEqual([])
    expect(
      toEvents({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      }),
    ).toEqual([{ type: 'text', text: 'Hi' }])
    expect(
      toEvents({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '…' } } }),
    ).toEqual([])
    expect(
      toEvents({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hi' },
            { type: 'tool_use', id: 't1', name: 'mcp__webgrip__run_query', input: { sql: 'select 1' } },
          ],
        },
      }),
    ).toEqual([{ type: 'tool', id: 't1', name: 'run_query', input: { sql: 'select 1' } }])
    expect(
      toEvents({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'boom' }] }] },
      }),
    ).toEqual([{ type: 'tool_result', id: 't1', text: 'boom', error: true }])
    expect(toEvents({ type: 'result', is_error: false, result: 'ok' })).toEqual([{ type: 'done' }])
    expect(toEvents({ type: 'result', is_error: true, result: 'Not logged in' })).toEqual([{ type: 'done', error: 'Not logged in' }])
  })
})

// ---- the route, with a fake `claude` that calls the MCP tools like the real one ----

const FAKE_CLAUDE = `
const fs = require('node:fs')
const args = process.argv.slice(2)
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let prompt = ''
process.stdin.on('data', (b) => (prompt += b))
process.stdin.on('end', async () => {
  if (prompt.includes('FAIL')) {
    process.stderr.write('Not logged in')
    process.exit(1)
  }
  const server = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8')).mcpServers.webgrip
  let n = 0
  const rpc = async (method, params) => {
    const res = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) })
    return (await res.json()).result
  }
  await rpc('initialize', { protocolVersion: '2025-06-18' })
  const tools = (await rpc('tools/list')).tools.map((t) => t.name)
  out({ type: 'system', subtype: 'init', session_id: opt('--resume') || '11111111-2222-3333-4444-555555555555' })
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify({ prompt, tools, model: opt('--model') }) } } })
  for (const sql of ['select 1', 'delete from t']) {
    const r = await rpc('tools/call', { name: 'run_query', arguments: { sql } })
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: sql, is_error: !!r.isError, content: r.content }] } })
  }
  out({ type: 'result', is_error: false, result: 'ok' })
})
`

let dir: string | undefined
let server: Server | undefined

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve))
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  server = dir = undefined
})

async function start(chat: boolean, runQuery = true) {
  const tmp = (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webgrip-chat-')))
  const script = path.join(tmp, 'claude.cjs')
  fs.writeFileSync(script, FAKE_CLAUDE)
  const bin = path.join(tmp, 'claude')
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  const explore = vi.fn(async (_db: string | undefined, _schema: string | undefined, sql: string, _maxRows: number) => ({
    kind: 'rows' as const,
    columns: [{ name: 'x', type: 'int4' }],
    rows: [[sql]],
    truncated: false,
  }))
  const app = createApp({
    dataFile: path.join(tmp, 'data', 'connections.json'),
    secret: 'test-secret-0123456789',
    password: 'pw',
    makeDriver: () => ({ hasSchemas: true, explore, close: async () => {} }) as unknown as Driver,
    chat: chat ? { bin, model: 'haiku', runQuery } : undefined,
  })
  const s = (server = app.listen(0, '127.0.0.1'))
  await new Promise((resolve) => s.once('listening', resolve))
  const root = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  const login = await fetch(root + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw' }),
  })
  const headers = { 'content-type': 'application/json', cookie: login.headers.get('set-cookie')!.split(';')[0] }
  const conn = (await (
    await fetch(root + '/api/connections', { method: 'POST', headers, body: JSON.stringify({ name: 'demo' }) })
  ).json()) as { id: string }
  const post = (url: string, body: unknown) => fetch(root + url, { method: 'POST', headers, body: JSON.stringify(body) })
  return { root, headers, conn, post, explore, dir: tmp }
}

const events = async (res: Response) =>
  (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ChatEvent)

describe('chat route', () => {
  it('is off unless enabled', async () => {
    const { root, headers, conn, post } = await start(false)
    expect(await (await fetch(root + '/api/features', { headers })).json()).toEqual({ chat: false, chatRunQuery: false })
    expect((await post(`/api/c/${conn.id}/chat`, { message: 'hi' })).status).toBe(404)
    expect((await fetch(root + '/mcp', { method: 'POST' })).status).toBe(404)
  })

  it('streams the answer, with the read-only tools of the connection', async () => {
    const { root, headers, conn, post, explore, dir: tmp } = await start(true)
    expect(await (await fetch(root + '/api/features', { headers })).json()).toEqual({ chat: true, chatRunQuery: true })
    const res = await post(`/api/c/${conn.id}/chat`, { message: 'How many?', db: 'shop', schema: 'sales' })
    expect(res.headers.get('content-type')).toMatch(/ndjson/)
    const ev = await events(res)
    expect(ev[0]).toEqual({ type: 'session', id: '11111111-2222-3333-4444-555555555555' })
    const text = JSON.parse((ev[1] as { text: string }).text)
    expect(text).toEqual({
      prompt: '[WebGrip] connection "demo" (PostgreSQL), database shop, schema sales\n\nHow many?',
      tools: ['list_databases', 'list_tables', 'describe_schema', 'run_query'],
      model: 'haiku',
    })
    expect(ev[2]).toEqual({ type: 'tool_result', id: 'select 1', error: false, text: 'x (int4)\nselect 1\n(1 row)' })
    expect(ev[3]).toMatchObject({ type: 'tool_result', id: 'delete from t', error: true })
    expect(ev[4]).toEqual({ type: 'done' })
    // only the read-only statement reached the driver, with the UI's database and schema
    expect(explore).toHaveBeenCalledTimes(1)
    expect(explore).toHaveBeenCalledWith('shop', 'sales', 'select 1', 100)
    // the token died with the process, and its config file is gone
    expect((await fetch(root + '/mcp', { method: 'POST', headers: { authorization: 'Bearer x' } })).status).toBe(401)
    expect(fs.readdirSync(path.join(tmp, 'data', 'chat'))).toEqual([])
  })

  it('without WEBGRIP_CHAT_RUN_QUERY, gives Claude no way to read rows', async () => {
    const { root, headers, conn, post, explore } = await start(true, false)
    expect(await (await fetch(root + '/api/features', { headers })).json()).toEqual({ chat: true, chatRunQuery: false })
    const ev = await events(await post(`/api/c/${conn.id}/chat`, { message: 'How many?' }))
    expect(JSON.parse((ev[1] as { text: string }).text).tools).toEqual(['list_databases', 'list_tables', 'describe_schema'])
    // even called anyway, the tool is refused
    expect(ev[2]).toMatchObject({ type: 'tool_result', error: true, text: expect.stringMatching(/disabled/) })
    expect(explore).not.toHaveBeenCalled()
  })

  it('continues a conversation and reports a CLI failure', async () => {
    const { conn, post } = await start(true)
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect((await events(await post(`/api/c/${conn.id}/chat`, { message: 'again', sessionId: id })))[0]).toEqual({ type: 'session', id })
    expect(await events(await post(`/api/c/${conn.id}/chat`, { message: 'FAIL' }))).toEqual([{ type: 'done', error: 'Not logged in' }])
  })

  it('validates the request', async () => {
    const { post, conn } = await start(true)
    expect((await post(`/api/c/${conn.id}/chat`, { message: ' ' })).status).toBe(400)
    expect((await post(`/api/c/${conn.id}/chat`, { message: 'hi', sessionId: '--help' })).status).toBe(400)
    expect((await post('/api/c/nope/chat', { message: 'hi' })).status).toBe(404)
  })
})
