<template>
  <div class="d-flex flex-column h-100">
    <div class="d-flex align-center pa-2 ga-1">
      <v-text-field v-model="filter" placeholder="Filtrer les tables" prepend-inner-icon="mdi-magnify" clearable hide-details density="compact" />
      <v-btn icon="mdi-refresh" variant="text" size="small" title="Rafraîchir" @click="reload" />
    </div>
    <div class="tree mono flex-grow-1">
      <div
        v-for="{ n, depth } in flat"
        :key="n.key"
        class="node"
        :class="{ active: isActive(n) }"
        :style="{ paddingLeft: 6 + depth * 14 + 'px' }"
        :title="n.title || n.label"
        @click="click(n)"
        @dblclick="dblclick(n)"
      >
        <v-icon size="14" class="chevron" :style="{ visibility: n.leaf ? 'hidden' : 'visible' }">
          {{ n.loading ? 'mdi-loading mdi-spin' : n.open ? 'mdi-chevron-down' : 'mdi-chevron-right' }}
        </v-icon>
        <v-icon size="16" :color="n.color" class="mr-1">{{ n.icon }}</v-icon>
        <span class="label">{{ n.label }}</span>
        <span v-if="n.hint" class="hint">{{ n.hint }}</span>
      </div>
      <div v-if="error" class="text-error pa-2">{{ error }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { api } from '../api.js'

const props = defineProps({
  connId: String,
  info: Object, // { hasSchemas, databases }
  db: String,
  schema: String,
})
const emit = defineEmits(['context', 'open-table', 'reload'])

const roots = ref([])
const filter = ref('')
const error = ref('')

const icons = {
  database: ['mdi-database', 'amber-darken-2'],
  schema: ['mdi-folder-table-outline', 'blue-grey'],
  table: ['mdi-table', 'primary'],
  view: ['mdi-table-eye', 'teal'],
  matview: ['mdi-table-eye', 'deep-purple'],
  foreign: ['mdi-table-network', 'brown'],
}
const node = (kind, label, extra = {}) => {
  const [icon, color] = icons[extra.type || kind] || ['mdi-circle-small', undefined]
  return { key: extra.key, kind, label, icon, color, open: false, loading: false, children: null, leaf: false, ...extra }
}

function build() {
  error.value = ''
  roots.value = (props.info?.databases || []).map((db) => node('database', db, { key: 'd:' + db, db }))
  // expand the current database (and schema) so the user lands on its tables
  const cur = roots.value.find((r) => r.db === props.db)
  if (cur) toggle(cur, true).then(() => {
    const sc = cur.children?.find((c) => c.kind === 'schema' && c.schema === props.schema)
    if (sc) toggle(sc, true)
  })
}
watch(() => [props.connId, props.info], build, { immediate: true })

async function loadChildren(n) {
  const id = props.connId
  if (n.kind === 'database' && props.info.hasSchemas) {
    const list = await api.get(`/c/${id}/schemas`, { db: n.db })
    return list.map((s) => node('schema', s, { key: `${n.key}/s:${s}`, db: n.db, schema: s }))
  }
  if (n.kind === 'database' || n.kind === 'schema') {
    const list = await api.get(`/c/${id}/tables`, { db: n.db, schema: n.schema })
    if (!list.length) return [node('empty', '(aucune table)', { key: n.key + '/empty', leaf: true, icon: '' })]
    return list.map((t) => node('table', t.name, { key: `${n.key}/t:${t.name}`, db: n.db, schema: n.schema, table: t.name, type: t.type }))
  }
  if (n.kind === 'table') {
    const cols = await api.get(`/c/${id}/columns`, { db: n.db, schema: n.schema, table: n.table })
    return cols.map((c) => node('column', c.name, {
      key: `${n.key}/c:${c.name}`, leaf: true,
      icon: c.pk ? 'mdi-key' : 'mdi-table-column', color: c.pk ? 'amber-darken-2' : 'grey',
      hint: c.type + (c.notnull ? ' not null' : ''),
    }))
  }
  return []
}

async function toggle(n, force) {
  if (n.leaf) return
  n.open = force ?? !n.open
  if (n.open && !n.children) {
    n.loading = true
    try { n.children = await loadChildren(n) } catch (e) { error.value = e.message; n.open = false } finally { n.loading = false }
  }
}

function click(n) {
  toggle(n)
  if (n.kind === 'database') emit('context', { db: n.db, schema: props.info.hasSchemas ? undefined : null })
  if (n.kind === 'schema') emit('context', { db: n.db, schema: n.schema })
}
function dblclick(n) {
  if (n.kind === 'table') emit('open-table', { db: n.db, schema: n.schema, table: n.table })
}

const isActive = (n) => (n.kind === 'database' && n.db === props.db && !props.info.hasSchemas) ||
  (n.kind === 'schema' && n.db === props.db && n.schema === props.schema)

const flat = computed(() => {
  const f = (filter.value || '').toLowerCase()
  const out = []
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (f && n.kind === 'table' && !n.label.toLowerCase().includes(f)) continue
      out.push({ n, depth })
      if (n.open && n.children) walk(n.children, depth + 1)
    }
  }
  walk(roots.value, 0)
  return out
})

// the parent refetches `info`, which rebuilds the tree through the watcher above
const reload = () => emit('reload')
</script>

<style scoped>
.tree { overflow: auto; user-select: none; padding-bottom: 8px; }
.node { display: flex; align-items: center; white-space: nowrap; cursor: pointer; height: 24px; padding-right: 8px; }
.node:hover { background: rgba(var(--v-theme-on-surface), 0.06); }
.node.active { background: rgba(var(--v-theme-primary), 0.14); }
.chevron { margin-right: 2px; opacity: 0.7; }
.label { flex: none; }
.hint { margin-left: 8px; opacity: 0.55; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
</style>
