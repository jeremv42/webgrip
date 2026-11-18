// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, copyText, onUnauthorized, qs, quoteIdent, store } from './api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('qs', () => {
  it('drops empty parameters', () => {
    expect(qs({ db: 'app', schema: null, table: '', n: 0, x: undefined })).toBe('?db=app&n=0')
    expect(qs({})).toBe('')
    expect(qs()).toBe('')
  })
})

describe('api', () => {
  it('reports a 401 to the unauthorized handler, and still throws', async () => {
    const handler = vi.fn()
    onUnauthorized(handler)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Non authentifié' }), { status: 401 })),
    )
    await expect(api.get('/connections')).rejects.toThrow('Non authentifié')
    expect(handler).toHaveBeenCalledOnce()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 400 })),
    )
    await expect(api.get('/connections')).rejects.toThrow('boom')
    expect(handler).toHaveBeenCalledOnce()
    onUnauthorized(() => {})
  })

  it('sends JSON and returns the parsed answer', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await api.post('/c/1/query', { sql: 'select 1' })).toEqual({ ok: 1 })
    expect(fetch).toHaveBeenCalledWith('/api/c/1/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"sql":"select 1"}',
    })
    await api.get('/c/1/tables', { db: 'a b' })
    expect(fetch).toHaveBeenLastCalledWith('/api/c/1/tables?db=a+b', { method: 'GET', headers: {}, body: undefined })
  })

  it("throws the server's error message", async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Unknown connection' }), { status: 404 }))
    await expect(api.get('/c/x/info')).rejects.toThrow('Unknown connection')
  })

  it('falls back to the status text when the body is not JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>', { status: 502, statusText: 'Bad Gateway' }))
    await expect(api.del('/connections/x')).rejects.toThrow('Bad Gateway')
  })
})

describe('quoteIdent', () => {
  it('leaves plain PostgreSQL identifiers bare and double-quotes the others', () => {
    expect(quoteIdent('orders')).toBe('orders')
    expect(quoteIdent('Orders')).toBe('"Orders"')
    expect(quoteIdent('my "t"')).toBe('"my ""t"""')
  })
  it('uses backticks for MariaDB, where case does not force quoting', () => {
    expect(quoteIdent('Orders', 'mariadb')).toBe('Orders')
    expect(quoteIdent('order lines', 'mariadb')).toBe('`order lines`')
    expect(quoteIdent('a`b', 'mariadb')).toBe('`a``b`')
  })
})

describe('store', () => {
  it('round-trips JSON values under a webgrip. prefix', () => {
    store.set('ctx', { db: 'app' })
    expect(localStorage.getItem('webgrip.ctx')).toBe('{"db":"app"}')
    expect(store.get('ctx', null)).toEqual({ db: 'app' })
  })
  it('returns the default for a missing or corrupt value', () => {
    expect(store.get('missing', 500)).toBe(500)
    localStorage.setItem('webgrip.bad', '{')
    expect(store.get('bad', 'def')).toBe('def')
  })
})

describe('copyText', () => {
  it('uses the async clipboard when available', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await copyText('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to execCommand outside secure contexts', async () => {
    vi.stubGlobal('navigator', {})
    const exec = vi.fn(() => true)
    document.execCommand = exec
    await copyText('hello')
    expect(exec).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('throws when nothing can copy', async () => {
    vi.stubGlobal('navigator', {})
    document.execCommand = () => false
    await expect(copyText('x')).rejects.toThrow('Copie impossible')
  })
})
