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

// Quick filter: a row matches when one of the given columns contains the text (case-insensitive; NULL never matches)
export function rowMatches(values: Cell[], needle: string) {
  const n = needle.toLowerCase()
  return values.some((v) => v != null && String(v).toLowerCase().includes(n))
}

// ---- virtual scrolling and column widths ----

// Every row has this exact height (one line, no wrapping): the rows on screen follow from the scroll position.
export const ROW_H = 24
const OVERSCAN = 10

// The rows to render [start, end) for a viewport of `height` px scrolled by `scrollTop`, plus a margin both ways
export function visibleRange(scrollTop: number, height: number, total: number, rowH = ROW_H) {
  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
  const end = Math.min(total, Math.ceil((scrollTop + height) / rowH) + OVERSCAN)
  return { start, end: Math.max(start, end) }
}

// Values longer than this are cut in the grid (the full value is one double-click away)
export const MAX_SHOWN = 300
export const cut = (v: Cell) => {
  const s = String(v)
  return s.length > MAX_SHOWN ? s.slice(0, MAX_SHOWN) + '…' : s
}

// Width in px of a column of the monospace grid: header (name, type in a smaller font, sort arrow) or longest value,
// plus padding, between `min` and `max`. `charW` = width of one character at the grid's font size.
export function columnWidth(name: string, type: string, values: Iterable<Cell>, charW: number, max: number, min = 48) {
  let chars = 0
  for (const v of values) chars = Math.max(chars, v == null ? 4 : Math.min(String(v).length, MAX_SHOWN + 1))
  const header = name.length * charW + 4 + (type.length * charW * 11) / 13 + 18
  return Math.round(Math.min(max, Math.max(min, chars * charW, header) + 17))
}
