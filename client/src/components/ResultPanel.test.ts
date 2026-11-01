// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import ResultPanel from './ResultPanel.vue'
import type { StatementResult } from '../../../shared/types.ts'

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
    expect(mountPanel([]).text()).toContain('Ctrl+Entrée')
  })

  it('renders rows in a grid, NULL apart, and sorts numbers by value', async () => {
    const w = mountPanel([rows])
    expect(w.text()).toContain('2 lignes')
    expect(w.text()).toContain('il y en a plus')
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
})
