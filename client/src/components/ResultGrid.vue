<template>
  <div class="d-flex flex-column h-100">
    <div class="d-flex align-center px-2 py-1 ga-3 text-medium-emphasis bar">
      <span>
        {{ result.rows.length }} row{{ result.rows.length === 1 ? '' : 's' }}
        <span v-if="result.truncated" class="text-warning">
          (limited to {{ result.rows.length }}{{ result.total ? ` of ${result.total}` : ', there are more' }})
        </span>
      </span>
      <span>{{ fmtMs(result.ms) }}</span>
      <v-spacer />
      <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copy">{{ copied ? 'Copied' : 'Copy (TSV)' }}</v-btn>
    </div>
    <div class="grid-wrap mono">
      <table class="grid">
        <thead>
          <tr>
            <th class="rownum">#</th>
            <th v-for="(c, i) in result.columns" :key="i" :title="c.type" @click="sortBy(i)">
              {{ c.name }}
              <span class="type">{{ c.type }}</span>
              <v-icon v-if="sort.col === i" size="14">{{ sort.dir > 0 ? 'mdi-arrow-up' : 'mdi-arrow-down' }}</v-icon>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.i">
            <td class="rownum">{{ r.i + 1 }}</td>
            <td v-for="(v, j) in r.row" :key="j" :class="{ nul: v == null, num: isNum(v) }" @dblclick="show(result.columns[j].name, v)">
              {{ v == null ? 'NULL' : cut(v) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <v-dialog v-model="cell.open" max-width="900">
      <v-card :title="cell.name">
        <v-card-text>
          <pre class="mono cell-full">{{ cell.value }}</pre>
        </v-card-text>
        <v-card-actions>
          <v-btn @click="copyText(cell.value)">Copy</v-btn>
          <v-btn color="primary" @click="cell.open = false">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { Cell, RowsResult } from '../../../shared/types.ts'
import { compareCells, isNum, toTsv } from '../grid.ts'
import { copyText } from '../api.ts'

const props = defineProps<{ result: RowsResult }>()

const sort = reactive({ col: -1, dir: 1 })
watch(
  () => props.result,
  () => {
    sort.col = -1
  },
)

const cut = (v: Cell) => {
  const s = String(v)
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`)

function sortBy(i: number) {
  if (sort.col !== i) Object.assign(sort, { col: i, dir: 1 })
  else if (sort.dir > 0) sort.dir = -1
  else sort.col = -1
}

const rows = computed(() => {
  const list = props.result.rows.map((row, i) => ({ row, i }))
  if (sort.col < 0) return list
  const c = sort.col,
    d = sort.dir
  return list.toSorted((a, b) => compareCells(a.row[c], b.row[c], d))
})

const cell = reactive({ open: false, name: '', value: '' })
function show(name: string, v: Cell) {
  let value = v == null ? 'NULL' : String(v)
  if (/^\s*[[{]/.test(value)) {
    try {
      value = JSON.stringify(JSON.parse(value), null, 2)
    } catch {}
  }
  Object.assign(cell, { open: true, name, value })
}

const copied = ref(false)
async function copy() {
  await copyText(
    toTsv(
      props.result.columns,
      rows.value.map((r) => r.row),
    ),
  )
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<style scoped>
.bar {
  font-size: 13px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.grid-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.grid {
  border-collapse: separate;
  border-spacing: 0;
}
.grid th,
.grid td {
  border-right: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 2px 8px;
  white-space: nowrap;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}
.grid th {
  position: sticky;
  top: 0;
  z-index: 1;
  cursor: pointer;
  font-weight: 600;
  background: rgb(var(--v-theme-surface-light));
}
.grid .type {
  font-weight: 400;
  opacity: 0.5;
  font-size: 11px;
  margin-left: 4px;
}
.grid td.num {
  text-align: right;
}
.grid td.nul {
  opacity: 0.45;
  font-style: italic;
}
.grid .rownum {
  opacity: 0.5;
  text-align: right;
  position: sticky;
  left: 0;
  background: rgb(var(--v-theme-surface));
}
.grid th.rownum {
  z-index: 2;
  background: rgb(var(--v-theme-surface-light));
  opacity: 1;
}
.grid tbody tr:hover td {
  background: rgba(var(--v-theme-primary), 0.06);
}
.cell-full {
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60vh;
  overflow: auto;
}
</style>
