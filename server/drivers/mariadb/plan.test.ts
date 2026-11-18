import { describe, expect, it } from 'vitest'
import type { PlanNode } from '../../../shared/types.ts'
// Real outputs (PostgreSQL 17, MySQL 8.4, MariaDB 11) of the same join + group by + order by … limit 10
import fixtures from './plan.fixtures.json' with { type: 'json' }
import { parseMyTreePlan, planOf } from './plan.ts'

// a result holding the single cell an EXPLAIN returns
const parse = (column: string, type: string, value: string) => planOf([{ name: column, type }], [[value]])
const flat = (n: PlanNode): PlanNode[] => [n, ...n.children.flatMap(flat)]
const titles = (n: PlanNode, depth = 0): string[] => [' '.repeat(depth * 2) + n.title, ...n.children.flatMap((c) => titles(c, depth + 1))]

describe('MySQL / MariaDB planOf', () => {
  it('ignores ordinary results', () => {
    expect(parse('id', 'LONG', '1')).toBeUndefined()
    expect(parse('EXPLAIN', 'VAR_STRING', 'not a plan')).toBeUndefined()
    expect(parse('EXPLAIN', 'VAR_STRING', '{broken')).toBeUndefined()
  })

  it('reads MySQL EXPLAIN FORMAT=JSON: tables as nodes, cost shares adding up to the query cost', () => {
    const p = parse('EXPLAIN', 'VAR_STRING', fixtures['mysql.plan'])!
    expect(p).toMatchObject({ analyze: false })
    expect(titles(p.root)).toEqual([
      'query block #1',
      '  ordering operation',
      '    grouping operation',
      '      range on c using PRIMARY',
      '      ref on o using customer_id',
    ])
    const sum = flat(p.root).reduce((s, n) => s + (n.selfCost ?? 0), 0)
    expect(sum).toBeCloseTo(p.total, 1)
  })

  it('reads MariaDB ANALYZE FORMAT=JSON: rows over all loops, times rolled up to the containers', () => {
    const p = parse('ANALYZE', 'VAR_STRING', fixtures['maria.analyze'])!
    expect(p.analyze).toBe(true)
    const o = flat(p.root).find((n) => n.title === 'ref on o using customer_id')!
    expect(o).toMatchObject({ loops: 299, rows: 7475, estRows: 7475 })
    expect(o.details).toContain('attached condition: o.total > 10')
    const tmp = flat(p.root).find((n) => n.title === 'temporary table')!
    expect(tmp.time).toBeCloseTo(
      tmp.children.reduce((s, c) => s + c.time!, 0),
      3,
    )
    expect(p.root.time).toBe(p.total)
  })

  it('reads MySQL EXPLAIN ANALYZE (text tree)', () => {
    const p = parse('EXPLAIN', 'VAR_STRING', fixtures['mysql.analyze'])!
    expect(p.analyze).toBe(true)
    expect(p.root.title).toBe('Limit: 10 row(s)')
    const lookup = flat(p.root).find((n) => n.title.startsWith('Index lookup on o'))!
    // per-loop figures multiplied by the loops
    expect(lookup).toMatchObject({ loops: 299, rows: 7475 })
    expect(lookup.estRows).toBeCloseTo(23.4 * 299, 1)
  })
})

describe('parseMyTreePlan', () => {
  it('nests by indentation and keeps the plan-only estimates', () => {
    const p = parseMyTreePlan(
      [
        '-> Nested loop inner join  (cost=3.5 rows=2)',
        '    -> Table scan on a  (cost=1 rows=2)',
        '    -> Single-row index lookup on b using PRIMARY (id=a.b_id)  (cost=1 rows=1)',
      ].join('\n'),
    )!
    expect(p.analyze).toBe(false)
    expect(p.root.children.map((c) => c.title)).toEqual(['Table scan on a', 'Single-row index lookup on b using PRIMARY (id=a.b_id)'])
    expect(p.root).toMatchObject({ cost: 3.5, estRows: 2, selfCost: 1.5 })
  })
})
