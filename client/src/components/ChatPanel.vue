<template>
  <div class="chat d-flex flex-column h-100">
    <div class="d-flex align-center px-3 py-1 ga-1 border-b flex-none">
      <v-icon size="small" color="primary">mdi-creation</v-icon>
      <strong class="text-body-2">Claude</strong>
      <span class="text-caption text-medium-emphasis text-truncate ml-1">{{ where }}</span>
      <v-spacer />
      <v-btn
        icon="mdi-plus-circle-outline"
        size="small"
        variant="text"
        title="New conversation"
        :disabled="busy || !conv.messages.length"
        @click="reset"
      />
      <v-btn icon="mdi-close" size="small" variant="text" title="Close" @click="emit('close')" />
    </div>

    <div ref="scroller" class="chat-messages flex-grow-1 px-3 py-2" @click="onClick" @scroll="onScroll">
      <div v-if="!conv.messages.length" class="text-medium-emphasis text-body-2 mt-2">
        Ask about the structure or the data of
        <strong>{{ where || 'the selected database' }}</strong
        >, or for a query. SQL blocks have an <em>Insert</em> button.
        <p v-if="runQuery" class="mt-2">
          Claude reads the structure and runs read-only queries itself, so it sees the rows they return. It never changes anything.
        </p>
        <p v-else class="mt-2">
          Claude only sees the structure (tables, columns, keys, indexes), never a row. To show it data, run a query and
          <v-icon size="x-small">mdi-paperclip</v-icon> attach its result: you see and can edit what is sent.
        </p>
      </div>
      <template v-for="(m, i) in conv.messages" :key="i">
        <div v-if="m.role === 'user'" class="chat-user mb-3">{{ m.text }}</div>
        <div v-else class="mb-4">
          <template v-for="(p, j) in m.parts" :key="j">
            <!-- sanitized by DOMPurify (renderMarkdown) -->
            <div v-if="p.kind === 'text'" class="chat-md" v-html="renderMarkdown(p.text)" />
            <details v-else class="chat-tool mb-2">
              <summary>
                <v-icon size="x-small" :color="p.error ? 'error' : undefined">{{
                  p.result === undefined ? 'mdi-progress-clock' : p.error ? 'mdi-alert-circle-outline' : 'mdi-check'
                }}</v-icon>
                {{ toolLabel(p) }}
                <code v-if="typeof p.input.sql === 'string'" class="chat-tool-sql">{{ p.input.sql }}</code>
              </summary>
              <pre v-if="typeof p.input.sql === 'string'" class="chat-pre">{{ p.input.sql }}</pre>
              <pre v-if="p.result !== undefined" class="chat-pre" :class="{ 'text-error': p.error }">{{ p.result }}</pre>
            </details>
          </template>
          <div v-if="!m.done && i === conv.messages.length - 1" class="text-medium-emphasis text-caption">
            <v-progress-circular indeterminate size="12" width="2" class="mr-1" />Thinking…
          </div>
          <div v-if="m.error" class="text-error text-body-2 chat-error">{{ m.error }}</div>
        </div>
      </template>
    </div>

    <div class="pa-2 border-t flex-none">
      <v-textarea
        ref="input"
        v-model="draft"
        variant="outlined"
        density="compact"
        rows="2"
        max-rows="10"
        auto-grow
        hide-details
        placeholder="Ask Claude… (Enter to send, Shift+Enter for a new line)"
        :disabled="!connId"
        @keydown.enter.exact.prevent="send"
      >
        <template #append-inner>
          <v-btn
            icon="mdi-paperclip"
            size="small"
            variant="text"
            :title="
              result ? 'Attach the result shown below to the message (you can edit it before sending)' : 'Run a query to attach its result'
            "
            :disabled="!result || busy"
            @click="attach"
          />
          <v-btn v-if="busy" icon="mdi-stop" size="small" variant="text" color="error" title="Stop" @click="stop" />
          <v-btn
            v-else
            icon="mdi-send"
            size="small"
            variant="text"
            color="primary"
            title="Send (Enter)"
            :disabled="!draft.trim() || !connId"
            @click="send"
          />
        </template>
      </v-textarea>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { copyText, postStream, store } from '../api.ts'
import { applyEvent, attachText, MAX_KEPT, renderMarkdown, toolLabel, type ChatMessage, type Conversation } from '../chat.ts'
import type { ChatEvent, ChatRequest, StatementResult } from '../../../shared/types.ts'

const props = defineProps<{
  connId: string | null
  db: string | null
  schema: string | null
  hasSchemas: boolean
  // Claude may run queries itself (else it only sees what the user attaches)
  runQuery: boolean
  // the result shown in the result panel, which the user may attach
  result?: StatementResult
}>()
const emit = defineEmits<{ insert: [sql: string]; close: []; error: [e: unknown] }>()

// replaced (not mutated) when the connection changes: a running answer keeps writing to its own conversation
const conv = ref<Conversation>({ messages: [] })
const draft = ref('')
const busy = ref(false)
const scroller = ref<HTMLElement>()
let abort: AbortController | null = null
let stick = true // follow the end of the conversation, unless the user scrolled up

