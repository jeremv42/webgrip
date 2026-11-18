import { describe, expect, it } from 'vitest'
import type { PlanNode } from '../../../shared/types.ts'
// Real outputs (PostgreSQL 17, MySQL 8.4, MariaDB 11) of the same join + group by + order by … limit 10
import fixtures from './plan.fixtures.json' with { type: 'json' }
import { planOf } from './plan.ts'

// a result holding the single cell an EXPLAIN returns
const parse = (column: string, type: string, value: string) => planOf([{ name: column, type }], [[value]])
const flat = (n: PlanNode): PlanNode[] => [n, ...n.children.flatMap(flat)]
const titles = (n: PlanNode, depth = 0): string[] => [' '.repeat(depth * 2) + n.title, ...n.children.flatMap((c) => titles(c, depth + 1))]

describe('PostgreSQL planOf', () => {
  it('ignores ordinary results', () => {
    expect(parse('id', 'int4', '1')).toBeUndefined()
    expect(parse('QUERY PLAN', 'text', 'Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)')).toBeUndefined()
    expect(parse('QUERY PLAN', 'json', '{broken')).toBeUndefined()
  })

  it('reads a PostgreSQL plan: titles as in the text format, details, estimates', () => {
    const p = parse('QUERY PLAN', 'json', fixtures['pg.plan'])!
    expect(p).toMatchObject({ analyze: false, total: p.root.cost })
    expect(titles(p.root)).toEqual([
      'Limit',
      '  Sort',
      '    HashAggregate',
      '      Hash Join',
      '        Seq Scan on orders o',
      '        Hash',
      '          Index Scan using customers_pkey on customers c',
    ])
    const scan = flat(p.root).find((n) => n.title.startsWith('Seq Scan'))!
    expect(scan.details).toContain("Filter: (total > '10'::numeric)")
    expect(scan.rows).toBeUndefined()
    // zero counters are left out
    expect(flat(p.root).flatMap((n) => n.details)).not.toContain('Planned Partitions: 0')
  })

  it('reads a PostgreSQL EXPLAIN ANALYZE: actual rows, inclusive and exclusive times', () => {
    const p = parse('QUERY PLAN', 'json', fixtures['pg.analyze'])!
    expect(p.analyze).toBe(true)
    expect(p.summary).toEqual([expect.stringMatching(/^Planning [\d.]+ ms$/), expect.stringMatching(/^Execution [\d.]+ ms$/)])
    const join = flat(p.root).find((n) => n.title === 'Hash Join')!
    expect(join.rows).toBe(6624)
    expect(join.self).toBeCloseTo(join.time! - join.children.reduce((s, c) => s + c.time!, 0), 2)
    for (const n of flat(p.root)) expect(n.self).toBeGreaterThanOrEqual(0)
    expect(flat(p.root).flatMap((n) => n.details)).toContain('Peak Memory Usage: 157 kB')
  })

  it('flags a node disabled by an enable_* setting (PostgreSQL 18), and hides "Disabled: false"', () => {
    const node = (disabled: boolean) => ({ 'Node Type': 'Seq Scan', 'Relation Name': 't', Alias: 't', 'Total Cost': 1, Disabled: disabled })
    const plan = (disabled: boolean) => parse('QUERY PLAN', 'json', JSON.stringify([{ Plan: node(disabled) }]))!.root
    expect(plan(false)).toMatchObject({ title: 'Seq Scan on t', details: [] })
    expect(plan(true).title).toBe('Seq Scan on t (disabled)')
    expect(plan(true).details[0]).toMatch(/^Disabled: /)
  })
})
