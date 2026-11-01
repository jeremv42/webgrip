import { describe, expect, it } from 'vitest'
import { compareCells, isNum, toTsv } from './grid.ts'
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
