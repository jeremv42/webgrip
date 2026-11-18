// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { closeTab, loadTabs, newTab, saveTabs } from './tabs.ts'

afterEach(() => localStorage.clear())

const tab = (id: string, name = id, sql = '') => ({ id, name, sql })

describe('newTab', () => {
  it('numbers consoles after the highest one in use', () => {
    expect(newTab([]).name).toBe('Console 1')
    expect(newTab([tab('a', 'Console 1'), tab('b', 'Console 4'), tab('c', 'mine')]).name).toBe('Console 5')
    const t = newTab([], 'select 1')
    expect(t.sql).toBe('select 1')
    expect(t.id).not.toBe(newTab([]).id)
  })
})

describe('loadTabs / saveTabs', () => {
  it('starts with one tab holding the text of the single-editor version', () => {
    localStorage.setItem('webgrip.sql.c1', JSON.stringify('select 1'))
    const s = loadTabs('c1')
    expect(s.tabs).toEqual([{ id: s.active, name: 'Console 1', sql: 'select 1' }])
    expect(loadTabs('other').tabs[0].sql).toBe('')
  })

  it('round-trips the tabs and the active one, per connection', () => {
    saveTabs('c1', { tabs: [tab('a', 'A', 'x'), tab('b', 'B', 'y')], active: 'b' })
    expect(loadTabs('c1')).toEqual({ tabs: [tab('a', 'A', 'x'), tab('b', 'B', 'y')], active: 'b' })
    expect(loadTabs('c2').tabs).toHaveLength(1)
  })

  it('saves only the tab fields, and repairs a missing active tab', () => {
    saveTabs('c1', { tabs: [{ ...tab('a'), extra: 1 } as ReturnType<typeof tab>], active: 'gone' })
    expect(JSON.parse(localStorage.getItem('webgrip.tabs.c1')!).tabs[0]).toEqual(tab('a'))
    expect(loadTabs('c1').active).toBe('a')
  })

  it('ignores a broken saved state', () => {
    localStorage.setItem('webgrip.tabs.c1', JSON.stringify({ tabs: [] }))
    expect(loadTabs('c1').tabs).toHaveLength(1)
  })
})

describe('closeTab', () => {
  const state = { tabs: [tab('a'), tab('b'), tab('c')], active: 'b' }
  it('activates the next tab, or the previous one at the end', () => {
    expect(closeTab(state, 'b')).toEqual({ tabs: [tab('a'), tab('c')], active: 'c' })
    expect(closeTab({ ...state, active: 'c' }, 'c').active).toBe('b')
  })
  it('keeps the active tab when closing another one', () => {
    expect(closeTab(state, 'a')).toEqual({ tabs: [tab('b'), tab('c')], active: 'b' })
  })
  it('replaces the last tab with an empty one', () => {
    const s = closeTab({ tabs: [tab('a', 'Console 3', 'x')], active: 'a' }, 'a')
    expect(s.tabs).toEqual([{ id: s.active, name: 'Console 1', sql: '' }])
  })
})
