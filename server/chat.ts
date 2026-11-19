// Chat with Claude, through the Claude Code CLI installed on the server (`claude -p`, the account it is logged in with).
// Claude gets no built-in tool (no shell, no files): only the read-only database tools below, served over MCP by this
// API on /mcp to the CLI process, behind a token valid while that process runs.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Request, Response } from 'express'
import type { Driver } from './drivers/types.ts'
import { toMarkdown } from './describe.ts'
import { splitSql } from '../shared/splitSql.ts'
import { stripLeadingComments } from '../shared/pageable.ts'
import type { Cell, ChatEvent, ChatRequest, ConnectionConfig, DescribedTable, ResultColumn, SchemaDescription } from '../shared/types.ts'

export interface ChatOptions {
  // the Claude Code executable
  bin: string
  // --model (alias or full name), else the CLI's default
  model?: string
  // whether Claude may run read-only queries itself (WEBGRIP_CHAT_RUN_QUERY). Off: it only sees the structure, never
  // a row; the user runs the queries and decides what to send it.
  runQuery?: boolean
}

// What the tools of one chat run work on: the connection, and the database / schema selected in the UI
interface Scope {
  connId: string
  db?: string
  schema?: string
}

const SERVER = 'webgrip'
const DEFAULT_ROWS = 100
const MAX_ROWS = 1000
const MAX_CELL = 300 // characters kept per value
// Characters of a tool result (≈ 4 per token): well under Claude Code's limit on an MCP result (25,000 tokens by
// default), above which the CLI saves the result to a file this Claude cannot read (it has no file tool).
const MAX_TEXT = 40_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const QUERY_RULE = {
  on: `- Your tools only reach that connection: list_databases, list_tables, describe_schema, run_query. Look at the real structure before writing a query that depends on it rather than guessing names. run_query is read-only (one statement, read-only transaction rolled back, 30 s limit, rows capped): use it to check a query, look at sample values or answer a question about the data. Keep result sets small (LIMIT, aggregates).`,
  off: `- Your tools only reach that connection's structure: list_databases, list_tables, describe_schema. Look at the real structure before writing a query rather than guessing names. You cannot read any data (this is deliberate: the data may be private). When you need some, write the query and ask the user to run it; they may attach its result to their next message, or describe it. Never ask for more data than the question needs.`,
}

const systemPrompt = (
  runQuery: boolean,
) => `You are the assistant built into WebGrip, a web SQL client for PostgreSQL and MySQL/MariaDB. The user looks at a database through it and asks you about its structure and data, or for SQL.

- Each user message starts with a [WebGrip] line: the connection, its engine, and the database (and schema) selected in WebGrip. Write SQL for that engine; unqualified names resolve in that database / schema.
${runQuery ? QUERY_RULE.on : QUERY_RULE.off}
- Never try to change data or structure. When the user wants a change (INSERT, UPDATE, DELETE, DDL…), write the SQL in your answer: they will review it and run it themselves.
- Put SQL meant for the user in \`\`\`sql fenced blocks: WebGrip shows an Insert button on them that appends the SQL to the editor.
- Answer in the user's language, concisely. Your answer is rendered as Markdown (tables included).`

const TOOLS = [
  {
    name: 'list_databases',
    description: 'Databases of the connection; for PostgreSQL, also the schemas of one database (the selected one by default).',
    inputSchema: { type: 'object', properties: { db: { type: 'string', description: 'Database whose schemas to list (PostgreSQL)' } } },
  },
  {
    name: 'list_tables',
    description: 'Tables and views of a schema (PostgreSQL) or database (MySQL/MariaDB). Defaults: the selected database / schema.',
    inputSchema: { type: 'object', properties: { db: { type: 'string' }, schema: { type: 'string', description: 'PostgreSQL only' } } },
  },
  {
    name: 'describe_schema',
    description:
      'Structure of a schema (PostgreSQL) or database (MySQL/MariaDB) as Markdown: tables and views, columns with types, ' +
      'nullability, defaults, primary keys, foreign keys, indexes, estimated row counts. No data. Defaults: the selected database / schema. ' +
      'A large schema comes back as a compact overview (columns, primary and foreign keys): then pass "tables" to get the full ' +
      'detail of the tables you need.',
    inputSchema: {
      type: 'object',
      properties: {
        db: { type: 'string' },
        schema: { type: 'string', description: 'PostgreSQL only' },
        tables: { type: 'array', items: { type: 'string' }, description: 'Only these tables / views, in full detail' },
      },
    },
  },
  {
    name: 'run_query',
    description:
      'Runs ONE read-only statement (SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN, DESCRIBE) in a read-only transaction rolled back ' +
      'afterwards, with a 30 s time limit, and returns the rows as TSV (NULL for nulls, long values cut). Anything that writes is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        db: { type: 'string', description: 'Default: the selected database' },
        schema: { type: 'string', description: 'PostgreSQL only; default: the selected schema' },
        max_rows: { type: 'number', description: `Rows returned at most (default ${DEFAULT_ROWS}, max ${MAX_ROWS})` },
      },
      required: ['sql'],
    },
  },
]

