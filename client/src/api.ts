import type { Dialect } from '../../shared/types.ts'

// Called when the API answers 401 (no session, or an expired one): the app then asks for the password.
let unauthorized = () => {}
export const onUnauthorized = (fn: () => void) => {
  unauthorized = fn
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({ error: res.statusText }))
  if (res.status === 401) unauthorized()
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

// POST answered by a stream of JSON lines (NDJSON): calls onLine for each one, until the end or the abort signal.
export async function postStream<T>(url: string, body: unknown, onLine: (line: T) => void, signal?: AbortSignal) {
  const res = await fetch('/api' + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: res.statusText }))
    if (res.status === 401) unauthorized()
    throw new Error(data.error || res.statusText)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    for (const line of lines) if (line.trim()) onLine(JSON.parse(line))
  }
  if (buffer.trim()) onLine(JSON.parse(buffer))
}

type Params = Record<string, string | number | null | undefined>

export const qs = (params?: Params) => {
  const p = Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
  return p.length ? '?' + new URLSearchParams(p.map(([k, v]) => [k, String(v)])) : ''
}

export const api = {
  get: <T>(url: string, params?: Params) => request<T>('GET', url + qs(params)),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body || {}),
  del: <T>(url: string) => request<T>('DELETE', url),
}

export function quoteIdent(name: string, dialect?: Dialect) {
  if (dialect === 'mariadb') return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : '`' + name.replace(/`/g, '``') + '`'
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : '"' + name.replace(/"/g, '""') + '"'
}

// navigator.clipboard only exists in secure contexts (https or localhost): over plain http (Tailscale) fall back to a textarea.
export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      /* not allowed here: fall back */
    }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('Copy failed')
}

export const store = {
  get<T>(key: string, def: T): T {
    try {
      const v = localStorage.getItem('webgrip.' + key)
      return v == null ? def : JSON.parse(v)
    } catch {
      return def
    }
  },
  set(key: string, val: unknown) {
    try {
      localStorage.setItem('webgrip.' + key, JSON.stringify(val))
    } catch {}
  },
}
