async function request(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({ error: res.statusText }))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

const qs = (params) => {
  const p = Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
  return p.length ? '?' + new URLSearchParams(p) : ''
}

export const api = {
  get: (url, params) => request('GET', url + qs(params)),
  post: (url, body) => request('POST', url, body || {}),
  del: (url) => request('DELETE', url),
}

export function quoteIdent(name, dialect) {
  if (dialect === 'mariadb') return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : '`' + name.replace(/`/g, '``') + '`'
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : '"' + name.replace(/"/g, '""') + '"'
}

// navigator.clipboard only exists in secure contexts (https or localhost): over plain http (Tailscale) fall back to a textarea.
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return } catch { /* not allowed here: fall back */ }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('Copie impossible')
}

export const store = {
  get(key, def) { try { const v = localStorage.getItem('webgrip.' + key); return v == null ? def : JSON.parse(v) } catch { return def } },
  set(key, val) { try { localStorage.setItem('webgrip.' + key, JSON.stringify(val)) } catch {} },
}
