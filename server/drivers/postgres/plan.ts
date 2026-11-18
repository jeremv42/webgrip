import type { Cell, Plan, PlanNode, ResultColumn } from '../../../shared/types.ts'
import { fillSelf, isObj, num, round, scalar, type Json } from '../plan.ts'

// PostgreSQL EXPLAIN (FORMAT JSON [, ANALYZE]) → webgrip's plan tree

// Keys shown in the node's title or columns, not in its details
const PG_SHOWN = new Set([
  'Node Type',
  'Plans',
  'Relation Name',
  'Schema',
  'Alias',
  'Index Name',
  'Join Type',
  'Strategy',
  'Partial Mode',
  'Parallel Aware',
  'Async Capable',
  'Startup Cost',
  'Total Cost',
  'Plan Rows',
  'Plan Width',
  'Actual Startup Time',
  'Actual Total Time',
  'Actual Rows',
  'Actual Loops',
  'Scan Direction',
  'Inner Unique',
  'Disabled',
])
const AGG: Record<string, string> = { Hashed: 'HashAggregate', Sorted: 'GroupAggregate', Mixed: 'MixedAggregate' }

// The title EXPLAIN's text format would print: "Hash Left Join", "Index Scan Backward using pk on public.t x"…
function pgTitle(p: Json) {
  // ModifyTable reads "Update on t" in the text format
  let t = String((p['Node Type'] === 'ModifyTable' && p.Operation) || p['Node Type'] || '?')
  if (t === 'Aggregate' && typeof p.Strategy === 'string') t = AGG[p.Strategy] ?? t
  if (typeof p['Join Type'] === 'string' && p['Join Type'] !== 'Inner') {
    const jt = p['Join Type']
    t = t.endsWith('Join') ? t.replace(/Join$/, `${jt} Join`) : `${t} ${jt} Join`
  }
  if (p['Partial Mode'] && p['Partial Mode'] !== 'Simple') t = `${p['Partial Mode']} ${t}`
  if (p['Parallel Aware']) t = `Parallel ${t}`
  if (p['Scan Direction'] === 'Backward') t += ' Backward'
  if (p['Index Name']) t += ` using ${p['Index Name']}`
  const rel = p['Relation Name'] ?? p['CTE Name'] ?? p['Function Name']
  if (rel) {
    t += ` on ${p.Schema ? p.Schema + '.' : ''}${rel}`
    if (p.Alias && p.Alias !== rel) t += ` ${p.Alias}`
  }
  return t
}

const KB = /(Memory Usage|Space Used|Disk Usage)$/

function pgDetail(k: string, v: unknown, p: Json) {
  if (Array.isArray(v)) {
    const items = v.map(scalar).filter((x) => x != null)
    return items.length ? `${k}: ${items.join(', ')}` : undefined
  }
  const s = scalar(v)
  // zero counters (blocks, rows removed, disk…) and "Original Hash Buckets" equal to the final ones are noise
  if (s == null || (v === 0 && k !== 'Workers Launched')) return undefined
  if (k.startsWith('Original ') && p[k.slice(9)] === v) return undefined
  return `${k}: ${s}${KB.test(k) ? ' kB' : ''}`
}

function pgNode(p: Json, analyze: boolean): PlanNode {
  const loops = num(p['Actual Loops']) ?? 1
  const planRows = num(p['Plan Rows'])
  const actualRows = num(p['Actual Rows'])
  const totalTime = num(p['Actual Total Time'])
  const details: string[] = p.Disabled === true ? ['Disabled: its enable_* setting is off, but no other plan was possible'] : []
  for (const [k, v] of Object.entries(p)) {
    if (PG_SHOWN.has(k) || /^(Relation Name|CTE Name|Function Name)$/.test(k)) continue
    if (k === 'Parent Relationship' && /^(Outer|Inner|Member)$/.test(String(v))) continue
    if (k === 'Operation' && p['Node Type'] === 'ModifyTable') continue
    const d = pgDetail(k, v, p)
    if (d) details.push(d)
  }
  return {
    // PostgreSQL 18+: a node type turned off by an enable_* setting, used anyway for lack of another plan
    title: pgTitle(p) + (p.Disabled === true ? ' (disabled)' : ''),
    details,
    estRows: planRows == null ? undefined : planRows * (analyze ? loops : 1),
    rows: actualRows == null ? undefined : actualRows * loops,
    loops: analyze ? loops : undefined,
    cost: num(p['Total Cost']),
    // a node never run ("never executed") has no time
    time: totalTime == null ? undefined : round(totalTime * loops),
    children: Array.isArray(p.Plans) ? p.Plans.filter(isObj).map((c) => pgNode(c, analyze)) : [],
  }
}

export function parsePgPlan(json: unknown): Plan | null {
  const top = Array.isArray(json) ? json[0] : json
  if (!isObj(top) || !isObj(top.Plan)) return null
  const analyze = top['Execution Time'] != null || top.Plan['Actual Loops'] != null
  const root = pgNode(top.Plan, analyze)
  fillSelf(root)
  const summary: string[] = []
  const ms = (k: string) => num(top[k])
  if (ms('Planning Time') != null) summary.push(`Planning ${ms('Planning Time')} ms`)
  if (ms('Execution Time') != null) summary.push(`Execution ${ms('Execution Time')} ms`)
  if (Array.isArray(top.Triggers))
    for (const t of top.Triggers.filter(isObj))
      summary.push(`Trigger ${t['Trigger Name']}${t.Relation ? ` on ${t.Relation}` : ''}: ${num(t.Time) ?? '?'} ms, ${t.Calls} call(s)`)
  if (isObj(top.JIT)) summary.push(`JIT: ${num(top.JIT.Functions) ?? '?'} function(s)`)
  const total = analyze ? (ms('Execution Time') ?? root.time ?? 0) : (root.cost ?? 0)
  return { analyze, root, summary, total }
}

// The plan held by a result: EXPLAIN (FORMAT JSON) returns one json cell named "QUERY PLAN"
export function planOf(columns: ResultColumn[], rows: Cell[][]): Plan | undefined {
  if (columns.length !== 1 || columns[0].name !== 'QUERY PLAN' || columns[0].type !== 'json' || rows.length !== 1) return undefined
  try {
    return parsePgPlan(JSON.parse(String(rows[0][0]))) ?? undefined
  } catch {
    return undefined
  }
}
