// Result grid helpers: number detection, sorting and TSV export.
import type { Cell, ResultColumn } from '../../shared/types.ts'

// Numbers arrive as text (PostgreSQL, big MySQL numbers): right-align and sort them as numbers.
export const isNum = (v: Cell) => typeof v === 'number' || (typeof v === 'string' && v !== '' && v.length < 40 && !isNaN(Number(v)))

// NULL always last, numbers by value, anything else as text; dir = 1 (ascending) or -1.
export function compareCells(x: Cell, y: Cell, dir: number) {
  if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1
  const r = isNum(x) && isNum(y) ? Number(x) - Number(y) : String(x).localeCompare(String(y))
  return r * dir
}

const tsvField = (v: Cell) => (v == null ? '' : String(v).replace(/[\t\n\r]/g, ' '))

// Header + rows, tab-separated; tabs and newlines inside values become spaces, NULL an empty field.
export function toTsv(columns: ResultColumn[], rows: Cell[][]) {
  return [columns.map((c) => c.name).join('\t'), ...rows.map((row) => row.map(tsvField).join('\t'))].join('\n')
}
