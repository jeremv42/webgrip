import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import './style.css'
import App from './App.vue'

let theme = 'light'
try { theme = localStorage.getItem('webgrip.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') } catch {}

const vuetify = createVuetify({
  theme: { defaultTheme: theme },
  defaults: {
    global: { density: 'compact' },
    VTextField: { variant: 'outlined', hideDetails: 'auto' },
    VSelect: { variant: 'outlined', hideDetails: true },
  },
})

createApp(App).use(vuetify).mount('#app')
