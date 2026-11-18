<template>
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="form.id ? 'Edit connection' : 'New connection'">
      <v-card-text>
        <v-btn-toggle v-model="form.type" mandatory color="primary" variant="outlined" divided class="mb-4">
          <v-btn value="postgres" prepend-icon="mdi-elephant">PostgreSQL</v-btn>
          <v-btn value="mariadb" prepend-icon="mdi-dolphin">MariaDB / MySQL</v-btn>
        </v-btn-toggle>
        <v-row dense>
          <v-col cols="12"
            ><v-text-field
              v-model="form.name"
              label="Name"
              :placeholder="`${form.user || 'user'}@${form.host || 'localhost'}`"
              persistent-placeholder
          /></v-col>
          <v-col cols="9"><v-text-field v-model="form.host" label="Host" /></v-col>
          <v-col cols="3"
            ><v-text-field v-model="form.port" label="Port" :placeholder="form.type === 'mariadb' ? '3306' : '5432'" persistent-placeholder
          /></v-col>
          <v-col cols="6"><v-text-field v-model="form.user" label="User" /></v-col>
          <v-col cols="6">
            <v-text-field
              v-model="form.password"
              label="Password"
              type="password"
              :placeholder="form.keepPassword ? '(unchanged)' : ''"
              persistent-placeholder
              autocomplete="new-password"
            />
          </v-col>
          <v-col cols="8"><v-text-field v-model="form.database" label="Default database (optional)" /></v-col>
          <v-col cols="4"><v-switch v-model="form.ssl" label="SSL" color="primary" hide-details /></v-col>
        </v-row>
        <v-alert v-if="status" :type="status.ok ? 'success' : 'error'" variant="tonal" class="mt-3 mono" density="compact">{{
          status.text
        }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-btn v-if="form.id" color="error" variant="text" @click="remove">Delete</v-btn>
        <v-spacer />
        <v-btn :loading="testing" @click="test">Test</v-btn>
        <v-btn @click="emit('update:modelValue', false)">Cancel</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" @click="save">Save</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { api } from '../api.ts'
import type { ConnectionForm, PublicConnection } from '../../../shared/types.ts'

const props = defineProps<{ modelValue: boolean; conn: PublicConnection | null }>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [PublicConnection]; deleted: [string] }>()

const blank = (): ConnectionForm & { id: string | null; type: string } => ({
  id: null,
  name: '',
  type: 'postgres',
  host: 'localhost',
  port: '',
  user: '',
  password: '',
  database: '',
  ssl: false,
  keepPassword: false,
})
const form = reactive(blank())
const status = ref<{ ok: boolean; text: string } | null>(null)
const testing = ref(false)
const saving = ref(false)

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    Object.assign(
      form,
      blank(),
      props.conn ? { ...props.conn, port: props.conn.port || '', password: '', keepPassword: props.conn.hasPassword } : {},
    )
    status.value = null
  },
)

async function test() {
  testing.value = true
  try {
    status.value = { ok: true, text: (await api.post<{ version: string }>('/connections/test', form)).version }
  } catch (e) {
    status.value = { ok: false, text: (e as Error).message }
  } finally {
    testing.value = false
  }
}
async function save() {
  saving.value = true
  try {
    emit('saved', await api.post<PublicConnection>('/connections', form))
    emit('update:modelValue', false)
  } catch (e) {
    status.value = { ok: false, text: (e as Error).message }
  } finally {
    saving.value = false
  }
}
async function remove() {
  if (!form.id || !confirm(`Delete the connection "${form.name}"?`)) return
  await api.del('/connections/' + form.id)
  emit('deleted', form.id)
  emit('update:modelValue', false)
}
</script>
