<template>
  <div class="d-flex flex-column h-100">
    <v-progress-linear :active="running" indeterminate color="primary" height="2" />
    <div v-if="!results.length" class="d-flex align-center justify-center flex-grow-1 text-medium-emphasis">
      {{ running ? 'Exécution…' : 'Ctrl+Entrée : requête sous le curseur (ou sélection) · Ctrl+Maj+Entrée : tout le script' }}
    </div>
    <template v-else>
      <v-tabs v-model="tab" density="compact" show-arrows class="flex-grow-0 flex-shrink-0 tabs">
        <v-tab v-for="(r, i) in results" :key="i" :value="i" :title="r.sql" class="text-none">
          <v-icon size="16" :color="iconFor(r)[1]" class="mr-1">{{ iconFor(r)[0] }}</v-icon>
          <span class="mono tab-label">{{ label(r) }}</span>
        </v-tab>
      </v-tabs>
      <div v-if="current" class="flex-grow-1" style="min-height: 0">
        <ResultGrid v-if="current.kind === 'rows'" :result="current" />
        <div v-else class="pa-4 overflow-auto h-100">
          <v-alert v-if="current.kind === 'error'" type="error" variant="tonal" class="mono">
            <div style="white-space: pre-wrap">{{ current.error.message }}</div>
            <div v-if="current.error.detail" class="mt-2">DETAIL: {{ current.error.detail }}</div>
            <div v-if="current.error.hint">HINT: {{ current.error.hint }}</div>
            <div v-if="current.error.code" class="mt-2 text-medium-emphasis">code {{ current.error.code }}</div>
          </v-alert>
          <div v-else-if="current.kind === 'skipped'" class="text-medium-emphasis">Non exécutée : une requête précédente a échoué.</div>
          <div v-else class="mono">
            <v-icon color="success" class="mr-1">mdi-check-circle</v-icon>
            {{ current.command }}
            <template v-if="current.affected != null"> — {{ current.affected }} ligne(s) affectée(s)</template>
            <span v-if="current.info" class="text-medium-emphasis"> ({{ current.info }})</span>
          </div>
          <pre class="mono mt-3 text-medium-emphasis" style="white-space: pre-wrap">{{ current.sql }}</pre>
          <div v-if="current.ms != null" class="text-medium-emphasis mt-2">{{ Math.round(current.ms) }} ms</div>
        </div>
      </div>
      <div v-if="current?.notices?.length" class="notices mono">
        <div v-for="(n, i) in current.notices" :key="i">{{ n }}</div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import ResultGrid from './ResultGrid.vue'

const props = defineProps({ results: Array, running: Boolean, active: Number })
const tab = ref(0)
watch(() => props.results, () => { tab.value = props.active ?? 0 })
const current = computed(() => props.results[tab.value])

const iconFor = (r) => ({
  rows: ['mdi-table', 'primary'],
  command: ['mdi-check', 'success'],
  error: ['mdi-alert-circle', 'error'],
  skipped: ['mdi-debug-step-over', 'grey'],
}[r.kind])
const label = (r) => {
  const s = r.sql.replace(/\s+/g, ' ')
  return s.length > 28 ? s.slice(0, 28) + '…' : s
}
</script>

<style scoped>
.tabs { border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.tab-label { font-size: 12px; }
.notices { max-height: 90px; overflow: auto; padding: 4px 8px; font-size: 12px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); opacity: 0.8; }
</style>
