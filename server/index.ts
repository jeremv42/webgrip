import path from 'node:path'
import { createApp } from './app.ts'

const root = path.resolve(import.meta.dirname, '..')
// .env (optional, ignored by git): WEBGRIP_PASSWORD, WEBGRIP_SECRET... Variables already set win.
try {
  process.loadEnvFile(path.join(root, '.env'))
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
}

const dataFile = process.env.WEBGRIP_DATA || path.join(root, 'data', 'connections.json')
const PORT = Number(process.env.PORT || 3070)
const password = process.env.WEBGRIP_PASSWORD || ''
const secret = process.env.WEBGRIP_SECRET || ''

if (!password || secret.length < 16) {
  console.error('WEBGRIP_PASSWORD and WEBGRIP_SECRET (at least 16 characters) must be set, e.g. in .env (see .env.example)')
  process.exit(1)
}

// API only, never exposed: the browser reaches it through the Vite proxy (/api).
createApp({ dataFile, secret, password }).listen(PORT, '127.0.0.1', () => console.log(`webgrip API on http://127.0.0.1:${PORT}`))
