// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import DOMPurify from 'dompurify'
import { applyEvent, attachText, renderMarkdown, toolLabel, type Conversation } from './chat.ts'

describe('applyEvent', () => {
  it('builds the answer from the stream', () => {
    const conv: Conversation = {
      messages: [
        { role: 'user', text: 'q' },
        { role: 'assistant', parts: [], done: false },
      ],
    }
    applyEvent(conv, { type: 'session', id: 's' })
    applyEvent(conv, { type: 'text', text: 'Let me ' })
    applyEvent(conv, { type: 'text', text: 'look.' })
    applyEvent(conv, { type: 'tool', id: 't', name: 'run_query', input: { sql: 'select 1' } })
    applyEvent(conv, { type: 'tool_result', id: 't', text: '1', error: false })
    applyEvent(conv, { type: 'text', text: 'Done' })
    applyEvent(conv, { type: 'done', error: 'late failure' })
    expect(conv.sessionId).toBe('s')
    expect(conv.messages[1]).toEqual({
      role: 'assistant',
      done: true,
      error: 'late failure',
      parts: [
        { kind: 'text', text: 'Let me look.' },
        { kind: 'tool', id: 't', name: 'run_query', input: { sql: 'select 1' }, result: '1', error: false },
        { kind: 'text', text: 'Done' },
      ],
    })
  })
})

describe('toolLabel', () => {
  it('names the call and where it looked', () => {
    expect(toolLabel({ kind: 'tool', id: '', name: 'describe_schema', input: { db: 'shop', schema: 'public' } })).toBe(
      'Structure of shop.public',
    )
    expect(toolLabel({ kind: 'tool', id: '', name: 'list_tables', input: {} })).toBe('Tables')
  })
})

describe('renderMarkdown', () => {
  // (happy-dom's parser is not faithful enough to check DOMPurify's output itself: check that it is used)
  it('adds Insert to SQL blocks only, and sanitizes', () => {
    const sanitize = vi.spyOn(DOMPurify, 'sanitize')
    const html = renderMarkdown('Hi <b>there</b>\n\n```sql\nselect 1 < 2\n```\n\n```json\n{}\n```')
    expect(sanitize).toHaveBeenCalledOnce()
    expect(html).toBe(sanitize.mock.results[0].value)
    const div = document.createElement('div')
    div.innerHTML = html
    const blocks = div.querySelectorAll('.chat-code')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].querySelector('[data-act=insert]')).not.toBeNull()
    expect(blocks[0].querySelector('code')!.textContent).toBe('select 1 < 2')
    expect(blocks[1].querySelector('[data-act=insert]')).toBeNull()
    expect(blocks[1].querySelector('[data-act=copy]')).not.toBeNull()
  })
})

describe('attachText', () => {
  const base = { sql: ' select * from t ', start: 0, end: 16, ms: 1 }
  it('writes the query and its rows as TSV, and tells when rows are left out', () => {
    expect(
      attachText({
        ...base,
        kind: 'rows',
        columns: [
          { name: 'id', type: 'int4' },
          { name: 'name', type: 'text' },
        ],
        rows: [
          [1, 'a'],
          [2, null],
        ],
        truncated: true,
      }),
    ).toBe('Result of:\n```sql\nselect * from t\n```\n2 rows (of more), tab-separated:\n```tsv\nid\tname\n1\ta\n2\t\n```')
  })
  it('caps the rows', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i])
    const text = attachText({ ...base, kind: 'rows', columns: [{ name: 'n', type: 'int4' }], rows, truncated: false })
    expect(text).toContain('200 rows (of 500)')
  })
  it('gives an error with its details', () => {
    expect(attachText({ ...base, kind: 'error', error: { message: 'boom', hint: 'try again' } })).toBe(
      'Error of:\n```sql\nselect * from t\n```\nboom\nHint: try again',
    )
  })
})