const READ_STATEMENT = /^(select|with|values|table|show|explain|describe|desc)\b/i

// The single read-only statement of `sql`, or an error. The read-only transaction is the real guard; this also refuses
// what it does not cover: DDL (MySQL commits the transaction before it), several statements, files written by MySQL.
export function readOnlyStatement(sql: string, dialect: 'postgres' | 'mariadb') {
  const statements = splitSql(sql, dialect)
  if (statements.length !== 1) throw new Error('Send exactly one statement')
  const s = stripLeadingComments(statements[0].sql)
  if (!READ_STATEMENT.test(s))
    throw new Error('Only read-only statements are allowed (SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN, DESCRIBE)')
  if (/\binto\s+(outfile|dumpfile)\b/i.test(s)) throw new Error('INTO OUTFILE / DUMPFILE is not allowed')
  return statements[0].sql
}

const tsvCell = (v: Cell) => {
  if (v === null) return 'NULL'
  const s = String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n')
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + '…' : s
}

// Rows as TSV for Claude, cut at MAX_TEXT characters
export function toTsv(columns: ResultColumn[], rows: Cell[][], truncated: boolean) {
  const lines = [columns.map((c) => `${c.name} (${c.type})`).join('\t')]
  let size = lines[0].length
  let shown = 0
  for (const r of rows) {
    const line = r.map(tsvCell).join('\t')
    if (size + line.length > MAX_TEXT) break
    lines.push(line)
    size += line.length + 1
    shown++
  }
  const more = truncated || shown < rows.length
  lines.push(`(${shown} row${shown === 1 ? '' : 's'}${more ? ', more not shown' : ''})`)
  return lines.join('\n')
}

// Text cut to the budget, saying so
export function cap(text: string, hint = '', budget = MAX_TEXT) {
  return text.length <= budget ? text : `${text.slice(0, budget)}\n… (cut at ${budget} characters${hint ? '. ' + hint : ''})`
}

const FOREIGN_KEY = /^FOREIGN KEY \(([^)]*)\) REFERENCES (.+?)\s*\(([^)]*)\)/i

// One line per table: columns with type, PK, and → for a single-column foreign key (the others at the end)
function overviewLine(t: DescribedTable) {
  const refs = new Map<string, string>()
  const multi: string[] = []
  for (const fk of t.foreignKeys) {
    const m = FOREIGN_KEY.exec(fk.def)
    if (!m) continue
    const target = `${m[2]}(${m[3]})`
    if (m[1].includes(',')) multi.push(`(${m[1]}) → ${target}`)
    else refs.set(m[1].trim().replace(/^"(.*)"$/, '$1'), target)
  }
  const cols = t.columns.map((c) => `${c.name} ${c.type}${c.pk ? ' PK' : ''}${refs.has(c.name) ? ' → ' + refs.get(c.name) : ''}`)
  const kind = t.kind === 'table' ? '' : ` [${t.kind}]`
  const rows = t.rows != null ? ` ≈${t.rows} rows` : ''
  return `${t.name}${kind}${rows}: ${cols.join(', ')}${multi.length ? ' | ' + multi.join(', ') : ''}`
}

