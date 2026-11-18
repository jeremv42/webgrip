<template>
  <div class="d-flex flex-column h-100">
    <div class="d-flex align-center px-2 py-1 ga-3 text-medium-emphasis bar">
      <span>
        {{ result.rows.length }} row{{ result.rows.length === 1 ? '' : 's' }}
        <span v-if="result.truncated" class="text-warning">
          (limited to {{ result.rows.length }}{{ result.total ? ` of ${result.total}` : ', there are more' }})
        </span>
        <span v-if="filter" class="text-primary">· {{ rows.length }} shown</span>
      </span>
      <template v-if="canLoadMore">
        <v-btn
          size="small"
          variant="tonal"
          prepend-icon="mdi-chevron-double-down"
          :loading="loading === 'more'"
          :disabled="!!loading"
          @click="loadMore(false)"
          >Load more</v-btn
        >
        <v-btn
          size="small"
          variant="text"
          title="Up to 100,000 more rows"
          :loading="loading === 'all'"
          :disabled="!!loading"
          @click="loadMore(true)"
          >Load all</v-btn
        >
      </template>
      <span>{{ fmtMs(result.ms) }}</span>
      <span
        v-if="target"
        class="d-flex align-center ga-1"
        title="Double-click a cell to edit it (Shift+double-click: full editor, NULL). Changes are only written on Save."
      >
        <v-icon size="14">mdi-pencil-outline</v-icon>{{ target.schema }}.{{ target.table }}
      </span>
      <v-spacer />
      <input
        v-model="filterText"
        class="filter mono"
        placeholder="Filter rows…"
        title="Rows where a shown column contains this text"
        @keydown.esc="filterText = ''"
      />
      <v-menu :close-on-content-click="false" location="bottom end">
        <template #activator="{ props: p }">
          <v-btn v-bind="p" size="small" variant="text" prepend-icon="mdi-view-column-outline" class="columns-btn"
            >Columns<span v-if="hidden.size" class="text-warning ml-1">({{ hidden.size }} hidden)</span></v-btn
          >
        </template>
        <v-list density="compact" class="columns-list">
          <v-list-item v-for="(c, j) in result.columns" :key="j" class="column-item" @click="toggleColumn(j)">
            <template #prepend>
              <v-icon size="18">{{ hidden.has(j) ? 'mdi-checkbox-blank-outline' : 'mdi-checkbox-marked' }}</v-icon>
            </template>
            <v-list-item-title class="mono"
              >{{ c.name }} <span class="type">{{ c.type }}</span></v-list-item-title
            >
          </v-list-item>
          <v-divider />
          <v-list-item :disabled="!hidden.size" class="show-all" @click="hidden.clear()">Show all</v-list-item>
        </v-list>
      </v-menu>
      <template v-if="pending.size">
        <span class="text-warning">{{ changedRows }} row{{ changedRows === 1 ? '' : 's' }} changed</span>
        <v-btn size="small" variant="text" prepend-icon="mdi-undo" :disabled="saving" @click="discard">Discard</v-btn>
        <v-btn size="small" variant="flat" color="primary" prepend-icon="mdi-content-save" :loading="saving" @click="saveChanges"
          >Save</v-btn
        >
      </template>
      <v-btn size="small" variant="text" prepend-icon="mdi-content-copy" @click="copy">{{ copied ? 'Copied' : 'Copy (TSV)' }}</v-btn>
    </div>
    <div ref="wrap" class="grid-wrap mono" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop">
      <table class="grid" :style="{ width: tableWidth + 'px' }">
        <colgroup>
          <col :style="{ width: numWidth + 'px' }" />
          <col v-for="j in cols" :key="j" :style="{ width: widths[j] + 'px' }" />
        </colgroup>
        <thead>
          <tr>
            <th class="rownum">#</th>
            <th v-for="i in cols" :key="i" :title="`${result.columns[i].name} (${result.columns[i].type})`" @click="sortBy(i)">
              {{ result.columns[i].name }}
              <span class="type">{{ result.columns[i].type }}</span>
              <v-icon v-if="sort.col === i" size="14">{{ sort.dir > 0 ? 'mdi-arrow-up' : 'mdi-arrow-down' }}</v-icon>
              <span
                class="resizer"
                title="Drag to resize, double-click to fit the content"
                @mousedown.stop.prevent="startResize(i, $event)"
                @click.stop
                @dblclick.stop="fit(i)"
              />
            </th>
          </tr>
        </thead>
        <tbody @mouseover="onHover" @mouseleave="hover = null">
          <tr v-if="range.start > 0" class="pad" :style="{ height: range.start * ROW_H + 'px' }">
            <td :colspan="cols.length + 1" />
          </tr>
          <tr v-for="r in shown" :key="r.i">
            <td class="rownum">{{ r.i + 1 }}</td>
            <td v-for="j in cols" :key="j" :data-cell="`${r.i}:${j}`" :class="classOf(r.i, j)" @dblclick="open(r.i, j, $event)">
              <input
                v-if="inline && inline.i === r.i && inline.j === j"
                ref="input"
                v-model="inline.text"
                class="cell-input mono"
                @keydown.enter.prevent="commitInline"
                @keydown.esc.prevent="inline = null"
                @blur="commitInline"
                @dblclick.stop
              />
              <template v-else>{{ valueAt(r.i, j) == null ? 'NULL' : cut(valueAt(r.i, j)) }}</template>
              <button
                v-if="hover === `${r.i}:${j}` && !inline && valueAt(r.i, j) != null && widths[j] >= COPY_MIN_WIDTH"
                class="cell-copy"
                :title="copiedCell === hover ? 'Copied' : 'Copy the value'"
                @click.stop="copyCell(r.i, j)"
                @dblclick.stop
              >
                <v-icon size="14">{{ copiedCell === hover ? 'mdi-check' : 'mdi-content-copy' }}</v-icon>
              </button>
            </td>
          </tr>
          <tr v-if="range.end < rows.length" class="pad" :style="{ height: (rows.length - range.end) * ROW_H + 'px' }">
            <td :colspan="cols.length + 1" />
          </tr>
        </tbody>
      </table>
    </div>
    <v-dialog v-model="cell.open" max-width="900">
      <v-card :title="cell.name">
        <v-card-text>
          <template v-if="cell.edit">
            <v-textarea
              v-model="cell.value"
              class="mono"
              rows="10"
              :disabled="cell.isNull"
              :placeholder="cell.isNull ? 'NULL' : ''"
              hide-details
              autofocus
            />
            <v-checkbox v-model="cell.isNull" label="NULL" hide-details density="compact" class="mt-2" />
          </template>
          <pre v-else class="mono cell-full">{{ cell.value }}</pre>
        </v-card-text>
        <v-card-actions>
          <template v-if="cell.edit">
            <v-btn @click="cell.open = false">Cancel</v-btn>
            <v-btn color="primary" @click="applyDialog">Apply</v-btn>
          </template>
          <template v-else>
            <v-btn @click="copyText(cell.value)">Copy</v-btn>
            <v-btn color="primary" @click="cell.open = false">Close</v-btn>
          </template>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script lang="ts">
