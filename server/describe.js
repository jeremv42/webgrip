// Schema export for pasting into a chat: structure only, never data.

export function groupBy(rows, key) {
  const m = new Map()
  for (const r of rows) {
    const k = key(r)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return m
}

const KIND = { table: 'Table', view: 'Vue', matview: 'Vue matérialisée', foreign: 'Table étrangère' }
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

// d = { engine, version, database, schema?, schemas?, tables: [{ name, kind, rows, comment, columns, foreignKeys, indexes }] }
export function toMarkdown(d) {
  const lines = [`# ${d.database} — ${d.version}`, '', `- Moteur : ${d.engine}`, `- Base : \`${d.database}\``]
  if (d.schema) lines.push(`- Schéma : \`${d.schema}\``)
  if (d.schemas?.length) lines.push(`- Schémas de la base : ${d.schemas.map((s) => `\`${s}\``).join(', ')}`)
  lines.push('', 'Structure seule, sans données. Les nombres de lignes sont des estimations.')

  for (const t of d.tables) {
    lines.push('', `## ${KIND[t.kind] ?? t.kind} \`${t.name}\`${t.rows != null ? ` (≈ ${t.rows} lignes)` : ''}`)
    if (t.comment) lines.push('', t.comment)
    lines.push('', '| Colonne | Type | Nullable | Défaut | Clé |', '|---|---|---|---|---|')
    for (const c of t.columns) {
      lines.push(`| ${cell(c.name)} | ${cell(c.type)} | ${c.notnull ? 'NOT NULL' : 'NULL'} | ${cell(c.default)} | ${c.pk ? 'PK' : ''} |`)
    }
    if (t.foreignKeys.length) lines.push('', '**Clés étrangères**', ...t.foreignKeys.map((f) => `- ${f.name} : ${f.def}`))
    if (t.indexes.length) lines.push('', '**Index**', ...t.indexes.map((i) => `- ${i.name}${i.unique ? ' (unique)' : ''} : ${i.def}`))
  }
  return lines.join('\n') + '\n'
}
