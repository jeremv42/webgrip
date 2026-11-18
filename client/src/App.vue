<template>
  <v-app>
    <v-app-bar flat border="b" height="52">
      <div class="d-flex align-center ga-2 px-3 w-100">
        <v-icon color="primary">mdi-database-search</v-icon>
        <strong class="mr-2">WebGrip</strong>

        <v-select
          v-model="connId"
          :items="connections"
          item-title="name"
          item-value="id"
          placeholder="Connexion"
          style="max-width: 240px"
          :prepend-inner-icon="conn?.type === 'mariadb' ? 'mdi-dolphin' : 'mdi-elephant'"
        >
          <template #item="{ props: p, item }">
            <v-list-item v-bind="p" :subtitle="`${item.type} · ${item.user}@${item.host}`" />
          </template>
        </v-select>
        <v-btn icon="mdi-pencil" size="small" variant="text" title="Modifier" :disabled="!conn" @click="openDialog(conn)" />
        <v-btn icon="mdi-plus" size="small" variant="text" title="Nouvelle connexion" @click="openDialog(null)" />

        <template v-if="info">
          <v-select v-model="db" :items="info.databases" placeholder="Base" style="max-width: 200px" prepend-inner-icon="mdi-database" />
          <v-select
            v-if="info.hasSchemas"
            v-model="schema"
            :items="schemas"
            placeholder="Schéma"
            style="max-width: 180px"
            prepend-inner-icon="mdi-folder-table-outline"
          />
        </template>

        <v-spacer />

        <v-select
          v-model="maxRows"
          :items="[100, 500, 1000, 5000, 20000]"
          style="max-width: 120px"
          title="Lignes max"
          prepend-inner-icon="mdi-format-list-numbered"
        />
        <v-btn
          color="success"
          variant="flat"
          prepend-icon="mdi-play"
          :disabled="!info || running"
          title="Ctrl+Entrée"
          @click="editor?.runCurrent()"
          >Exécuter</v-btn
        >
        <v-btn
          variant="tonal"
          prepend-icon="mdi-play-box-multiple"
          :disabled="!info || running"
          title="Ctrl+Maj+Entrée"
          @click="editor?.runAll()"
          >Tout</v-btn
        >
        <v-btn v-if="running" color="error" variant="tonal" prepend-icon="mdi-stop" @click="cancel">Annuler</v-btn>
        <v-btn
          icon="mdi-content-copy"
          size="small"
          variant="text"
          title="Copier la structure de la base (pour un chat)"
          :disabled="!info || copying"
          :loading="copying"
          @click="copySchema"
        />
        <v-btn :icon="dark ? 'mdi-weather-sunny' : 'mdi-weather-night'" variant="text" size="small" @click="toggleTheme" />
        <v-btn icon="mdi-logout" variant="text" size="small" title="Se déconnecter" @click="logout" />
      </div>
    </v-app-bar>

    <v-navigation-drawer permanent width="300">
      <DbTree
        v-if="info"
        :conn-id="connId"
        :info="info"
        :db="db"
        :schema="schema"
        @context="setContext"
        @open-table="openTable"
        @reload="loadInfo"
      />
      <div v-else class="pa-4 text-medium-emphasis">
        <template v-if="infoError"
          ><div class="text-error mb-2">{{ infoError }}</div></template
        >
        <template v-else-if="!connections.length"
          >Aucune connexion.<br /><v-btn class="mt-3" color="primary" prepend-icon="mdi-plus" @click="openDialog(null)"
            >Ajouter</v-btn
          ></template
        >
        <template v-else-if="connId">Connexion…</template>
      </div>
    </v-navigation-drawer>

    <v-main class="d-flex flex-column" style="height: 100vh">
      <EditorTabs v-model:active="tabState.active" :tabs="tabState.tabs" @add="addTab" @close="removeTab" @rename="renameTab" />
      <div :style="{ height: editorHeight + 'px' }" class="flex-grow-0 flex-shrink-0">
        <SqlEditor
          ref="editor"
          v-model="sqlText"
          :doc-id="tabState.active"
          :dialect="conn?.type"
          :completion="completion"
          :dark="dark"
          @run="run"
        />
      </div>
      <div class="splitter" @mousedown="startResize" />
      <div class="flex-grow-1" style="min-height: 0">
        <ResultPanel :results="results" :running="running && runTab === tabState.active" :active="activeResult" />
      </div>
    </v-main>

    <LoginDialog v-if="needLogin" @logged-in="onLoggedIn" />
    <ConnectionDialog v-model="dialog" :conn="editing" @saved="onSaved" @deleted="onDeleted" />
    <v-snackbar v-model="snack.open" :color="snack.color" timeout="6000">{{ snack.text }}</v-snackbar>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick, reactive, shallowReactive } from 'vue'
