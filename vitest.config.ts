import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Separate from vite.config.ts, whose root is client/: the tests live next to the code of client/ and shared/
// (the server's are in Rust: cargo test).
export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['{client,shared}/**/*.test.ts'],
    environment: 'node',
    // Vuetify ships CSS imports: let Vite transform it in component tests
    server: { deps: { inline: ['vuetify'] } },
  },
})
