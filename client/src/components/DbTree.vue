<template>
  <div class="d-flex flex-column h-100">
    <div class="d-flex align-center pa-2 ga-1">
      <v-text-field
        v-model="filter"
        placeholder="Filter tables"
        prepend-inner-icon="mdi-magnify"
        clearable
        hide-details
        density="compact"
      />
      <v-btn icon="mdi-refresh" variant="text" size="small" title="Refresh" @click="reload" />
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

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { api } from '../api.ts'
import type { ColumnInfo, ConnectionInfo, TableInfo } from '../../../shared/types.ts'

export interface TreeContext {
  db: string
  // undefined = keep the current schema (Postgres database node)
  schema?: string | null
}
export interface TableRef {
  db: string
  schema?: string
  table: string
}

const props = defineProps<{ connId: string | null; info: ConnectionInfo; db: string | null; schema: string | null }>()
const emit = defineEmits<{ context: [TreeContext]; 'open-table': [TableRef]; reload: [] }>()

type Kind = 'database' | 'schema' | 'table' | 'column' | 'empty'
interface TreeNode {
  key: string
  kind: Kind
  label: string
  icon: string
  color?: string
  open: boolean
  loading: boolean
  children: TreeNode[] | null
  leaf: boolean
  db: string
  schema?: string
  table?: string
  type?: string
  hint?: string
  title?: string
}

const roots = ref<TreeNode[]>([])
const filter = ref('')
const error = ref('')

const icons: Record<string, [string, string]> = {
  database: ['mdi-database', 'amber-darken-2'],
  schema: ['mdi-folder-table-outline', 'blue-grey'],
  table: ['mdi-table', 'primary'],
  view: ['mdi-table-eye', 'teal'],
  matview: ['mdi-table-eye', 'deep-purple'],
  foreign: ['mdi-table-network', 'brown'],
}
const node = (kind: Kind, label: string, extra: Partial<TreeNode> & { key: string; db: string }): TreeNode => {
  const [icon, color] = icons[extra.type || kind] || ['mdi-circle-small', undefined]
  return { kind, label, icon, color, open: false, loading: false, children: null, leaf: false, ...extra }
}

async function build() {
  error.value = ''
  roots.value = (props.info?.databases || []).map((db) => node('database', db, { key: 'd:' + db, db }))
  // expand the current database (and schema) so the user lands on its tables
  const cur = roots.value.find((r) => r.db === props.db)
  if (!cur) return
  await toggle(cur, true)
  const sc = cur.children?.find((c) => c.kind === 'schema' && c.schema === props.schema)
  if (sc) await toggle(sc, true)
}
watch(() => [props.connId, props.info], build, { immediate: true })

async function loadChildren(n: TreeNode): Promise<TreeNode[]> {
  const id = props.connId
  if (n.kind === 'database' && props.info.hasSchemas) {
    const list = await api.get<string[]>(`/c/${id}/schemas`, { db: n.db })
    return list.map((s) => node('schema', s, { key: `${n.key}/s:${s}`, db: n.db, schema: s }))
  }
  if (n.kind === 'database' || n.kind === 'schema') {
    const list = await api.get<TableInfo[]>(`/c/${id}/tables`, { db: n.db, schema: n.schema })
    if (!list.length) return [node('empty', '(no tables)', { key: n.key + '/empty', db: n.db, leaf: true, icon: '' })]
    return list.map((t) => node('table', t.name, { key: `${n.key}/t:${t.name}`, db: n.db, schema: n.schema, table: t.name, type: t.type }))
  }
  if (n.kind === 'table') {
    const cols = await api.get<ColumnInfo[]>(`/c/${id}/columns`, { db: n.db, schema: n.schema, table: n.table })
    return cols.map((c) =>
      node('column', c.name, {
        key: `${n.key}/c:${c.name}`,
        db: n.db,
        leaf: true,
        icon: c.pk ? 'mdi-key' : 'mdi-table-column',
        color: c.pk ? 'amber-darken-2' : 'grey',
        hint: c.type + (c.notnull ? ' not null' : ''),
      }),
    )
  }
  return []
}

async function toggle(n: TreeNode, force?: boolean) {
  if (n.leaf) return
  n.open = force ?? !n.open
  if (n.open && !n.children) {
    n.loading = true
    try {
      n.children = await loadChildren(n)
    } catch (e) {
      error.value = (e as Error).message
      n.open = false
    } finally {
      n.loading = false
    }
  }
}

function click(n: TreeNode) {
  void toggle(n)
  if (n.kind === 'database') emit('context', { db: n.db, schema: props.info.hasSchemas ? undefined : null })
  if (n.kind === 'schema') emit('context', { db: n.db, schema: n.schema })
}
function dblclick(n: TreeNode) {
  if (n.kind === 'table' && n.table) emit('open-table', { db: n.db, schema: n.schema, table: n.table })
}

const isActive = (n: TreeNode) =>
  (n.kind === 'database' && n.db === props.db && !props.info.hasSchemas) ||
  (n.kind === 'schema' && n.db === props.db && n.schema === props.schema)

const flat = computed(() => {
  const f = (filter.value || '').toLowerCase()
  const out: { n: TreeNode; depth: number }[] = []
  const walk = (nodes: TreeNode[], depth: number) => {
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
.tree {
  overflow: auto;
  user-select: none;
  padding-bottom: 8px;
}
.node {
  display: flex;
  align-items: center;
  white-space: nowrap;
  cursor: pointer;
  height: 24px;
  padding-right: 8px;
}
.node:hover {
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.node.active {
  background: rgba(var(--v-theme-primary), 0.14);
}
.chevron {
  margin-right: 2px;
  opacity: 0.7;
}
.label {
  flex: none;
}
.hint {
  margin-left: 8px;
  opacity: 0.55;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
