import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Separate from vite.config.ts, whose root is client/: the tests live next to the code of client/, server/ and shared/.
export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['{client,server,shared}/**/*.test.ts'],
    environment: 'node',
    // Vuetify ships CSS imports: let Vite transform it in component tests
    server: { deps: { inline: ['vuetify'] } },
  },
})
