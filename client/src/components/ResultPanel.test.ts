// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import ResultPanel from './ResultPanel.vue'
import type { PlanNode, StatementResult } from '../../../shared/types.ts'

const vuetify = createVuetify({ components })
const mountPanel = (results: StatementResult[], active = 0) =>
  mount(ResultPanel, { props: { results, running: false, active }, global: { plugins: [vuetify] } })

const rows: StatementResult = {
  sql: 'select id, name from customers',
  start: 0,
  end: 30,
  kind: 'rows',
  columns: [
    { name: 'id', type: 'int4' },
    { name: 'name', type: 'text' },
  ],
  rows: [
    ['10', 'Zoé'],
    ['9', null],
  ],
  truncated: true,
  ms: 12,
  notices: [],
}

describe('ResultPanel', () => {
  it('shows the shortcuts while there is no result', () => {
    expect(mountPanel([]).text()).toContain('Ctrl+Enter')
  })

  it('renders rows in a grid, NULL apart, and sorts numbers by value', async () => {
    const w = mountPanel([rows])
    expect(w.text()).toContain('2 rows')
    expect(w.text()).toContain('there are more')
    const cells = () => w.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => td.text()))
    expect(cells()).toEqual([
      ['1', '10', 'Zoé'],
      ['2', '9', 'NULL'],
    ])
    expect(w.find('td.nul').text()).toBe('NULL')
    await w.findAll('th')[1].trigger('click')
    expect(cells().map((r) => r[1])).toEqual(['9', '10'])
  })

  it('switches to the active result of a new run and shows an error with its details', async () => {
    const error: StatementResult = {
      sql: 'selec 1',
      start: 31,
      end: 38,
      kind: 'error',
      ms: 1,
      error: { message: 'syntax error at or near "selec"', hint: 'Check the keyword', code: '42601' },
    }
    const w = mountPanel([])
    await w.setProps({ results: [rows, error, { sql: 'select 3', start: 40, end: 48, kind: 'skipped' }], active: 1 })
    expect(w.text()).toContain('syntax error at or near "selec"')
    expect(w.text()).toContain('HINT: Check the keyword')
    expect(w.text()).toContain('code 42601')
  })

  it('shows the plan the driver parsed, with the raw output one click away', async () => {
    const node = (title: string, time: number, self: number, children: PlanNode[] = []): PlanNode => ({
      title,
      details: [],
      rows: 10,
      estRows: 10,
      loops: 1,
      time,
      self,
      children,
    })
    const plan: StatementResult = {
      sql: 'select …',
      start: 0,
      end: 10,
      kind: 'rows',
      explain: 'analyze',
      columns: [{ name: 'QUERY PLAN', type: 'json' }],
      rows: [['[{"Plan": {"Node Type": "Limit"}}]']],
      // as the driver parses it
      plan: {
        analyze: true,
        summary: ['Execution 8 ms'],
        total: 8,
        root: node('Limit', 8, 1, [node('Sort', 7, 3, [node('Seq Scan on orders o', 4, 4)])]),
      },
      truncated: false,
      ms: 9,
    }
    const w = mountPanel([plan])
    expect(w.find('.v-tab').text()).toContain('ANALYZE select')
    expect(w.text()).toContain('EXPLAIN ANALYZE')
    const ops = w.findAll('tbody td.op .title').map((t) => t.text())
    expect(ops[0]).toBe('Limit')
    expect(ops).toContain('Seq Scan on orders o')
    // collapse the root: only it stays
    await w.find('tbody .caret').trigger('click')
    expect(w.findAll('tbody tr')).toHaveLength(1)
    await w
      .findAll('button')
      .find((b) => b.text() === 'Raw')!
      .trigger('click')
    // the engine's JSON, indented
    expect(w.find('pre.raw').text()).toMatch(/^\[\n {2}\{\n {4}"Plan": \{/)
    expect(w.find('tbody').exists()).toBe(false)
    localStorage.clear()
  })
})
