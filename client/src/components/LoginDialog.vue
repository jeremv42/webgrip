<template>
  <v-dialog :model-value="true" persistent max-width="360">
    <v-card title="WebGrip" prepend-icon="mdi-lock">
      <v-form @submit.prevent="submit">
        <v-card-text>
          <v-text-field
            v-model="password"
            type="password"
            label="Password"
            autocomplete="current-password"
            autofocus
            :error-messages="error"
            :disabled="busy"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn type="submit" color="primary" variant="flat" :loading="busy" :disabled="!password">Log in</v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../api.ts'

const emit = defineEmits<{ 'logged-in': [] }>()
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await api.post('/login', { password: password.value })
    emit('logged-in')
  } catch (e) {
    error.value = (e as Error).message
    password.value = ''
  } finally {
    busy.value = false
  }
}
</script>
