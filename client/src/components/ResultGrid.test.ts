// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { markRaw } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import ResultGrid, { type FetchRows } from './ResultGrid.vue'
import type { RowsResult } from '../../../shared/types.ts'

const vuetify = createVuetify({ components })

const result = (n: number, editable = true): RowsResult => ({
  sql: 'select id, note, 1 + 1 as two from t',
  start: 0,
  end: 10,
  kind: 'rows',
  columns: [
    { name: 'id', type: 'int4' },
    { name: 'note', type: 'text' },
    { name: 'two', type: 'int4' },
  ],
  rows: Array.from({ length: n }, (_, i) => [String(i + 1), i % 2 ? null : `note ${i + 1}`, '2']),
  truncated: false,
  ms: 3,
  ...(editable && { editable: { schema: 'public', table: 't', columns: ['id', 'note', null], key: ['id'] } }),
})

// renders the menu's button and content inline (Vuetify overlays need a real viewport)
const MenuStub = { template: '<div><slot name="activator" :props="{}" /><slot /></div>' }

const mountGrid = (r: RowsResult, save?: (...a: unknown[]) => Promise<void>, fetchRows?: FetchRows) =>
  mount(ResultGrid, {
    props: { result: r, save, fetchRows },
    global: { plugins: [vuetify], stubs: { VDialog: true, VMenu: MenuStub } },
    attachTo: document.body,
  })

const bodyRows = (w: ReturnType<typeof mountGrid>) => w.findAll('tbody tr:not(.pad)')