import type { Cell, RowChange, RowsPage, RowsResult } from '../../../shared/types.ts'

// Pending edits of each result ("row:column" -> new value), kept while the result exists (switching result tabs keeps them)
const pendingOf = new WeakMap<RowsResult, Map<string, Cell>>()

export type SaveRows = (result: RowsResult, changes: RowChange[]) => Promise<void>
// Rows after the row limit: `all` asks for as many as the API allows, else one more page
export type FetchRows = (result: RowsResult, offset: number, all: boolean) => Promise<RowsPage>
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ROW_H, columnWidth, compareCells, cut, isNum, rowMatches, toTsv, visibleRange } from '../grid.ts'
import { isPageable } from '../../../shared/pageable.ts'
import { copyText } from '../api.ts'

const props = defineProps<{ result: RowsResult; save?: SaveRows; fetchRows?: FetchRows }>()

// cells narrower than this get no copy button: it would hide their value
const COPY_MIN_WIDTH = 72
const INITIAL_MAX = 420 // automatic width of a column
const FIT_MAX = 800 // width after a double-click on its edge

const sort = reactive({ col: -1, dir: 1 })
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`)

function sortBy(i: number) {
  if (sort.col !== i) Object.assign(sort, { col: i, dir: 1 })
  else if (sort.dir > 0) sort.dir = -1
  else sort.col = -1
}

// ---- shown columns (hidden ones are left out of the grid, the filter and the copy) ----
const hidden = reactive(new Set<number>())
const cols = computed(() => props.result.columns.map((_, j) => j).filter((j) => !hidden.has(j)))
function toggleColumn(j: number) {
  if (hidden.has(j)) hidden.delete(j)
  else if (cols.value.length > 1) hidden.add(j) // keep at least one
}

// ---- quick filter (debounced: it scans every loaded row) ----
const filterText = ref('')
const filter = ref('')
let filterTimer: ReturnType<typeof setTimeout> | undefined
watch(filterText, (v) => {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => (filter.value = v.trim()), v ? 150 : 0)
})

// bumped when the result's rows (plain arrays, not reactive) change: saved values, rows loaded after the limit
const version = ref(0)
const rows = computed(() => {
  void version.value
  let list = props.result.rows.map((row, i) => ({ row, i }))
  if (filter.value) {
    const shownCols = cols.value
    list = list.filter((r) =>
      rowMatches(
        shownCols.map((j) => valueAt(r.i, j)),
        filter.value,
      ),
    )
  }
  if (sort.col < 0) return list
  const c = sort.col,
    d = sort.dir
  return list.toSorted((a, b) => compareCells(a.row[c], b.row[c], d))
})

// ---- virtual scrolling: only the rows on screen (and a margin) are in the DOM ----
const wrap = ref<HTMLElement>()
const scrollTop = ref(0)
const viewHeight = ref(800)
const range = computed(() => visibleRange(scrollTop.value, viewHeight.value, rows.value.length))
const shown = computed(() => rows.value.slice(range.value.start, range.value.end))
let observer: ResizeObserver | undefined
onMounted(() => {
  const measure = () => (viewHeight.value = wrap.value?.clientHeight || 800)
  measure()
  if (typeof ResizeObserver !== 'undefined' && wrap.value) {
    observer = new ResizeObserver(measure)
    observer.observe(wrap.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())

// ---- column widths ----
let charWidth = 0
function charW() {
  if (!charWidth) {
    const ctx = document.createElement('canvas').getContext?.('2d')
    if (ctx && wrap.value) {
      ctx.font = getComputedStyle(wrap.value).font || '13px monospace'
      charWidth = ctx.measureText('0'.repeat(100)).width / 100
    }
    charWidth ||= 7.8
  }
  return charWidth
}
const widthOf = (j: number, max: number) => {
  const c = props.result.columns[j]
  return columnWidth(
    c.name,
    c.type,
    props.result.rows.map((row) => row[j]),
    charW(),
    max,
  )
}
const widths = ref<number[]>([])
const numWidth = computed(() => Math.max(40, Math.round(String((void version.value, props.result.rows.length)).length * charW() + 18)))
const tableWidth = computed(() => numWidth.value + cols.value.reduce((a, j) => a + widths.value[j], 0))
const fit = (j: number) => (widths.value[j] = widthOf(j, FIT_MAX))

function startResize(j: number, e: MouseEvent) {
  const x0 = e.clientX,
    w0 = widths.value[j]
  const move = (ev: MouseEvent) => (widths.value[j] = Math.max(40, w0 + ev.clientX - x0))
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
  document.body.style.cursor = 'col-resize'
}

// ---- hover copy button ----
const hover = ref<string | null>(null)
const copiedCell = ref<string | null>(null)
function onHover(e: MouseEvent) {
  const td = (e.target as HTMLElement).closest?.('td[data-cell]') as HTMLElement | null
  hover.value = td?.dataset.cell ?? null
}
async function copyCell(i: number, j: number) {
  await copyText(String(valueAt(i, j)))
  const key = `${i}:${j}`
  copiedCell.value = key
  setTimeout(() => copiedCell.value === key && (copiedCell.value = null), 1200)
}

// ---- cell editing (rows from one table with its primary key) ----
const target = computed(() => (props.save ? props.result.editable : undefined))
const editableCol = (j: number) => target.value?.columns[j] != null
const pending = computed(() => {
  let m = pendingOf.get(props.result)
  if (!m) pendingOf.set(props.result, (m = reactive(new Map<string, Cell>())))
  return m
})
const changedRows = computed(() => new Set([...pending.value.keys()].map((k) => k.split(':')[0])).size)
const valueAt = (i: number, j: number): Cell => {
  const k = `${i}:${j}`
  return pending.value.has(k) ? pending.value.get(k)! : props.result.rows[i][j]
}
const classOf = (i: number, j: number) => {
  const v = valueAt(i, j)
  return { nul: v == null, num: isNum(v), dirty: pending.value.has(`${i}:${j}`), edit: editableCol(j) }
}
const same = (a: Cell, b: Cell) => (a == null || b == null ? a == b : String(a) === String(b))

function setValue(i: number, j: number, v: Cell) {
  const k = `${i}:${j}`
  if (same(v, props.result.rows[i][j])) pending.value.delete(k)
  else pending.value.set(k, v)
}

const inline = ref<{ i: number; j: number; text: string; wasNull: boolean } | null>(null)
const input = ref<HTMLInputElement[]>()
function commitInline() {
  const e = inline.value
  if (!e) return
  inline.value = null
  // an untouched NULL stays NULL (the full editor sets an empty string)
  if (!(e.wasNull && e.text === '')) setValue(e.i, e.j, e.text)
}

const cell = reactive({ open: false, name: '', value: '', isNull: false, edit: null as { i: number; j: number } | null })
function open(i: number, j: number, e: MouseEvent) {
  const v = valueAt(i, j)
  const name = props.result.columns[j].name
  if (!editableCol(j)) {
    let value = v == null ? 'NULL' : String(v)
    if (/^\s*[[{]/.test(value)) {
      try {
        value = JSON.stringify(JSON.parse(value), null, 2)
      } catch {}
    }
    return Object.assign(cell, { open: true, name, value, edit: null })
  }
  const text = v == null ? '' : String(v)
  if (e.shiftKey || /[\n\r]/.test(text) || text.length > 200)
    return Object.assign(cell, { open: true, name, value: text, isNull: v == null, edit: { i, j } })
  inline.value = { i, j, text, wasNull: v == null }
  void nextTick(() => {
    input.value?.[0]?.focus()
    input.value?.[0]?.select()
  })
}
function applyDialog() {
  if (cell.edit) setValue(cell.edit.i, cell.edit.j, cell.isNull ? null : cell.value)
  cell.open = false
}

function discard() {
  pending.value.clear()
}

const saving = ref(false)
async function saveChanges() {
  const t = target.value
  if (!t || !props.save) return
  const result = props.result
  const edits = [...pending.value].map(([k, v]) => {
    const [i, j] = k.split(':').map(Number)
    return { i, j, v }
  })
  const byRow = new Map<number, RowChange>()
  for (const { i, j, v } of edits) {
    let change = byRow.get(i)
    if (!change) {
      const key = Object.fromEntries(t.key.map((k) => [k, result.rows[i][t.columns.indexOf(k)]]))
      byRow.set(i, (change = { key, set: {} }))
    }
    change.set[t.columns[j]!] = v
  }
  saving.value = true
  try {
    await props.save(result, [...byRow.values()])
  } catch {
    return // the app reports the error; the edits stay pending
  } finally {
    saving.value = false
  }
  for (const { i, j, v } of edits) result.rows[i][j] = v
  pendingOf.get(result)?.clear()
  version.value++
}

// ---- rows after the row limit (read-only statements, run again from the offset) ----
const canLoadMore = computed(
  () => (void version.value, props.result.truncated) && !!props.fetchRows && !props.result.explain && isPageable(props.result.sql),
)
const loading = ref<'more' | 'all' | null>(null)
async function loadMore(all: boolean) {
  const result = props.result
  if (!props.fetchRows || loading.value) return
  loading.value = all ? 'all' : 'more'
  try {
    const page = await props.fetchRows(result, result.rows.length, all)
    for (const row of page.rows) result.rows.push(row)
    result.truncated = page.truncated
    if (page.total != null) result.total = page.total
    version.value++
  } catch {
    // the app reports the error
  } finally {
    loading.value = null
  }
}

// ---- TSV copy (as shown: filtered, sorted, shown columns, with pending edits) ----
const copied = ref(false)
async function copy() {
  await copyText(
    toTsv(
      cols.value.map((j) => props.result.columns[j]),
      rows.value.map((r) => cols.value.map((j) => valueAt(r.i, j))),
    ),
  )
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

// a new result (or another result tab): unsorted, at the top, widths fitted to its content
watch(
  () => props.result,
  (r, old) => {
    // the same columns (the query run again): keep the hidden ones and the filter
    const sameColumns = old && JSON.stringify(old.columns.map((c) => c.name)) === JSON.stringify(r.columns.map((c) => c.name))
    if (!sameColumns) {
      hidden.clear()
      filterText.value = filter.value = ''
    }
    sort.col = -1
    inline.value = null
    scrollTop.value = 0
    if (wrap.value) wrap.value.scrollTop = 0
    widths.value = props.result.columns.map((_, j) => widthOf(j, INITIAL_MAX))
  },
  { immediate: true },
)
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
  table-layout: fixed;
}
.grid th,
.grid td {
  border-right: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 2px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
  position: relative;
}
/* one line of exactly ROW_H px (24): 19 + 2 × 2 padding + 1 border */
.grid td {
  height: 24px;
  line-height: 19px;
  box-sizing: border-box;
}
.grid tr.pad td {
  padding: 0;
  border: 0;
  height: auto;
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
.filter {
  width: 180px;
  height: 26px;
  padding: 0 8px;
  border-radius: 4px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  color: rgb(var(--v-theme-on-surface));
  font-size: 12px;
  outline: none;
}
.filter:focus {
  border-color: rgb(var(--v-theme-primary));
}
.resizer {
  position: absolute;
  top: 0;
  right: 0;
  width: 6px;
  height: 100%;
  cursor: col-resize;
}
.resizer:hover {
  background: rgba(var(--v-theme-primary), 0.5);
}
.grid td.num {
  text-align: right;
}
.grid td.nul {
  opacity: 0.45;
  font-style: italic;
}
.grid td.dirty {
  background: rgba(var(--v-theme-warning), 0.18);
  opacity: 1;
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
.grid tbody tr:hover td:not(.dirty) {
  background: rgba(var(--v-theme-primary), 0.06);
}
.cell-input {
  position: absolute;
  inset: 0;
  width: 100%;
  padding: 0 7px;
  border: 1px solid rgb(var(--v-theme-primary));
  outline: none;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
  font-style: normal;
}
.cell-copy {
  position: absolute;
  top: 2px;
  right: 2px;
  height: 19px;
  width: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: rgb(var(--v-theme-surface-light));
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  opacity: 0.85;
  font-style: normal;
}
.cell-copy:hover {
  opacity: 1;
  color: rgb(var(--v-theme-primary));
}
.cell-full {
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60vh;
  overflow: auto;
}
</style>
