import type { Cell, Plan, PlanNode, ResultColumn } from '../../../shared/types.ts'
import { fillSelf, isObj, num, round, scalar, type Json } from '../plan.ts'

// MySQL / MariaDB EXPLAIN output → webgrip's plan tree:
// EXPLAIN FORMAT=JSON (both), ANALYZE FORMAT=JSON (MariaDB), EXPLAIN ANALYZE / FORMAT=TREE (MySQL, indented text).

// ---------------- JSON ----------------

const MY_ROWS = ['rows_produced_per_join', 'rows', 'rows_examined_per_scan']
const MY_SHOWN = new Set([
  'table_name',
  'access_type',
  'key',
  'select_id',
  'r_rows',
  'r_loops',
  'r_total_time_ms',
  'r_table_time_ms',
  'r_other_time_ms',
  'cost',
  'loops',
  ...MY_ROWS,
])
const label = (k: string) => k.replace(/^r_/, 'actual ').replace(/_/g, ' ')

function myTitle(key: string, o: Json) {
  if (typeof o.table_name === 'string') {
    let t = `${o.access_type ?? 'scan'} on ${o.table_name}`
    if (o.key) t += ` using ${o.key}`
    return t
  }
  const t = label(key)
  return o.select_id != null ? `${t} #${o.select_id}` : t
}

// Every nested object (or array of objects) is a child, except small objects of scalars that read as details (cost_info…)
function myNode(key: string, o: Json): PlanNode {
  const node: PlanNode = { title: myTitle(key, o), details: [], children: [] }
  const addChild = (k: string, v: Json) => {
    // { "table": {…} } items of a nested_loop: the table itself
    const keys = Object.keys(v)
    if (keys.length === 1 && isObj(v[keys[0]])) node.children.push(myNode(keys[0], v[keys[0]] as Json))
    else node.children.push(myNode(k, v))
  }
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v)) {
      const values = Object.values(v)
      if (values.every((x) => x == null || typeof x !== 'object')) {
        // cost_info: { query_cost, read_cost, eval_cost, prefix_cost… }
        if (k === 'cost_info') {
          // prefix_cost adds up the tables joined so far: the table's own share is read + eval
          const c = num(v.prefix_cost) ?? num(v.query_cost)
          if (c != null) node.cost = c
          if (num(v.read_cost) != null) node.selfCost = round(num(v.read_cost)! + (num(v.eval_cost) ?? 0))
          node.details.push(
            `cost: ${Object.entries(v)
              .map(([a, b]) => `${label(a)} ${b}`)
              .join(', ')}`,
          )
        } else
          node.details.push(
            `${label(k)}: ${Object.entries(v)
              .map(([a, b]) => `${label(a)} ${b}`)
              .join(', ')}`,
          )
      } else addChild(k, v)
    } else if (Array.isArray(v)) {
      if (v.some(isObj)) for (const item of v.filter(isObj)) addChild(k, item)
      else if (v.length) node.details.push(`${label(k)}: ${v.join(', ')}`)
    } else if (!MY_SHOWN.has(k) && v != null) node.details.push(`${label(k)}: ${scalar(v)}`)
  }
  const est = MY_ROWS.map((k) => num(o[k])).find((x) => x != null)
  const loops = num(o.r_loops)
  // MariaDB counts rows per loop (its estimated "loops" since 11.0)
  const estLoops = o.rows != null ? (num(o.loops) ?? loops ?? 1) : 1
  if (est != null) node.estRows = round(est * estLoops)
  if (num(o.cost) != null) node.cost = num(o.cost)
  if (num(o.r_rows) != null) node.rows = round(num(o.r_rows)! * (loops ?? 1))
  if (loops != null) node.loops = loops
  // a query block's time is its total; a table's or a sort's is its own
  const tableTime = num(o.r_table_time_ms)
  const time = num(o.r_total_time_ms) ?? (tableTime == null ? undefined : tableTime + (num(o.r_other_time_ms) ?? 0))
  if (time != null) {
    if (key === 'query_block') node.time = round(time)
    else node.self = round(time)
  }
  if (key === 'query_block') blocks.add(node)
  return node
}

const blocks = new WeakSet<PlanNode>()

