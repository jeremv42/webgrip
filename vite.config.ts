import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

// The backend only listens on 127.0.0.1; Vite serves the SPA and proxies /api to it,
// so the whole app is reached through a single port (dev and preview).
const port = Number(process.env.WEB_PORT || 5180)
const proxy = { '/api': `http://127.0.0.1:${process.env.PORT || 3070}` }

// The dev server listens on the Tailscale address (and never on the other interfaces).
const tailscaleIp = os.networkInterfaces().tailscale0?.find((a) => a.family === 'IPv4')?.address

// Vite binds a single address: keep http://localhost:<port> working by forwarding it to the Tailscale one.
const localhostForward = (): Plugin => ({
  name: 'localhost-forward',
  apply: 'serve',
  configureServer(server) {
    if (!tailscaleIp || !server.httpServer) return
    const fwd = net.createServer((client) => {
      const upstream = net.connect(port, tailscaleIp)
      client.pipe(upstream).pipe(client)
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
    })
    server.httpServer.once('listening', () => fwd.listen(port, '127.0.0.1'))
    server.httpServer.once('close', () => fwd.close())
  },
})

// monaco-sql-languages still imports Monaco through its pre-0.53 paths, that the package exports no longer map.
const monacoEsm = fileURLToPath(new URL('./node_modules/monaco-editor/esm/vs/', import.meta.url))

export default defineConfig({
  root: 'client',
  resolve: {
    alias: [
      { find: /^monaco-editor$/, replacement: monacoEsm + 'editor/editor.api.js' }, // the API only, not every language
      { find: /^monaco-editor\/esm\/vs\/(.+?)(\.js)?$/, replacement: monacoEsm + '$1.js' },
    ],
  },
  worker: { format: 'es' },
  plugins: [vue(), vuetify({ autoImport: true }), localhostForward()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    host: tailscaleIp || 'localhost',
    port,
    strictPort: true,
    allowedHosts: [os.hostname(), '.ts.net'], // MagicDNS names: short (machine) and full (machine.tailnet.ts.net)
    proxy,
    fs: { allow: ['..'] },
  },
  preview: { port, strictPort: true, proxy },
})
