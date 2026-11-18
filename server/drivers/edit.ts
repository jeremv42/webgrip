// Cell editing, shared by the drivers: which table a result's rows can be updated in, and the UPDATEs that save changes.
import type { Cell, EditTarget, RowChange } from '../../shared/types.ts'

// Where a result column comes from: a table (any key unique to it, e.g. its oid) and the column's name there
export type ColumnSource = { table: string; column: string } | null

export interface SourceTable {
  schema: string
  name: string
  // primary key columns (empty: no primary key, so not editable)
  key: string[]
  // columns that cannot be written (generated, binary shown as hex…)
  readonly: Set<string>
}

// The rows are editable when exactly one of their tables has its whole primary key in the result, each column of
// that table shown once (a self-join shows them twice: ambiguous). Only that table's columns are then editable.
export function editTargetOf(sources: ColumnSource[], tables: Map<string, SourceTable>): EditTarget | undefined {
  const found: EditTarget[] = []
  for (const [id, t] of tables) {
    const names = sources.filter((s) => s?.table === id).map((s) => s!.column)
    if (!t.key.length || new Set(names).size !== names.length) continue
    if (!t.key.every((k) => names.includes(k) && !t.readonly.has(k))) continue
    found.push({
      schema: t.schema,
      table: t.name,
      columns: sources.map((s) => (s?.table === id && !t.readonly.has(s.column) ? s.column : null)),
      key: t.key,
    })
  }
  return found.length === 1 ? found[0] : undefined
}

// A parameterized UPDATE of one row; `param(i)` is the engine's placeholder for the i-th value (1-based).
export function updateOf(table: string, change: RowChange, ident: (s: string) => string, param: (i: number) => string) {
  const values: Cell[] = []
  const set = Object.entries(change.set).map(([c, v]) => `${ident(c)} = ${param(values.push(v))}`)
  const where = Object.entries(change.key).map(([c, v]) => (v == null ? `${ident(c)} IS NULL` : `${ident(c)} = ${param(values.push(v))}`))
  if (!set.length || !where.length) throw new Error('Nothing to update')
  return { sql: `UPDATE ${table} SET ${set.join(', ')} WHERE ${where.join(' AND ')}`, values }
}

// Each UPDATE must hit exactly one row, else the whole save is rolled back
export function checkUpdated(change: RowChange, count: number) {
  if (count === 1) return
  const key = Object.entries(change.key)
    .map(([c, v]) => `${c} = ${v}`)
    .join(', ')
  throw new Error(
    count === 0 ? `Row ${key} not found (deleted or key changed since it was read)` : `Row ${key} is not unique (${count} rows)`,
  )
}