import { useTheme } from 'vuetify'
import { api, copyText, onUnauthorized, quoteIdent, store } from './api.ts'
import SqlEditor, { type RunRequest } from './components/SqlEditor.vue'
import DbTree, { type TableRef, type TreeContext } from './components/DbTree.vue'
import ResultPanel from './components/ResultPanel.vue'
import ConnectionDialog from './components/ConnectionDialog.vue'
import LoginDialog from './components/LoginDialog.vue'
import EditorTabs from './components/EditorTabs.vue'
import { closeTab, loadTabs, newTab, saveTabs, type TabState } from './tabs.ts'
import type { CompletionInfo, ConnectionInfo, PublicConnection, StatementResult } from '../../shared/types.ts'

const theme = useTheme()
const dark = computed(() => theme.global.current.value.dark)
function toggleTheme() {
  const name = dark.value ? 'light' : 'dark'
  theme.change(name)
  try {
    localStorage.setItem('webgrip.theme', name)
  } catch {}
}

const connections = ref<PublicConnection[]>([])
const connId = ref<string | null>(null)
const conn = computed(() => connections.value.find((c) => c.id === connId.value))
const info = ref<ConnectionInfo | null>(null)
const infoError = ref('')
const db = ref<string | null>(null)
const schema = ref<string | null>(null)
const schemas = ref<string[]>([])
const completion = ref<Partial<CompletionInfo>>({})
const running = ref(false)
const maxRows = ref(store.get('maxRows', 500))
const editor = ref<InstanceType<typeof SqlEditor>>()
const snack = reactive({ open: false, text: '', color: 'error' })
const notify = (e: unknown) => Object.assign(snack, { open: true, text: (e as Error).message || String(e), color: 'error' })
const flash = (text: string) => Object.assign(snack, { open: true, text, color: 'success' })

// Structure only (no rows): paste it in a chat to write or optimize a query.
const copying = ref(false)
async function copySchema() {
  copying.value = true
  try {
    const { markdown } = await api.get<{ markdown: string }>(`/c/${connId.value}/describe`, { db: db.value, schema: schema.value })
    await copyText(markdown)
    flash('Structure copiée dans le presse-papiers')
  } catch (e) {
    notify(e)
  } finally {
    copying.value = false
  }
}

watch(maxRows, (v) => store.set('maxRows', v))

// ---- connections ----
const dialog = ref(false)
const editing = ref<PublicConnection | null>(null)
function openDialog(c: PublicConnection | null | undefined) {
  editing.value = c ?? null
  dialog.value = true
}
function onSaved(c: PublicConnection) {
  const i = connections.value.findIndex((x) => x.id === c.id)
  if (i >= 0) connections.value.splice(i, 1, c)
  else connections.value.push(c)
  if (connId.value === c.id) loadInfo()
  else connId.value = c.id
}
function onDeleted(id: string) {
  connections.value = connections.value.filter((c) => c.id !== id)
  if (connId.value === id) connId.value = connections.value[0]?.id || null
}

// ---- login: any 401 (no session yet, or an expired one) shows the password dialog ----
const needLogin = ref(false)
onUnauthorized(() => {
  needLogin.value = true
})

async function loadConnections() {
  try {
    connections.value = await api.get<PublicConnection[]>('/connections')
  } catch (e) {
    if (!needLogin.value) notify(e)
    return
  }
  const last = store.get<string | null>('conn', null)
  const id = connections.value.some((c) => c.id === last) ? last : connections.value[0]?.id || null
  if (id === connId.value) loadInfo()
  else connId.value = id
}
onMounted(loadConnections)

function onLoggedIn() {
  needLogin.value = false
  void loadConnections()
}

async function logout() {
  try {
    await api.post('/logout')
  } catch {}
  needLogin.value = true
}

// ---- editor tabs, per connection (results stay in memory, per tab) ----
const tabState = ref<TabState>({ tabs: [newTab([])], active: '' })
tabState.value.active = tabState.value.tabs[0].id
const activeTab = computed(() => tabState.value.tabs.find((t) => t.id === tabState.value.active))
const sqlText = computed({
  get: () => activeTab.value?.sql ?? '',
  set: (v: string) => {
    if (activeTab.value) activeTab.value.sql = v
  },
})
const tabResults = shallowReactive(new Map<string, { results: StatementResult[]; active: number }>())
const results = computed(() => tabResults.get(tabState.value.active)?.results ?? [])
const activeResult = computed(() => tabResults.get(tabState.value.active)?.active ?? 0)

watch(
  tabState,
  (s) => {
    if (connId.value) saveTabs(connId.value, s)
  },
  { deep: true },
)
function addTab() {
  const t = newTab(tabState.value.tabs)
  tabState.value.tabs.push(t)
  tabState.value.active = t.id
}
function removeTab(id: string) {
  tabState.value = closeTab(tabState.value, id)
  tabResults.delete(id)
  void nextTick(() => editor.value?.forget(id)) // once the editor shows another tab
}
function renameTab(id: string, name: string) {
  const t = tabState.value.tabs.find((x) => x.id === id)
  if (t) t.name = name
}

