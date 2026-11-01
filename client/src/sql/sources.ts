// Pure helpers of the editor's autocompletion: identifiers, the schema index, and the tables (sources) a statement reads.
// Kept out of SqlEditor.vue (no Monaco here) so that they can be unit tested.
import { EntityContextType } from 'dt-sql-parser/dist/parser/common/types.js'
import type { CompletionInfo, CompletionTable, Statement } from '../../../shared/types.ts'

// An entity reported by the parser (dt-sql-parser's EntityContext) as it really is: UPDATE / DELETE tables belong to no statement.
export interface Entity {
  entityContextType: string
  text: string
  position: { startIndex: number; endIndex: number }
  belongStmt?: { isContainCaret?: boolean } | null
  isAccessible?: boolean | null
  relatedEntities?: Entity[] | null
  declareType?: number
  columns?: Entity[]
  _alias?: { text: string } | null
  _colType?: { text: string } | null
}

// A table a statement reads from: a known table, or a subquery / CTE with the columns of its SELECT list
export interface Source {
  alias: string | null
  name: string
  table: CompletionTable | null
  columns: { name: string; type: string; pk?: boolean }[]
}

export interface SchemaIndex {
  find(parts: string[]): CompletionTable | undefined
}

export const unquote = (s: string) =>
  s
    .replace(/^["`]|["`]$/g, '')
    .replace(/""/g, '"')
    .replace(/``/g, '`')
// an identifier, bare or quoted
export const IDENT = String.raw`(?:[\w$]+|"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`)`
export const insertColumns = new RegExp(String.raw`\binsert\s+into\s+(${IDENT}(?:\s*\.\s*${IDENT})?)\s*\(([^()]*)$`, 'i')
export const dottedName = new RegExp(String.raw`(?:^|[^\w$"\`.])(${IDENT}(?:\.${IDENT})*)\.[\w$]*$`)
// "a.b.c" -> ['a', 'b', 'c'], quotes removed
export const splitName = (s: string) => (s.match(/"(?:[^"]|"")*"|`(?:[^`]|``)*`|[^.\s]+/g) || []).map(unquote)

export function makeIndex(info: Partial<CompletionInfo>): SchemaIndex {
  const byName = new Map<string, CompletionTable[]>() // lower(name) -> tables of every schema
  for (const t of info.tables || []) {
    const k = t.name.toLowerCase()
    byName.set(k, [...(byName.get(k) || []), t])
  }
  // [schema.]name -> table; without a schema, the current one wins (search_path / current database)
  const find = (parts: string[]) => {
    const [schema, name] = parts.length > 1 ? parts.slice(-2).map((p) => p.toLowerCase()) : [null, parts[0]?.toLowerCase()]
    const found = byName.get(name) || []
    if (schema) return found.find((t) => t.schema.toLowerCase() === schema)
    return found.find((t) => t.schema === info.current) || found[0]
  }
  return { find }
}

export const isSource = (e: Entity) => e.entityContextType === EntityContextType.TABLE || e.entityContextType === EntityContextType.VIEW

// Columns of a SELECT list (queryResult entity): aliases, "*" and "t.*" expanded from the tables it reads.
function queryColumns(qr: Entity, index: SchemaIndex) {
  const out: Source['columns'] = []
  for (const c of qr.columns || []) {
    const parts = splitName(c.text)
    if (parts.at(-1) === '*') {
      const q = parts.length > 1 ? parts.at(-2)!.toLowerCase() : null
      for (const src of (qr.relatedEntities || []).filter(isSource)) {
        const s = sourceOf(src, index)
        if (!q || s.name.toLowerCase() === q) out.push(...s.columns)
      }
    } else {
      const name = c._alias?.text ? unquote(c._alias.text) : parts.at(-1)
      if (name && /^[\w$"`]/.test(name)) out.push({ name, type: c._colType?.text || '' })
    }
  }
  return out
}

// Words that can follow a table name but are not an alias
export const notAlias =
  /^(set|where|on|using|join|inner|left|right|full|cross|natural|order|group|limit|having|union|except|intersect|window|returning|values|select|default|for|lateral|offset|fetch|tablesample|partition|use|force|ignore|straight_join|as)$/i

// A FROM item: known table, or subquery (TableDeclareType.EXPRESSION = 1) whose columns come from its SELECT list.
// The parser misses some aliases (UPDATE t a SET ...): when it gives none, read the word after the table name.
export function sourceOf(e: Entity, index: SchemaIndex, code = ''): Source {
  let alias = e._alias?.text ? unquote(e._alias.text) : null
  if (!alias && e.declareType !== 1 && e.position) {
    const next = code.slice(e.position.endIndex + 1).match(/^\s+(?:as\s+)?([\w$]+|"(?:[^"]|"")+"|`(?:[^`]|``)+`)/i)?.[1]
    if (next && !notAlias.test(next)) alias = unquote(next)
  }
  if (e.declareType === 1) {
    const columns = (e.relatedEntities || [])
      .filter((r) => r.entityContextType === EntityContextType.QUERY_RESULT)
      .flatMap((r) => queryColumns(r, index))
    const cte = !e.text.trimStart().startsWith('(') ? unquote(e.text.trim()) : '' // WITH name AS (...)
    return { alias, name: alias || cte, table: null, columns }
  }
  const parts = splitName(e.text)
  const table = index.find(parts) ?? null
  return { alias, name: alias || parts.at(-1) || '', table, columns: table?.columns || [] }
}

const tableRefs = new RegExp(String.raw`\b(?:from|join|update|into)\s+(${IDENT}(?:\s*\.\s*${IDENT})?)(?:\s+(?:as\s+)?(${IDENT}))?`, 'gi')

// Fallback when the parser finds no table at all in the statement (e.g. MySQL UPDATE): FROM / JOIN / UPDATE / INTO t [AS] a
export function textSources(sql: string, index: SchemaIndex): Source[] {
  return [...sql.matchAll(tableRefs)].map(([, name, rawAlias]) => {
    const table = index.find(splitName(name)) ?? null
    const alias = rawAlias && !notAlias.test(rawAlias) ? unquote(rawAlias) : null
    return { alias, name: alias || splitName(name).at(-1) || '', table, columns: table?.columns || [] }
  })
}

// Tables visible from the caret. The parser ties UPDATE / DELETE tables to no statement:
// those are kept when they sit in the caret's statement (bounds from splitSql).
export function visibleSources(entities: Entity[] | null, index: SchemaIndex, stmt: Statement | undefined, code: string) {
  const visible = (e: Entity) =>
    e.belongStmt
      ? e.belongStmt.isContainCaret && e.isAccessible !== false
      : !!stmt && e.position.startIndex >= stmt.start && e.position.startIndex <= stmt.end
  return (entities || []).filter((e) => isSource(e) && visible(e)).map((e) => sourceOf(e, index, code))
}