describe('ResultGrid', () => {
  it('renders only the rows on screen of a big result, with spacers for the rest', async () => {
    const w = mountGrid(result(20000))
    expect(w.text()).toContain('20000 rows')
    const n = bodyRows(w).length
    expect(n).toBeGreaterThan(10)
    expect(n).toBeLessThan(100)
    expect(w.find('tbody tr.pad').attributes('style')).toContain(`height: ${(20000 - n) * 24}px`)
    // scrolled to row 10000
    const wrap = w.find('.grid-wrap')
    ;(wrap.element as HTMLElement).scrollTop = 24 * 10000
    await wrap.trigger('scroll')
    expect(bodyRows(w)[0].find('td').text()).toBe(String(10000 - 10 + 1))
    w.unmount()
  })

  it('gives each column a width from its content, fitted again by a double-click on its edge', async () => {
    const r = result(3)
    r.rows[0][1] = 'x'.repeat(100)
    const w = mountGrid(r)
    const width = () => Number(/width: (\d+)px/.exec(w.findAll('col')[2].attributes('style') ?? '')![1])
    const auto = width()
    expect(auto).toBeGreaterThan(400)
    expect(auto).toBeLessThanOrEqual(420)
    r.rows[0][1] = 'x'.repeat(1000)
    await w.findAll('th')[2].find('.resizer').trigger('dblclick')
    expect(width()).toBe(800)
    // the click on the edge does not sort
    await w.findAll('th')[2].find('.resizer').trigger('click')
    expect(w.findAll('th .mdi-arrow-up')).toHaveLength(0)
    w.unmount()
  })

  it('shows a copy button on the hovered cell, if wide enough and not NULL', async () => {
    const w = mountGrid(result(2))
    const cell = (i: number, j: number) => w.find(`td[data-cell="${i}:${j}"]`)
    await cell(0, 1).trigger('mouseover')
    expect(cell(0, 1).find('.cell-copy').exists()).toBe(true)
    await cell(1, 1).trigger('mouseover') // NULL
    expect(w.find('.cell-copy').exists()).toBe(false)
    w.unmount()
  })

  it('keeps edits pending until Save, which sends the key and new values by row', async () => {
    const save = vi.fn(async () => {})
    const r = result(2)
    const w = mountGrid(r, save)
    expect(w.text()).toContain('public.t')
    const cell = (i: number, j: number) => w.find(`td[data-cell="${i}:${j}"]`)

    // computed column: read-only, the double-click shows the value
    await cell(0, 2).trigger('dblclick')
    expect(w.find('input.cell-input').exists()).toBe(false)

    await cell(0, 1).trigger('dblclick')
    const input = w.find('input.cell-input')
    await input.setValue('changed')
    await input.trigger('keydown', { key: 'Enter' })
    expect(cell(0, 1).text()).toBe('changed')
    expect(cell(0, 1).classes()).toContain('dirty')
    expect(r.rows[0][1]).toBe('note 1') // not written yet
    // an untouched NULL stays NULL
    await cell(1, 1).trigger('dblclick')
    await w.find('input.cell-input').trigger('keydown', { key: 'Enter' })
    expect(cell(1, 1).classes()).not.toContain('dirty')
    // the key itself can change: the WHERE uses the value read
    await cell(1, 0).trigger('dblclick')
    await w.find('input.cell-input').setValue('20')
    await w.find('input.cell-input').trigger('keydown', { key: 'Enter' })
    expect(w.text()).toContain('2 rows changed')

    await w
      .findAll('button')
      .find((b) => b.text() === 'Save')!
      .trigger('click')
    await vi.waitFor(() => expect(w.find('td.dirty').exists()).toBe(false))
    expect(save).toHaveBeenCalledWith(r, [
      { key: { id: '1' }, set: { note: 'changed' } },
      { key: { id: '2' }, set: { id: '20' } },
    ])
    expect(r.rows.map((x) => x.slice(0, 2))).toEqual([
      ['1', 'changed'],
      ['20', null],
    ])
    w.unmount()
  })

  it('keeps the edits when saving fails, and Discard drops them', async () => {
    const save = vi.fn(async () => {
      throw new Error('boom')
    })
    const w = mountGrid(result(1), save)
    await w.find('td[data-cell="0:1"]').trigger('dblclick')
    await w.find('input.cell-input').setValue('x')
    await w.find('input.cell-input').trigger('keydown', { key: 'Enter' })
    const button = (t: string) => w.findAll('button').find((b) => b.text() === t)!
    await button('Save').trigger('click')
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    expect(w.find('td.dirty').exists()).toBe(true)
    await button('Discard').trigger('click')
    expect(w.find('td.dirty').exists()).toBe(false)
    w.unmount()
  })

  it('is read-only without an edit target or a save function', async () => {
    for (const w of [mountGrid(result(1, false), async () => {}), mountGrid(result(1))]) {
      await w.find('td[data-cell="0:1"]').trigger('dblclick')
      expect(w.find('input.cell-input').exists()).toBe(false)
      w.unmount()
    }
  })

  it('filters rows on the shown columns, and hides columns from the grid and the filter', async () => {
    const w = mountGrid(result(30))
    const firstCells = () => bodyRows(w).map((tr) => tr.findAll('td')[1].text())
    await w.find('input.filter').setValue('NOTE 1')
    await vi.waitFor(() => expect(w.text()).toContain('· 6 shown'))
    // note 1, 11, 13, 15, 17, 19 (even rows have a NULL note)
    expect(firstCells()).toEqual(['1', '11', '13', '15', '17', '19'])
    // hide "note": nothing matches any more
    await w.findAll('.column-item')[1].trigger('click')
    expect(w.findAll('thead th').map((th) => th.text().split(' ')[0])).toEqual(['#', 'id', 'two'])
    await vi.waitFor(() => expect(w.text()).toContain('· 0 shown'))
    expect(w.text()).toContain('(1 hidden)')
    await w.find('.show-all').trigger('click')
    expect(w.findAll('thead th')).toHaveLength(4)
    w.unmount()
  })

  it('loads the rows after the limit of a read-only query, appended to the grid', async () => {
    // a raw object, as in the app (props hold the results unproxied): the grid must not rely on its reactivity
    const r = markRaw({ ...result(2), truncated: true })
    const fetchRows = vi.fn(async () => ({ rows: [['3', 'note 3', '2']], truncated: false }))
    const w = mountGrid(r, undefined, fetchRows)
    expect(w.text()).toContain('there are more')
    await w
      .findAll('button')
      .find((b) => b.text() === 'Load more')!
      .trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('3 rows'))
    expect(fetchRows).toHaveBeenCalledWith(r, 2, false)
    expect(bodyRows(w)).toHaveLength(3)
    expect(w.text()).not.toContain('Load more')
    w.unmount()
    // not for a statement that must not run twice
    const dml = mountGrid({ ...result(2), truncated: true, sql: 'delete from t returning *' }, undefined, fetchRows)
    expect(dml.text()).not.toContain('Load more')
    dml.unmount()
  })
})
