import type { PlanNode } from '../../shared/types.ts'

// Helpers shared by the drivers' EXPLAIN parsers (postgres-plan.ts, mariadb-plan.ts)

export type Json = Record<string, unknown>
export const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
export const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}
export const scalar = (v: unknown): string | undefined =>
  v == null || typeof v === 'object' ? undefined : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)
export const round = (n: number) => Math.round(n * 1000) / 1000

// Exclusive values for engines that report inclusive ones: the node minus its children, never negative
export function fillSelf(n: PlanNode) {
  for (const c of n.children) fillSelf(c)
  const sum = (f: (c: PlanNode) => number | undefined) => n.children.reduce((s, c) => s + (f(c) ?? 0), 0)
  if (n.time != null) n.self = round(Math.max(0, n.time - sum((c) => c.time)))
  if (n.cost != null) n.selfCost ??= round(Math.max(0, n.cost - sum((c) => c.cost)))
}