// The structure for Claude, within budget: the full Markdown when it fits (or for the tables asked), else an overview
// as detailed as fits (columns with types and keys, then column names, then table names).
export function describeForChat(d: SchemaDescription, tables?: string[], budget = MAX_TEXT) {
  if (tables?.length) {
    const wanted = new Set(tables.map((n) => n.toLowerCase()))
    const found = d.tables.filter((t) => wanted.has(t.name.toLowerCase()))
    const missing = tables.filter((n) => !found.some((t) => t.name.toLowerCase() === n.toLowerCase()))
    const text = toMarkdown({ ...d, tables: found }) + (missing.length ? `\nNot found: ${missing.join(', ')}\n` : '')
    return cap(text, 'Ask for fewer tables at a time.', budget)
  }
  const full = toMarkdown(d)
  if (full.length <= budget) return full
  const head =
    `${d.engine} ${d.version}, database ${d.database}${d.schema ? `, schema ${d.schema}` : ''}: ${d.tables.length} tables and views, ` +
    `too many to describe at once. Overview below; call describe_schema with "tables" for the full detail of the ones you need.\n\n`
  const levels = [(t: DescribedTable) => overviewLine(t), (t: DescribedTable) => `${t.name}: ${t.columns.map((c) => c.name).join(', ')}`]
  for (const line of levels) {
    const text = head + d.tables.map(line).join('\n')
    if (text.length <= budget) return text
  }
  return cap(head + d.tables.map((t) => t.name).join(', '), 'Use list_tables, or ask for specific tables.', budget)
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)

// A database error, with what PostgreSQL adds to it
function errorText(e: unknown) {
  const err = e as { message?: string; detail?: string; hint?: string }
  return [err.message || String(e), err.detail && `Detail: ${err.detail}`, err.hint && `Hint: ${err.hint}`].filter(Boolean).join('\n')
}

async function callTool(d: Driver, scope: Scope, name: string, args: Record<string, unknown>, runQuery: boolean) {
  const db = str(args.db) ?? scope.db
  const schema = str(args.schema) ?? (str(args.db) && str(args.db) !== scope.db ? undefined : scope.schema)
  switch (name) {
    case 'list_databases': {
      const lines = ['Databases:', ...(await d.databases()).map((n) => `- ${n}`)]
      if (d.hasSchemas) lines.push('', `Schemas of ${db ?? 'the default database'}:`, ...(await d.schemas(db)).map((n) => `- ${n}`))
      return lines.join('\n')
    }
    case 'list_tables': {
      const tables = await d.tables(db, d.hasSchemas ? (schema ?? 'public') : undefined)
      return tables.length ? tables.map((t) => `${t.name} (${t.type})`).join('\n') : 'No table'
    }
    case 'describe_schema': {
      const tables = Array.isArray(args.tables) ? args.tables.filter((t): t is string => typeof t === 'string' && t !== '') : undefined
      return describeForChat(await d.describe(db, d.hasSchemas ? (schema ?? 'public') : undefined), tables)
    }
    case 'run_query': {
      if (!runQuery) throw new Error('Running queries is disabled: ask the user to run it')
      const sql = readOnlyStatement(String(args.sql ?? ''), d.hasSchemas ? 'postgres' : 'mariadb')
      const maxRows = Math.min(Math.max(Math.floor(Number(args.max_rows) || DEFAULT_ROWS), 1), MAX_ROWS)
      const r = await d.explore(db, schema, sql, maxRows)
      return r.kind === 'rows' ? toTsv(r.columns, r.rows, r.truncated) : `${r.command} (no rows)`
    }
    default:
      throw new Error(`Unknown tool ${name}`)
  }
}

interface JsonRpc {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> }
}

const stripPrefix = (name: string) => name.replace(`mcp__${SERVER}__`, '')

// One CLI message (stream-json) → what the browser needs from it
export function toEvents(msg: any): ChatEvent[] {
  switch (msg?.type) {
    case 'system':
      return msg.subtype === 'init' && msg.session_id ? [{ type: 'session', id: msg.session_id }] : []
    case 'stream_event': {
      const e = msg.event
      if (msg.parent_tool_use_id) return []
      return e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' ? [{ type: 'text', text: e.delta.text }] : []
    }
    case 'assistant':
      return (msg.message?.content ?? [])
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => ({ type: 'tool', id: b.id, name: stripPrefix(b.name), input: b.input ?? {} }))
    case 'user': {
      const content = msg.message?.content
      if (!Array.isArray(content)) return []
      return content
        .filter((b: any) => b.type === 'tool_result')
        .map((b: any) => ({
          type: 'tool_result',
          id: b.tool_use_id,
          error: !!b.is_error,
          text: (typeof b.content === 'string' ? b.content : (b.content ?? []).map((c: any) => c.text ?? '').join('\n')).slice(0, 4000),
        }))
    }
    case 'result':
      return [{ type: 'done', ...(msg.is_error && { error: String(msg.result || msg.subtype || 'Claude failed') }) }]
    default:
      return []
  }
}

