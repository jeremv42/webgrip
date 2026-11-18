<template>
  <div class="editor-tabs d-flex align-center">
    <v-tabs
      :model-value="active"
      density="compact"
      show-arrows
      height="32"
      class="flex-grow-0"
      style="min-width: 0"
      @update:model-value="select"
    >
      <v-tab
        v-for="t in tabs"
        :key="t.id"
        :value="t.id"
        class="text-none tab"
        title="Double-click: rename · middle click: close"
        @dblclick="startRename(t)"
        @mousedown.middle.prevent="close(t)"
      >
        <v-icon size="14" class="mr-1">mdi-console-line</v-icon>
        {{ t.name }}
        <v-icon size="14" class="ml-2 close" title="Close" @click.stop="close(t)">mdi-close</v-icon>
      </v-tab>
    </v-tabs>
    <v-btn icon="mdi-plus" size="x-small" variant="text" class="ml-1" title="New tab" @click="emit('add')" />

    <v-dialog v-model="renaming" max-width="340">
      <v-card title="Rename tab">
        <v-form @submit.prevent="rename">
          <v-card-text><v-text-field v-model="newName" label="Name" autofocus /></v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="renaming = false">Cancel</v-btn>
            <v-btn type="submit" color="primary" variant="flat" :disabled="!newName.trim()">Rename</v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { EditorTab } from '../tabs.ts'

const props = defineProps<{ tabs: EditorTab[] }>()
const active = defineModel<string>('active', { required: true })
const emit = defineEmits<{ add: []; close: [id: string]; rename: [id: string, name: string] }>()

// v-tabs also reports the id of a tab that has just disappeared (when the list is replaced): ignore it
function select(id: unknown) {
  if (props.tabs.some((t) => t.id === id)) active.value = id as string
}

// closing loses the tab's text: ask first when there is some
function close(t: EditorTab) {
  if (t.sql.trim() && !confirm(`Close "${t.name}"? Its content will be lost.`)) return
  emit('close', t.id)
}

const renaming = ref(false)
const newName = ref('')
let renamed = ''
function startRename(t: EditorTab) {
  renamed = t.id
  newName.value = t.name
  renaming.value = true
}
function rename() {
  emit('rename', renamed, newName.value.trim())
  renaming.value = false
}
</script>

<style scoped>
.editor-tabs {
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  flex: none;
}
.tab {
  font-size: 13px;
}
.close {
  opacity: 0.4;
}
.close:hover {
  opacity: 1;
}
</style>