// Costs and times are the node's own, except a query block's (its total): derive the missing inclusive / exclusive values.
function myRollup(n: PlanNode): { time?: number; cost: number } {
  const kids = n.children.map(myRollup)
  const timed = kids.some((k) => k.time != null)
  const kidsTime = kids.reduce((s, k) => s + (k.time ?? 0), 0)
  const kidsCost = kids.reduce((s, k) => s + k.cost, 0)
  if (blocks.has(n)) {
    if (n.time != null) n.self = round(Math.max(0, n.time - kidsTime))
    else if (timed) n.time = round(kidsTime)
  } else if (n.self != null || timed) {
    n.self ??= 0
    n.time = round(n.self + kidsTime)
  }
  if (n.selfCost == null && n.cost != null) n.selfCost = round(Math.max(0, n.cost - kidsCost))
  return { time: n.time, cost: kidsCost + (n.selfCost ?? 0) }
}

export function parseMyJsonPlan(json: unknown): Plan | null {
  if (!isObj(json) || !isObj(json.query_block)) return null
  const root = myNode('query_block', json.query_block)
  const analyze = JSON.stringify(json).includes('"r_')
  myRollup(root)
  const summary: string[] = []
  const qb = json.query_block
  if (num(qb.r_total_time_ms) != null) summary.push(`Execution ${round(num(qb.r_total_time_ms)!)} ms`)
  if (isObj(qb.cost_info) && qb.cost_info.query_cost != null) summary.push(`Query cost ${qb.cost_info.query_cost}`)
  const total = analyze ? (root.time ?? 0) : (root.cost ?? 0)
  return { analyze, root, summary, total }
}

// ---------------- MySQL tree text (EXPLAIN ANALYZE, FORMAT=TREE) ----------------

// "-> Filter: (t.a > 1)  (cost=0.35 rows=1) (actual time=0.03..0.04 rows=2 loops=3)"
export function parseMyTreePlan(text: string): Plan | null {
  const lines = text.split('\n')
  if (!lines[0]?.trimStart().startsWith('->')) return null
  const stack: { depth: number; node: PlanNode }[] = []
  let root: PlanNode | null = null
  let last: PlanNode | null = null
  let analyze = false
  for (const line of lines) {
    const m = /^(\s*)->\s*(.*)$/.exec(line)
    if (!m) {
      // a long title wrapped on the next line
      if (last && line.trim()) last.title += ' ' + line.trim()
      continue
    }
    const depth = m[1].length
    let body = m[2]
    const node: PlanNode = { title: '', details: [], children: [] }
    const est = /\(cost=([\d.e+]+)(?:\.\.([\d.e+]+))? rows=([\d.e+]+)\)/.exec(body)
    if (est) {
      node.cost = Number(est[2] ?? est[1])
      node.estRows = Number(est[3])
      body = body.replace(est[0], '')
    }
    const act = /\(actual time=([\d.e+]+)\.\.([\d.e+]+) rows=([\d.e+]+) loops=(\d+)\)/.exec(body)
    if (act) {
      analyze = true
      const loops = Number(act[4])
      node.loops = loops
      node.rows = round(Number(act[3]) * loops)
      node.time = round(Number(act[2]) * loops)
      if (node.estRows != null) node.estRows = round(node.estRows * loops)
      body = body.replace(act[0], '')
    } else if (/\(never executed\)/.test(body)) {
      analyze = true
      body = body.replace('(never executed)', '')
      node.details.push('never executed')
    }
    node.title = body.trim()
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else if (!root) root = node
    else {
      // several top-level nodes: put them under a common root
      if (root.title !== 'plan') root = { title: 'plan', details: [], children: [root] }
      root.children.push(node)
    }
    stack.push({ depth, node })
    last = node
  }
  if (!root) return null
  fillSelf(root)
  return { analyze, root, summary: [], total: analyze ? (root.time ?? 0) : (root.cost ?? 0) }
}

// The plan held by a result: one cell under the column EXPLAIN (or ANALYZE) prints, JSON or a "->" tree
export function planOf(columns: ResultColumn[], rows: Cell[][]): Plan | undefined {
  if (columns.length !== 1 || !/^(EXPLAIN|ANALYZE)$/i.test(columns[0].name) || rows.length !== 1) return undefined
  const v = String(rows[0][0] ?? '').trim()
  try {
    return (v.startsWith('{') ? parseMyJsonPlan(JSON.parse(v)) : parseMyTreePlan(v)) ?? undefined
  } catch {
    return undefined
  }
}
