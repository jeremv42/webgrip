import { store } from './api.ts'

// Editor tabs ("consoles"), saved per connection in localStorage under tabs.<connection id>.

export interface EditorTab {
  id: string
  name: string
  sql: string
}

export interface TabState {
  tabs: EditorTab[]
  active: string
}

// crypto.randomUUID only exists in secure contexts (not over plain http on the tailnet)
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

// "Console N", N one more than the highest number in use
export function newTab(tabs: EditorTab[], sql = ''): EditorTab {
  const n = Math.max(0, ...tabs.map((t) => Number(/^Console (\d+)$/.exec(t.name)?.[1]) || 0)) + 1
  return { id: newId(), name: `Console ${n}`, sql }
}

const valid = (s: unknown): s is TabState =>
  !!s && Array.isArray((s as TabState).tabs) && (s as TabState).tabs.length > 0 && (s as TabState).tabs.every((t) => t?.id)

// The saved tabs, else one tab holding the text saved by the single-editor version (sql.<id>).
export function loadTabs(connId: string): TabState {
  const saved = store.get<unknown>('tabs.' + connId, null)
  if (valid(saved)) {
    const tabs = saved.tabs.map((t) => ({ id: String(t.id), name: String(t.name || 'Console'), sql: String(t.sql ?? '') }))
    return { tabs, active: tabs.some((t) => t.id === saved.active) ? saved.active : tabs[0].id }
  }
  const tab = newTab([], store.get('sql.' + connId, ''))
  return { tabs: [tab], active: tab.id }
}

export function saveTabs(connId: string, state: TabState) {
  store.set('tabs.' + connId, { tabs: state.tabs.map(({ id, name, sql }) => ({ id, name, sql })), active: state.active })
}

// Removes a tab (never the last one: it is replaced by an empty tab) and picks the neighbour as the active one.
export function closeTab(state: TabState, id: string): TabState {
  const i = state.tabs.findIndex((t) => t.id === id)
  if (i < 0) return state
  let tabs = state.tabs.filter((t) => t.id !== id)
  if (!tabs.length) tabs = [newTab([])]
  const active = state.active === id ? tabs[Math.min(i, tabs.length - 1)].id : state.active
  return { tabs, active }
}
