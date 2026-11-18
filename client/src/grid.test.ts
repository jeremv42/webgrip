import { describe, expect, it } from 'vitest'
import { columnWidth, compareCells, cut, isNum, toTsv, visibleRange } from './grid.ts'
import type { Cell } from '../../shared/types.ts'

describe('isNum', () => {
  it('accepts numbers and numeric text', () => {
    for (const v of [1, 0, '42', '-3.5', '1e3', ' 7 ']) expect(isNum(v)).toBe(true)
  })
  it('rejects text, empty strings, NULL and very long digit strings', () => {
    for (const v of ['abc', '', null, '12a', '1'.repeat(40)]) expect(isNum(v)).toBe(false)
  })
})

describe('compareCells', () => {
  const sorted = (values: Cell[], dir = 1) => values.toSorted((a, b) => compareCells(a, b, dir))

  it('sorts numeric text by value, not alphabetically', () => {
    expect(sorted(['10', '9', '100'])).toEqual(['9', '10', '100'])
    expect(sorted(['10', '9', '100'], -1)).toEqual(['100', '10', '9'])
  })
  it('sorts text with localeCompare', () => {
    expect(sorted(['b', 'a', 'C'])).toEqual(['a', 'b', 'C'])
  })
  it('keeps NULL last in both directions', () => {
    expect(sorted([null, '2', '1'])).toEqual(['1', '2', null])
    expect(sorted([null, '2', '1'], -1)).toEqual(['2', '1', null])
  })
})

describe('toTsv', () => {
  it('writes a header, empty fields for NULL and flattens tabs / newlines', () => {
    const tsv = toTsv(
      [
        { name: 'id', type: 'int4' },
        { name: 'note', type: 'text' },
      ],
      [
        [1, 'a\tb\nc'],
        ['2', null],
      ],
    )
    expect(tsv).toBe('id\tnote\n1\ta b c\n2\t')
  })
})

describe('visibleRange', () => {
  it('renders the rows on screen plus a margin, within bounds', () => {
    expect(visibleRange(0, 240, 20000, 24)).toEqual({ start: 0, end: 20 })
    expect(visibleRange(24 * 1000, 240, 20000, 24)).toEqual({ start: 990, end: 1020 })
    expect(visibleRange(24 * 19990, 240, 20000, 24)).toEqual({ start: 19980, end: 20000 })
    expect(visibleRange(0, 240, 0, 24)).toEqual({ start: 0, end: 0 })
  })
})

describe('columnWidth / cut', () => {
  it('fits the longest value or the header, within bounds', () => {
    // 10 chars × 8 px + 17 px padding
    expect(columnWidth('id', '', ['1234567890', null, 5], 8, 400)).toBe(97)
    // header: 4 chars + type + arrow
    expect(columnWidth('name', 'text', ['a'], 13, 400)).toBe(Math.round(4 * 13 + 4 + 4 * 11 + 18 + 17))
    expect(columnWidth('x', '', ['a'.repeat(1000)], 8, 420)).toBe(420)
    expect(columnWidth('x', '', [], 8, 420)).toBe(48 + 17)
  })
  it('cuts long values', () => {
    expect(cut('a'.repeat(301))).toBe('a'.repeat(300) + '…')
    expect(cut(12)).toBe('12')
  })
})