watch(connId, (id) => {
  store.set('conn', id)
  if (id) tabState.value = loadTabs(id)
  loadInfo()
})

async function loadInfo() {
  info.value = null
  infoError.value = ''
  if (!connId.value) return
  const id = connId.value
  try {
    const i = await api.get<ConnectionInfo>(`/c/${id}/info`)
    if (id !== connId.value) return
    const ctx = store.get<{ db?: string | null; schema?: string | null }>('ctx.' + id, {})
    const prefer = [db.value, ctx.db, conn.value?.database, conn.value?.type === 'postgres' ? 'postgres' : null]
    db.value = prefer.find((d) => d && i.databases.includes(d)) || i.databases[0] || null
    if (i.hasSchemas) await loadSchemas(ctx.schema)
    else {
      schema.value = null
      schemas.value = []
    }
    info.value = i
  } catch (e) {
    infoError.value = (e as Error).message
  }
}

async function loadSchemas(prefer?: string | null) {
  schemas.value = await api.get<string[]>(`/c/${connId.value}/schemas`, { db: db.value })
  schema.value = [prefer, schema.value, 'public'].find((s) => s && schemas.value.includes(s)) || schemas.value[0] || null
}

watch(db, async (v, old) => {
  if (!info.value || v === old) return
  if (info.value.hasSchemas) {
    try {
      await loadSchemas(schema.value)
    } catch (e) {
      notify(e)
    }
  }
  loadCompletion()
})
watch(schema, () => loadCompletion())
watch([db, schema], () => connId.value && store.set('ctx.' + connId.value, { db: db.value, schema: schema.value }))

async function loadCompletion() {
  completion.value = {}
  if (!connId.value || !db.value) return
  try {
    completion.value = await api.get<CompletionInfo>(`/c/${connId.value}/completion`, { db: db.value, schema: schema.value })
  } catch {}
}
watch(info, (i) => i && loadCompletion())

function setContext(ctx: TreeContext) {
  db.value = ctx.db
  if (ctx.schema !== undefined)
    nextTick(() => {
      schema.value = ctx.schema ?? null
    })
}

// ---- running SQL ----
let runDb: string | null = null
const runTab = ref('') // the tab whose query is running: its results go there, even if another tab is shown meanwhile
async function run(
  { sql, offset }: RunRequest,
  ctx: { db: string | null; schema: string | null } = { db: db.value, schema: schema.value },
) {
  if (!sql.trim() || running.value || !connId.value) return
  running.value = true
  runDb = ctx.db
  const tabId = (runTab.value = tabState.value.active)
  try {
    const r = await api.post<{ results: StatementResult[] }>(`/c/${connId.value}/query`, {
      sql,
      db: ctx.db,
      schema: ctx.schema,
      maxRows: maxRows.value,
    })
    const errIdx = r.results.findIndex((x) => x.kind === 'error')
    tabResults.set(tabId, { results: r.results, active: errIdx >= 0 ? errIdx : 0 })
    const err = r.results[errIdx]
    if (err?.kind === 'error' && err.error.position && tabId === tabState.value.active)
      editor.value?.setCursor(offset + err.start + err.error.position - 1)
    // DDL may have changed the tree / completion
    if (r.results.some((x) => x.kind === 'command' && /^(CREATE|DROP|ALTER|RENAME)/i.test(x.command || x.sql))) void loadCompletion()
  } catch (e) {
    notify(e)
  } finally {
    running.value = false
  }
}

async function cancel() {
  try {
    await api.post(`/c/${connId.value}/cancel`, { db: runDb })
  } catch (e) {
    notify(e)
  }
}

function openTable({ db: d, schema: s, table }: TableRef) {
  if (!editor.value || !conn.value) return
  const dialect = conn.value.type
  const name = (s ? quoteIdent(s, dialect) + '.' : '') + quoteIdent(table, dialect)
  const sql = `SELECT * FROM ${name} LIMIT ${maxRows.value};`
  const offset = editor.value.append(sql)
  void run({ sql, offset }, { db: d, schema: s ?? schema.value })
}

// ---- editor / results splitter ----
const editorHeight = ref(store.get('editorHeight', 260))
function startResize(e: MouseEvent) {
  const y0 = e.clientY,
    h0 = editorHeight.value
  const move = (ev: MouseEvent) => {
    editorHeight.value = Math.max(80, Math.min(window.innerHeight - 160, h0 + ev.clientY - y0))
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    store.set('editorHeight', editorHeight.value)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
  e.preventDefault()
}
</script>
