// Chat with Claude: the conversation model, built from the API's events, and the Markdown rendering of answers.
import { Marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import type { ChatEvent, StatementResult } from '../../shared/types.ts'
import { toTsv } from './grid.ts'

export type ChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; result?: string; error?: boolean }

export type ChatMessage = { role: 'user'; text: string } | { role: 'assistant'; parts: ChatPart[]; done: boolean; error?: string }

export interface Conversation {
  sessionId?: string
  messages: ChatMessage[]
}

// Kept in localStorage per connection: the last messages are enough to read back the conversation
export const MAX_KEPT = 60

// Applies one event of the answer stream to the conversation (its last message is the assistant's answer).
export function applyEvent(conv: Conversation, e: ChatEvent) {
  const msg = conv.messages.at(-1)
  if (msg?.role !== 'assistant') return
  switch (e.type) {
    case 'session':
      conv.sessionId = e.id
      break
    case 'text': {
      const last = msg.parts.at(-1)
      if (last?.kind === 'text') last.text += e.text
      else msg.parts.push({ kind: 'text', text: e.text })
      break
    }
    case 'tool':
      msg.parts.push({ kind: 'tool', id: e.id, name: e.name, input: e.input })
      break
    case 'tool_result': {
      const tool = msg.parts.find((p) => p.kind === 'tool' && p.id === e.id)
      if (tool?.kind === 'tool') Object.assign(tool, { result: e.text, error: e.error })
      break
    }
    case 'done':
      msg.done = true
      if (e.error) msg.error = e.error
      break
  }
}

// One line describing a tool call
export function toolLabel(p: Extract<ChatPart, { kind: 'tool' }>) {
  const where = [p.input.db, p.input.schema].filter((v) => typeof v === 'string' && v).join('.')
  switch (p.name) {
    case 'run_query':
      return 'Query'
    case 'describe_schema':
      return `Structure${where ? ' of ' + where : ''}`
    case 'list_tables':
      return `Tables${where ? ' of ' + where : ''}`
    case 'list_databases':
      return 'Databases'
    default:
      return p.name
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// Code blocks get a bar with Copy, and Insert (into the editor) for SQL; the buttons are handled by delegation.
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const sql = !lang || /sql/i.test(lang)
      return (
        `<div class="chat-code"><div class="chat-code-bar"><span>${escapeHtml(lang || '')}</span>` +
        (sql ? `<button type="button" data-act="insert" title="Append to the editor">Insert</button>` : '') +
        `<button type="button" data-act="copy">Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>`
      )
    },
  },
})

const cache = new Map<string, string>()

// Markdown → sanitized HTML (cached: a streamed answer is rendered again on every chunk, the older ones are not)
export function renderMarkdown(text: string) {
  let html = cache.get(text)
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(text, { async: false }))
    if (cache.size > 300) cache.delete(cache.keys().next().value!)
    cache.set(text, html)
  }
  return html
}

export const ATTACH_ROWS = 200
const ATTACH_CHARS = 20_000

// A result as text for the user's message (they see and can edit it before sending): only what they choose to share
export function attachText(r: StatementResult) {
  const sql = '```sql\n' + r.sql.trim() + '\n```'
  switch (r.kind) {
    case 'rows': {
      let rows = r.rows.slice(0, ATTACH_ROWS)
      let tsv = toTsv(r.columns, rows)
      while (tsv.length > ATTACH_CHARS && rows.length > 1) {
        rows = rows.slice(0, Math.floor(rows.length / 2))
        tsv = toTsv(r.columns, rows)
      }
      const more = rows.length < r.rows.length || r.truncated
      const count = `${rows.length} row${rows.length === 1 ? '' : 's'}${more ? ` (of ${r.total ?? (r.truncated ? 'more' : r.rows.length)})` : ''}`
      return `Result of:\n${sql}\n${count}, tab-separated:\n\`\`\`tsv\n${tsv}\n\`\`\``
    }
    case 'error':
      return `Error of:\n${sql}\n${r.error.message}${r.error.detail ? '\nDetail: ' + r.error.detail : ''}${r.error.hint ? '\nHint: ' + r.error.hint : ''}`
    case 'command':
      return `Result of:\n${sql}\n${r.command}${r.affected != null ? `, ${r.affected} rows affected` : ''}`
    default:
      return `Not run:\n${sql}`
  }
}
