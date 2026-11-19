// Server of the desktop app (src-tauri), bundled into a single executable started by the Tauri shell:
//
// - no password: the shell passes a random token of this launch (WEBGRIP_LAUNCH_TOKEN) and opens the window on
//   /api/desktop-login?token=…, which sets the session cookie; the next launch has another token
// - listens on 127.0.0.1, on a free port printed on stdout (`WEBGRIP_PORT=<port>`), and only answers that Host
//   (a page from elsewhere reaching it through DNS rebinding gets nothing)
// - serves the built SPA (WEBGRIP_DIST) itself: no Vite
// - keeps its connections and their encryption key in the app's data folder (WEBGRIP_DATA_DIR)
// - exits when its stdin closes, i.e. when the shell is gone, even after a crash
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createApp } from './app.ts'

const env = process.env
const fail = (message: string) => {
  console.error(message)
  process.exit(1)
}

const dataDir = env.WEBGRIP_DATA_DIR || fail('WEBGRIP_DATA_DIR must be set')
const dist = env.WEBGRIP_DIST || fail('WEBGRIP_DIST must be set')
const token = env.WEBGRIP_LAUNCH_TOKEN || ''
if (token.length < 32) fail('WEBGRIP_LAUNCH_TOKEN must be set (at least 32 characters)')
if (!fs.existsSync(path.join(dist, 'index.html'))) fail(`No index.html in ${dist}`)

// The key of the saved connections, created at the first launch (only readable by this user).
// Losing it means losing the saved connections' passwords.
function secret() {
  const file = path.join(dataDir, 'secret.key')
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const value = crypto.randomBytes(32).toString('base64')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, value + '\n', { mode: 0o600, flag: 'wx' })
  return value
}

// The chat needs the Claude Code CLI. An app started from the desktop often lacks the shell's PATH,
// so the usual install folders are tried too. WEBGRIP_CHAT=0 turns it off.
function findClaude() {
  if (env.WEBGRIP_CLAUDE_BIN) return env.WEBGRIP_CLAUDE_BIN
  const home = os.homedir()
  const dirs = [
    ...(env.PATH || '').split(path.delimiter),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude']
  for (const dir of dirs.filter(Boolean))
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        fs.accessSync(file, fs.constants.X_OK)
        if (fs.statSync(file).isFile()) return file
      } catch {}
    }
  return undefined
}
const flag = (name: string, fallback: boolean) => {
  const v = env[name]
  return v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v)
}
const claudeBin = flag('WEBGRIP_CHAT', true) ? findClaude() : undefined
const chat = claudeBin
  ? { bin: claudeBin, model: env.WEBGRIP_CHAT_MODEL || undefined, runQuery: flag('WEBGRIP_CHAT_RUN_QUERY', false) }
  : undefined

const api = createApp({ dataFile: path.join(dataDir, 'connections.json'), secret: secret(), password: token, chat, desktop: true })

let host = '' // 127.0.0.1:<port>, once listening
const app = express()
app.disable('x-powered-by')
app.use((req, res, next) => {
  if (req.headers.host === host) next()
  else res.status(421).end()
})
app.use(api)
app.use(express.static(dist, { index: 'index.html' }))

const server = app.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo
  host = `127.0.0.1:${port}`
  console.log(`WEBGRIP_PORT=${port}`)
})

process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))
process.stdin.resume()
