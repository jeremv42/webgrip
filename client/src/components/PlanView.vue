<template>
  <div class="d-flex flex-column h-100">
    <div class="d-flex align-center px-2 py-1 ga-3 text-medium-emphasis bar">
      <strong class="text-high-emphasis">{{ plan.analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN' }}</strong>
      <span v-for="(s, i) in plan.summary" :key="i">{{ s }}</span>
      <span v-if="!plan.analyze" class="text-caption">estimates only: the statement was not run</span>
      <v-spacer />
      <v-btn
        v-if="view === 'plan'"
        size="small"
        variant="text"
        :prepend-icon="showDetails ? 'mdi-text-box-outline' : 'mdi-text-box-remove-outline'"
        :title="showDetails ? 'Hide the details (conditions, keys, buffers…)' : 'Show the details'"
        @click="showDetails = !showDetails"
        >Details</v-btn
      >
      <v-btn v-else size="small" variant="text" prepend-icon="mdi-content-copy" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</v-btn>
      <v-btn-toggle v-model="view" mandatory density="compact" variant="outlined" divided class="toggle">
        <v-btn value="plan" size="small" prepend-icon="mdi-file-tree" title="The plan as a tree, with each node's share">Plan</v-btn>
        <v-btn value="raw" size="small" prepend-icon="mdi-code-braces" title="The engine's output, as returned">Raw</v-btn>
      </v-btn-toggle>
    </div>
    <pre v-if="view === 'raw'" class="raw mono">{{ rawText }}</pre>
    <div v-else class="plan-wrap">
      <table class="plan">
        <thead>
          <tr>
            <th class="op">Operation</th>
            <th class="share">{{ plan.analyze ? 'Self time' : 'Self cost' }}</th>
            <th class="num">{{ plan.analyze ? 'Total ms' : 'Total cost' }}</th>
            <th v-if="plan.analyze" class="num">Rows</th>
            <th class="num">Est. rows</th>
            <th v-if="plan.analyze" class="num">Loops</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" :class="{ hot: r.pct >= 0.5 }">
            <td class="op">
              <div class="d-flex align-start" :style="{ paddingLeft: r.depth * 18 + 'px' }">
                <v-icon v-if="r.node.children.length" size="16" class="caret" @click="toggle(r.id)">{{
                  collapsed.has(r.id) ? 'mdi-chevron-right' : 'mdi-chevron-down'
                }}</v-icon>
                <span v-else class="caret" />
                <div class="min-w-0">
                  <div class="title">{{ r.node.title }}</div>
                  <template v-if="showDetails">
                    <div v-for="(d, i) in r.node.details" :key="i" class="detail">{{ d }}</div>
                  </template>
                </div>
              </div>
            </td>
            <td class="share">
              <template v-if="r.measure != null">
                <div class="meter"><div class="fill" :class="heat(r.pct)" :style="{ width: Math.min(100, r.pct * 100) + '%' }" /></div>
                <span class="share-text">{{ fmt(r.measure) }} · {{ pctText(r.pct) }}</span>
              </template>
            </td>
            <td class="num">{{ fmt(plan.analyze ? r.node.time : r.node.cost) }}</td>
            <td v-if="plan.analyze" class="num">
              <v-icon v-if="r.off >= 10" size="14" color="warning" class="mr-1" :title="offText(r.node, r.off)">mdi-alert</v-icon>
              {{ fmt(r.node.rows) }}
            </td>
            <td class="num">{{ fmt(r.node.estRows) }}</td>
            <td v-if="plan.analyze" class="num">{{ fmt(r.node.loops) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Plan, PlanNode } from '../../../shared/types.ts'
import { copyText, store } from '../api.ts'

// plan: parsed by the driver; raw: the engine's output it was read from (JSON or text)
const props = defineProps<{ plan: Plan; raw: string }>()

// tree or raw output: the last choice sticks
const view = ref<'plan' | 'raw'>(store.get<string>('plan.view', 'plan') === 'raw' ? 'raw' : 'plan')
watch(view, (v) => store.set('plan.view', v))
const rawText = computed(() => {
  try {
    return JSON.stringify(JSON.parse(props.raw), null, 2)
  } catch {
    return props.raw
  }
})
const copied = ref(false)
async function copy() {
  await copyText(props.raw)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

// Ratio between actual and estimated rows, as a factor ≥ 1 (both counted as at least 1 row)
function misestimate(n: PlanNode) {
  if (n.rows == null || n.estRows == null) return 1
  const a = Math.max(n.rows, 1),
    e = Math.max(n.estRows, 1)
  return a > e ? a / e : e / a
}

const showDetails = ref(store.get('plan.details', true))
watch(showDetails, (v) => store.set('plan.details', v))

const collapsed = ref(new Set<string>())
watch(
  () => props.plan,
  () => {
    collapsed.value = new Set()
  },
)
function toggle(id: string) {
  const s = new Set(collapsed.value)
  if (!s.delete(id)) s.add(id)
  collapsed.value = s
}

// The tree rendered flat, in display order, without the children of collapsed nodes
const rows = computed(() => {
  const out: { id: string; depth: number; node: PlanNode; measure?: number; pct: number; off: number }[] = []
  const { analyze, total } = props.plan
  // under a LIMIT, a node stops early: fewer rows than estimated is expected there
  const walk = (node: PlanNode, depth: number, id: string, limited: boolean) => {
    const measure = analyze ? node.self : node.selfCost
    const off = !analyze || (limited && (node.rows ?? 0) < (node.estRows ?? 0)) ? 1 : misestimate(node)
    out.push({ id, depth, node, measure, pct: measure != null && total > 0 ? measure / total : 0, off })
    limited ||= /^limit\b/i.test(node.title)
    if (!collapsed.value.has(id)) node.children.forEach((c, i) => walk(c, depth + 1, `${id}.${i}`, limited))
  }
  walk(props.plan.root, 0, '0', false)
  return out
})

const fmt = (n?: number) => {
  if (n == null) return ''
  if (Number.isInteger(n)) return n.toLocaleString('en-US')
  return n < 10 ? String(Math.round(n * 1000) / 1000) : n.toLocaleString('en-US', { maximumFractionDigits: 1 })
}
const pctText = (p: number) => (p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`)
const heat = (p: number) => (p >= 0.5 ? 'bg-error' : p >= 0.2 ? 'bg-warning' : 'bg-primary')
const offText = (n: PlanNode, f: number) =>
  `Estimated ${fmt(n.estRows)} row(s), got ${fmt(n.rows)}: ${(n.rows ?? 0) > (n.estRows ?? 0) ? 'under' : 'over'}estimated ×${fmt(Math.round(f))}`
</script>

<style scoped>
.toggle {
  height: 28px;
}
.raw {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  white-space: pre;
}
.bar {
  font-size: 12px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.plan-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.plan {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}
.plan th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: rgb(var(--v-theme-surface));
  text-align: left;
  font-weight: 600;
  padding: 4px 8px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  white-space: nowrap;
}
.plan td {
  padding: 3px 8px;
  vertical-align: top;
  border-bottom: 1px solid rgba(var(--v-border-color), 0.06);
}
.plan tr:hover td {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.op {
  width: 100%;
}
.caret {
  width: 16px;
  flex: 0 0 16px;
  margin: 1px 4px 0 0;
  cursor: pointer;
}
.title {
  font-family: ui-monospace, 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace;
  font-weight: 600;
}
.hot .title {
  color: rgb(var(--v-theme-error));
}
.detail {
  font-family: ui-monospace, 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace;
  opacity: 0.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.share {
  min-width: 170px;
  white-space: nowrap;
}
.meter {
  display: inline-block;
  vertical-align: middle;
  width: 60px;
  height: 8px;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), 0.08);
  overflow: hidden;
  margin-right: 6px;
}
.fill {
  height: 100%;
}
.share-text {
  font-variant-numeric: tabular-nums;
}
.num {
  text-align: right !important;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.min-w-0 {
  min-width: 0;
}
</style>