const where = computed(() => [props.db, props.hasSchemas ? props.schema : null].filter(Boolean).join('.'))

// one conversation per connection, kept in localStorage
const key = (id: string) => 'chat.' + id
function load(id: string | null) {
  const saved = id ? store.get<Conversation>(key(id), { messages: [] }) : { messages: [] }
  // an answer interrupted by a reload is over
  for (const m of saved.messages) if (m.role === 'assistant') m.done = true
  conv.value = saved
  stick = true
  scrollDown()
}
function persist(id: string | null, c: Conversation) {
  if (id) store.set(key(id), { sessionId: c.sessionId, messages: c.messages.slice(-MAX_KEPT) })
}
watch(
  () => props.connId,
  (id) => {
    stop() // the running answer is saved with its own connection
    load(id)
  },
  { immediate: true },
)

function scrollDown() {
  void nextTick(() => {
    if (stick && scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  })
}
function onScroll() {
  const el = scroller.value!
  stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

async function send() {
  const message = draft.value.trim()
  const id = props.connId
  if (!message || busy.value || !id) return
  draft.value = ''
  busy.value = true
  stick = true
  const c = conv.value
  c.messages.push({ role: 'user', text: message })
  c.messages.push({ role: 'assistant', parts: [], done: false })
  const answer = c.messages.at(-1) as Extract<ChatMessage, { role: 'assistant' }>
  scrollDown()
  abort = new AbortController()
  const body: ChatRequest = { message, sessionId: c.sessionId, db: props.db, schema: props.schema }
  try {
    await postStream<ChatEvent>(
      `/c/${id}/chat`,
      body,
      (e) => {
        applyEvent(c, e)
        if (c === conv.value) scrollDown()
      },
      abort.signal,
    )
    if (!answer.done) answer.error = 'The answer was cut off'
  } catch (e) {
    if ((e as Error).name !== 'AbortError') answer.error = (e as Error).message
  } finally {
    answer.done = true
    busy.value = false
    abort = null
    persist(id, c)
  }
}

const input = ref<{ focus: () => void }>()
function attach() {
  if (!props.result) return
  const text = attachText(props.result)
  draft.value = draft.value.trim() ? draft.value.trimEnd() + '\n\n' + text : text + '\n\n'
  input.value?.focus()
}

function stop() {
  abort?.abort()
}

function reset() {
  conv.value = { messages: [] }
  persist(props.connId, conv.value)
}

// Insert / Copy buttons of the code blocks (rendered HTML)
async function onClick(ev: MouseEvent) {
  const button = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
  const code = button?.closest('.chat-code')?.querySelector('code')?.textContent
  if (!button || code == null) return
  if (button.dataset.act === 'insert') emit('insert', code.replace(/\n$/, ''))
  else
    try {
      await copyText(code)
      button.textContent = 'Copied'
      setTimeout(() => (button.textContent = 'Copy'), 1500)
    } catch (e) {
      emit('error', e)
    }
}
</script>

<style scoped>
.chat-messages {
  overflow-y: auto;
  min-height: 0;
  font-size: 14px;
  line-height: 1.5;
}
.chat-user {
  white-space: pre-wrap;
  background: rgba(var(--v-theme-primary), 0.08);
  border-radius: 8px;
  padding: 6px 10px;
}
.chat-error {
  white-space: pre-wrap;
}
.chat-tool {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.chat-tool summary {
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat-tool-sql {
  opacity: 0.8;
}
.chat-pre {
  font-family: ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
  margin: 4px 0 4px 16px;
  padding: 4px 8px;
  border-left: 2px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.chat-md :deep(p),
.chat-md :deep(ul),
.chat-md :deep(ol),
.chat-md :deep(table) {
  margin: 0 0 8px;
}
.chat-md :deep(ul),
.chat-md :deep(ol) {
  padding-left: 20px;
}
.chat-md :deep(h1),
.chat-md :deep(h2),
.chat-md :deep(h3) {
  font-size: 15px;
  margin: 10px 0 6px;
}
.chat-md :deep(code) {
  font-family: ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 12.5px;
}
.chat-md :deep(:not(pre) > code) {
  background: rgba(var(--v-theme-on-surface), 0.07);
  border-radius: 4px;
  padding: 0 3px;
}
.chat-md :deep(table) {
  border-collapse: collapse;
  font-size: 13px;
  display: block;
  overflow-x: auto;
}
.chat-md :deep(th),
.chat-md :deep(td) {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 2px 6px;
}
.chat-md :deep(.chat-code) {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 6px;
  margin: 0 0 8px;
  overflow: hidden;
}
.chat-md :deep(.chat-code-bar) {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 2px 8px;
  font-size: 12px;
  background: rgba(var(--v-theme-on-surface), 0.05);
}
.chat-md :deep(.chat-code-bar span) {
  flex: 1;
  opacity: 0.7;
}
.chat-md :deep(.chat-code-bar button) {
  color: rgb(var(--v-theme-primary));
  font-weight: 500;
}
.chat-md :deep(.chat-code-bar button:hover) {
  text-decoration: underline;
}
.chat-md :deep(pre) {
  margin: 0;
  padding: 6px 8px;
  overflow-x: auto;
}
</style>
