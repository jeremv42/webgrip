// Builds the desktop app's server (server/desktop.ts) as a single executable, without Node to install:
// rolldown bundles it with its dependencies into one CommonJS file, then Node turns it into a single
// executable application (node --build-sea), named the way Tauri expects its sidecars:
// src-tauri/binaries/webgrip-server-<target triple>[.exe]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'rolldown'

const root = path.resolve(import.meta.dirname, '..')
const work = path.join(root, 'node_modules', '.tmp', 'sidecar')
const bundle = path.join(work, 'server.cjs')

// The triple Tauri builds for (set when run by its beforeBuildCommand), else the host's.
function triple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE
  try {
    const host = /^host: (.+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))
    if (host) return host[1]
  } catch {}
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch as string]
  const os = { linux: 'unknown-linux-gnu', darwin: 'apple-darwin', win32: 'pc-windows-msvc' }[process.platform as string]
  if (!arch || !os) throw new Error(`Unsupported platform ${process.platform}/${process.arch}`)
  return `${arch}-${os}`
}

const exe = process.platform === 'win32' ? '.exe' : ''
const output = path.join(root, 'src-tauri', 'binaries', `webgrip-server-${triple()}${exe}`)

fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(path.dirname(output), { recursive: true })

await build({
  input: path.join(root, 'server', 'desktop.ts'),
  platform: 'node',
  // optional native bindings, only loaded when asked for (never here)
  external: ['pg-native'],
  output: { file: bundle, format: 'cjs', minify: true, codeSplitting: false },
  logLevel: 'warn',
})

const config = path.join(work, 'sea-config.json')
fs.writeFileSync(config, JSON.stringify({ main: bundle, output, disableExperimentalSEAWarning: true, useCodeCache: true }))
execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' })
// macOS refuses a modified binary until it is signed again (ad hoc here; the app bundle is signed by Tauri)
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', '--force', output], { stdio: 'inherit' })

console.log(`sidecar: ${path.relative(root, output)} (${(fs.statSync(output).size / 1e6).toFixed(0)} MB)`)
