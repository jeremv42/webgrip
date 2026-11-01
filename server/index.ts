import path from 'node:path'
import { createApp } from './app.ts'

const root = path.resolve(import.meta.dirname, '..')
const dataFile = process.env.WEBGRIP_DATA || path.join(root, 'data', 'connections.json')
const PORT = Number(process.env.PORT || 3070)

// API only, never exposed: the browser reaches it through the Vite proxy (/api).
createApp({ dataFile }).listen(PORT, '127.0.0.1', () => console.log(`webgrip API on http://127.0.0.1:${PORT}`))
