import { describe, expect, it } from 'vitest'
import { groupBy, toMarkdown } from './describe.ts'
import type { SchemaDescription } from '../shared/types.ts'

describe('groupBy', () => {
  it('groups rows by key, keeping their order', () => {
    const rows = [
      { t: 'a', n: 1 },
      { t: 'b', n: 2 },
      { t: 'a', n: 3 },
    ]
    expect([...groupBy(rows, (r) => r.t)]).toEqual([
      ['a', [rows[0], rows[2]]],
      ['b', [rows[1]]],
    ])
  })
})

describe('toMarkdown', () => {
  const d: SchemaDescription = {
    engine: 'PostgreSQL',
    version: 'PostgreSQL 17.2',
    database: 'shop',
    schema: 'public',
    schemas: ['public', 'sales'],
    tables: [
      {
        name: 'orders',
        kind: 'table',
        rows: 1200,
        comment: 'One row per order',
        columns: [
          { name: 'id', type: 'integer', notnull: true, default: "nextval('orders_id_seq'::regclass)", pk: true },
          { name: 'note', type: 'text', notnull: false, default: null, pk: false },
          { name: 'odd|name', type: 'text', notnull: false, default: "'a\n  b'", pk: false },
        ],
        foreignKeys: [{ name: 'orders_customer_fk', def: 'FOREIGN KEY (customer_id) REFERENCES customers(id)' }],
        indexes: [{ name: 'orders_date_idx', unique: false, def: 'USING btree (created_at)' }],
      },
      { name: 'v_orders', kind: 'view', rows: null, comment: null, columns: [], foreignKeys: [], indexes: [] },
    ],
  }

  it('renders the header, a table per relation, keys and indexes', () => {
    const md = toMarkdown(d)
    expect(md).toContain('# shop — PostgreSQL 17.2')
    expect(md).toContain('- Schéma : `public`')
    expect(md).toContain('- Schémas de la base : `public`, `sales`')
    expect(md).toContain('## Table `orders` (≈ 1200 lignes)\n\nOne row per order')
    expect(md).toContain("| id | integer | NOT NULL | nextval('orders_id_seq'::regclass) | PK |")
    expect(md).toContain('| note | text | NULL |  |  |')
    expect(md).toContain('- orders_customer_fk : FOREIGN KEY (customer_id) REFERENCES customers(id)')
    expect(md).toContain('- orders_date_idx : USING btree (created_at)')
    expect(md).toContain('## Vue `v_orders`\n')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('escapes pipes and flattens newlines inside cells', () => {
    expect(toMarkdown(d)).toContain("| odd\\|name | text | NULL | 'a b' |  |")
  })

  it('omits the schema lines for MariaDB', () => {
    const md = toMarkdown({ engine: 'MariaDB', version: '11.4', database: 'shop', tables: [] })
    expect(md).not.toContain('Schéma')
  })
})
