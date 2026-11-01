import { describe, expect, it } from 'vitest'
import { EntityContextType } from 'dt-sql-parser/dist/parser/common/types.js'
import { dottedName, insertColumns, makeIndex, sourceOf, splitName, textSources, unquote, visibleSources, type Entity } from './sources.ts'
import type { CompletionTable } from '../../../shared/types.ts'

const makeTable = (schema: string, name: string, ...cols: string[]): CompletionTable => ({
  schema,
  name,
  kind: 'table',
  columns: cols.map((c) => ({ name: c, type: 'text', pk: c === 'id' })),
})
const orders = makeTable('public', 'orders', 'id', 'customer_id')
const salesOrders = makeTable('sales', 'orders', 'id', 'amount')
const customers = makeTable('public', 'customers', 'id', 'name')
const index = makeIndex({ current: 'public', tables: [orders, salesOrders, customers] })

describe('names', () => {
  it('unquotes PostgreSQL and MariaDB identifiers', () => {
    expect(unquote('"My ""t"""')).toBe('My "t"')
    expect(unquote('`a``b`')).toBe('a`b')
    expect(unquote('plain')).toBe('plain')
  })

  it('splits dotted names, honouring quotes', () => {
    expect(splitName('sales.orders')).toEqual(['sales', 'orders'])
    expect(splitName('"my.schema"."T"')).toEqual(['my.schema', 'T'])
    expect(splitName('`db`.`t`')).toEqual(['db', 't'])
    expect(splitName('')).toEqual([])
  })

  it('finds the column list being typed in INSERT INTO', () => {
    expect('insert into sales.orders (id, am'.match(insertColumns)?.slice(1)).toEqual(['sales.orders', 'id, am'])
    expect('insert into t (a) values ('.match(insertColumns)).toBeNull()
  })

  it('finds the qualifier before a dot', () => {
    expect('select o.'.match(dottedName)?.[1]).toBe('o')
    expect('where "S".orders.am'.match(dottedName)?.[1]).toBe('"S".orders')
    expect('select 1.5'.match(dottedName)?.[1]).toBe('1')
  })
})

describe('makeIndex', () => {
  it('prefers the current schema for a bare name', () => {
    expect(index.find(['orders'])).toBe(orders)
    expect(index.find(['ORDERS'])).toBe(orders)
  })
  it('honours an explicit schema', () => {
    expect(index.find(['sales', 'orders'])).toBe(salesOrders)
    expect(index.find(['db', 'Sales', 'orders'])).toBe(salesOrders)
    expect(index.find(['nope', 'orders'])).toBeUndefined()
  })
  it('falls back to any schema', () => {
    const other = makeIndex({ current: 'x', tables: [salesOrders] })
    expect(other.find(['orders'])).toBe(salesOrders)
  })
})

describe('textSources', () => {
  it('reads FROM / JOIN / UPDATE targets and their aliases', () => {
    const sources = textSources('select * from orders o join sales.orders as s on s.id = o.id where', index)
    expect(sources.map(({ alias, name, table }) => [alias, name, table])).toEqual([
      ['o', 'o', orders],
      ['s', 's', salesOrders],
    ])
  })
  it('does not take a keyword for an alias', () => {
    const [src] = textSources('update customers set name = 1', index)
    expect(src).toMatchObject({ alias: null, name: 'customers', table: customers })
  })
  it('keeps unknown tables, without columns', () => {
    expect(textSources('delete from ghost', index)).toEqual([{ alias: null, name: 'ghost', table: null, columns: [] }])
  })
})

describe('sourceOf / visibleSources', () => {
  const entity = (text: string, startIndex: number, extra: Partial<Entity> = {}): Entity => ({
    entityContextType: EntityContextType.TABLE,
    text,
    position: { startIndex, endIndex: startIndex + text.length - 1 },
    ...extra,
  })

  it('uses the alias given by the parser, else the word after the table', () => {
    expect(sourceOf(entity('orders', 0, { _alias: { text: '"O"' } }), index).alias).toBe('O')
    const code = 'update orders o set customer_id = 1'
    expect(sourceOf(entity('orders', 7), index, code)).toMatchObject({ alias: 'o', name: 'o', table: orders })
    expect(sourceOf(entity('orders', 7), index, 'update orders set a = 1')).toMatchObject({ alias: null, name: 'orders' })
  })

  it('gives a subquery the columns of its SELECT list', () => {
    const sub = entity('(select id, name as n, c.* from customers c)', 14, {
      declareType: 1,
      _alias: { text: 'x' },
      relatedEntities: [
        {
          entityContextType: EntityContextType.QUERY_RESULT,
          text: '',
          position: { startIndex: 0, endIndex: 0 },
          columns: [
            { entityContextType: 'column', text: 'id', position: { startIndex: 0, endIndex: 0 }, _colType: null },
            { entityContextType: 'column', text: 'name', position: { startIndex: 0, endIndex: 0 }, _alias: { text: 'n' } },
            { entityContextType: 'column', text: 'c.*', position: { startIndex: 0, endIndex: 0 } },
          ],
          relatedEntities: [entity('customers', 40, { _alias: { text: 'c' } })],
        },
      ],
    })
    expect(sourceOf(sub, index)).toEqual({
      alias: 'x',
      name: 'x',
      table: null,
      columns: [{ name: 'id', type: '' }, { name: 'n', type: '' }, ...customers.columns],
    })
  })

  it("keeps the caret statement's tables, including those tied to no statement", () => {
    const stmt = { sql: 'update orders o set a = 1', start: 20, end: 45 }
    const entities = [
      entity('customers', 0, { belongStmt: { isContainCaret: false } }),
      entity('orders', 27), // UPDATE target: no belongStmt
      entity('customers', 60, { belongStmt: { isContainCaret: true }, isAccessible: true }),
      entity('orders', 70, { belongStmt: { isContainCaret: true }, isAccessible: false }),
      entity('ghost', 5), // outside the statement
    ]
    const sources = visibleSources(entities, index, stmt, ' '.repeat(20) + 'update orders o set a = 1')
    expect(sources.map((s) => s.name)).toEqual(['o', 'customers'])
  })
})
