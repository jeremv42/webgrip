import type { Dialect, Statement } from './types.ts'

// Split a SQL script into statements, aware of quotes, comments and
// PostgreSQL dollar-quoting. Returns [{ sql, start, end }] (offsets into the input).
export function splitSql(text: string, dialect: Dialect = 'postgres'): Statement[] {
  const my = dialect === 'mariadb'
  const out: Statement[] = []
  let start = 0
  let i = 0
  const n = text.length

  const push = (end: number) => {
    const raw = text.slice(start, end)
    if (stripComments(raw, my).trim()) {
      const lead = raw.length - raw.trimStart().length
      out.push({ sql: raw.trim(), start: start + lead, end: start + raw.trimEnd().length })
    }
  }

  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '-' && d === '-') {
      i = skipLine(text, i)
    } else if (my && c === '#') {
      i = skipLine(text, i)
    } else if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2)
      i = e < 0 ? n : e + 2
    } else if (c === "'" || c === '"' || (my && c === '`')) {
      i = skipQuoted(text, i, c, my && c !== '`')
    } else if (!my && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64))
      if (m && !/[A-Za-z0-9_]/.test(text[i - 1] || '')) {
        const e = text.indexOf(m[0], i + m[0].length)
        i = e < 0 ? n : e + m[0].length
      } else i++
    } else if (c === ';') {
      push(i)
      start = ++i
    } else i++
  }
  push(n)
  return out
}

function skipLine(text: string, i: number) {
  const e = text.indexOf('\n', i)
  return e < 0 ? text.length : e + 1
}

function skipQuoted(text: string, i: number, q: string, backslash: boolean) {
  i++
  while (i < text.length) {
    const c = text[i]
    if (backslash && c === '\\') {
      i += 2
      continue
    }
    if (c === q) {
      if (text[i + 1] === q) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return i
}

function stripComments(s: string, my: boolean) {
  return s.replace(/\/\*[\s\S]*?(\*\/|$)/g, '').replace(my ? /(--|#)[^\n]*/g : /--[^\n]*/g, '')
}