export function createChat(
  { bin, model, runQuery = false }: ChatOptions,
  { dir, driver, connection }: { dir: string; driver: (id: string) => Driver; connection: (id: string) => ConnectionConfig },
) {
  const scopes = new Map<string, Scope>() // token -> scope, while its CLI process runs
  const tools = runQuery ? TOOLS : TOOLS.filter((t) => t.name !== 'run_query')
  const system = systemPrompt(runQuery)

  // MCP over HTTP (JSON answers, no SSE stream), for the CLI processes started below only
  async function mcp(req: Request, res: Response) {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1]
    const scope = token ? scopes.get(token) : undefined
    if (!scope) return void res.status(401).json({ error: 'Invalid token' })
    if (req.method !== 'POST') return void res.status(405).set('Allow', 'POST').end()
    const batch = Array.isArray(req.body)
    const replies = []
    for (const m of (batch ? req.body : [req.body]) as JsonRpc[]) {
      if (m?.id === undefined || m.id === null) continue // notification
      replies.push({ jsonrpc: '2.0', id: m.id, ...(await answer(scope, m)) })
    }
    if (!replies.length) return void res.status(202).end()
    res.json(batch ? replies : replies[0])
  }

  async function answer(scope: Scope, m: JsonRpc) {
    switch (m.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: m.params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: SERVER, version: '1.0.0' },
          },
        }
      case 'ping':
        return { result: {} }
      case 'tools/list':
        return { result: { tools } }
      case 'tools/call':
        try {
          const text = await callTool(driver(scope.connId), scope, m.params?.name ?? '', m.params?.arguments ?? {}, runQuery)
          return { result: { content: [{ type: 'text', text: cap(text) }] } }
        } catch (e) {
          return { result: { content: [{ type: 'text', text: errorText(e) }], isError: true } }
        }
      default:
        return { error: { code: -32601, message: `Method not found: ${m.method}` } }
    }
  }

  // POST /api/c/:id/chat: one user message → NDJSON stream of ChatEvent until Claude's answer is complete.
  // Closing the request (Stop button) kills the CLI process.
  async function chat(req: Request, res: Response) {
    const connId = String(req.params.id)
    const body = req.body as Partial<ChatRequest>
    let cfg: ConnectionConfig
    try {
      cfg = connection(connId)
    } catch (e) {
      return void res.status(404).json({ error: (e as Error).message })
    }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message) return void res.status(400).json({ error: 'Empty message' })
    if (body.sessionId !== undefined && !(typeof body.sessionId === 'string' && UUID.test(body.sessionId)))
      return void res.status(400).json({ error: 'Invalid session id' })

    const scope: Scope = { connId, db: str(body.db), schema: str(body.schema) }
    const token = crypto.randomBytes(24).toString('base64url')
    scopes.set(token, scope)
    // the token goes in a private file rather than on the command line (visible to every local user)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const mcpFile = path.join(dir, `mcp-${crypto.randomUUID()}.json`)
    const url = `http://127.0.0.1:${req.socket.localPort}/mcp`
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }),
      {
        mode: 0o600,
      },
    )

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      mcpFile,
      '--allowedTools',
      tools.map((t) => `mcp__${SERVER}__${t.name}`).join(','),
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--system-prompt',
      system,
    ]
    if (model) args.push('--model', model)
    if (body.sessionId) args.push('--resume', body.sessionId)

    const engine = cfg.type === 'mariadb' ? 'MySQL/MariaDB' : 'PostgreSQL'
    const where = [scope.db && `database ${scope.db}`, cfg.type !== 'mariadb' && scope.schema && `schema ${scope.schema}`].filter(Boolean)
    const prompt = `[WebGrip] connection "${cfg.name}" (${engine})${where.length ? ', ' + where.join(', ') : ''}\n\n${message}`

    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
    res.flushHeaders()
    let ended = false
    let done = false
    const send = (e: ChatEvent) => {
      if (ended) return
      if (e.type === 'done') done = true
      res.write(JSON.stringify(e) + '\n')
    }

    const child = spawn(bin, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-4000)
    })
    child.stdin.on('error', () => {}) // the process may die before reading its prompt
    child.stdin.end(prompt)
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      for (const e of toEvents(msg)) send(e)
    })

    const finish = (error?: string) => {
      scopes.delete(token)
      fs.rm(mcpFile, { force: true }, () => {})
      if (!done) send({ type: 'done', error: error || stderr.trim() || 'Claude stopped without answering' })
      if (!ended) {
        ended = true
        res.end()
      }
    }
    child.on('error', (e) => finish(`Cannot start ${bin}: ${e.message}`))
    child.on('close', () => finish())
    res.on('close', () => {
      ended = true
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    })
  }

  return { mcp, chat }
}
