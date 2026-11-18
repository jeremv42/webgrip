import { describe, expect, it } from 'vitest'
import { checkUpdated, editTargetOf, updateOf, type ColumnSource, type SourceTable } from './edit.ts'

const table = (name: string, key: string[], readonly: string[] = []): SourceTable => ({
  schema: 'public',
  name,
  key,
  readonly: new Set(readonly),
})
const col = (t: string, column: string): ColumnSource => ({ table: t, column })

describe('editTargetOf', () => {
  it('picks the one table whose primary key is in the result, its columns only', () => {
    const tables = new Map([
      ['1', table('orders', ['id'], ['total'])],
      ['2', table('customers', ['id'])],
    ])
    // orders.id, orders.note, orders.total (generated), customers.name, computed
    const sources = [col('1', 'id'), col('1', 'note'), col('1', 'total'), col('2', 'name'), null]
    expect(editTargetOf(sources, tables)).toEqual({
      schema: 'public',
      table: 'orders',
      columns: ['id', 'note', null, null, null],
      key: ['id'],
    })
  })

  it('needs every key column, a single candidate and no column shown twice', () => {
    const composite = new Map([['1', table('lines', ['order_id', 'n'])]])
    expect(editTargetOf([col('1', 'order_id'), col('1', 'qty')], composite)).toBeUndefined()
    expect(editTargetOf([col('1', 'order_id'), col('1', 'n')], composite)?.key).toEqual(['order_id', 'n'])
    const two = new Map([
      ['1', table('a', ['id'])],
      ['2', table('b', ['id'])],
    ])
    expect(editTargetOf([col('1', 'id'), col('2', 'id')], two)).toBeUndefined()
    const self = new Map([['1', table('a', ['id'])]])
    expect(editTargetOf([col('1', 'id'), col('1', 'id')], self)).toBeUndefined()
    expect(editTargetOf([col('1', 'id')], new Map([['1', table('a', [])]]))).toBeUndefined()
  })
})

describe('updateOf / checkUpdated', () => {
  it('builds a parameterized UPDATE, IS NULL for a NULL key', () => {
    const q = updateOf(
      't',
      { key: { id: 1, k: null }, set: { a: 'x' } },
      (s) => `[${s}]`,
      (i) => `$${i}`,
    )
    expect(q).toEqual({ sql: 'UPDATE t SET [a] = $1 WHERE [id] = $2 AND [k] IS NULL', values: ['x', 1] })
    expect(() => updateOf('t', { key: { id: 1 }, set: {} }, String, String)).toThrow('Nothing to update')
  })
  it('accepts exactly one updated row', () => {
    expect(() => checkUpdated({ key: { id: 1 }, set: {} }, 1)).not.toThrow()
    expect(() => checkUpdated({ key: { id: 1 }, set: {} }, 0)).toThrow('Row id = 1 not found')
    expect(() => checkUpdated({ key: { id: 1 }, set: {} }, 2)).toThrow('not unique (2 rows)')
  })
})
