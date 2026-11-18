// Schema export for pasting into a chat: structure only, never data.
import type { SchemaDescription, TableKind } from '../shared/types.ts'

export function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const r of rows) {
    const k = key(r)
    const list = m.get(k)
    if (list) list.push(r)
    else m.set(k, [r])
  }
  return m
}

const KIND: Record<TableKind, string> = { table: 'Table', view: 'View', matview: 'Materialized view', foreign: 'Foreign table' }
const cell = (v: unknown) =>
  String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')

export function toMarkdown(d: SchemaDescription): string {
  const lines = [`# ${d.database} — ${d.version}`, '', `- Engine: ${d.engine}`, `- Database: \`${d.database}\``]
  if (d.schema) lines.push(`- Schema: \`${d.schema}\``)
  if (d.schemas?.length) lines.push(`- Schemas of the database: ${d.schemas.map((s) => `\`${s}\``).join(', ')}`)
  lines.push('', 'Structure only, no data. Row counts are estimates.')

  for (const t of d.tables) {
    lines.push('', `## ${KIND[t.kind] ?? t.kind} \`${t.name}\`${t.rows != null ? ` (≈ ${t.rows} rows)` : ''}`)
    if (t.comment) lines.push('', t.comment)
    lines.push('', '| Column | Type | Nullable | Default | Key |', '|---|---|---|---|---|')
    for (const c of t.columns) {
      lines.push(`| ${cell(c.name)} | ${cell(c.type)} | ${c.notnull ? 'NOT NULL' : 'NULL'} | ${cell(c.default)} | ${c.pk ? 'PK' : ''} |`)
    }
    if (t.foreignKeys.length) lines.push('', '**Foreign keys**', ...t.foreignKeys.map((f) => `- ${f.name}: ${f.def}`))
    if (t.indexes.length) lines.push('', '**Indexes**', ...t.indexes.map((i) => `- ${i.name}${i.unique ? ' (unique)' : ''}: ${i.def}`))
  }
  return lines.join('\n') + '\n'
}
