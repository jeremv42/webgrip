import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

// A single shared password. A successful login sets a signed cookie (expiry + HMAC): no server-side session,
// so it survives API restarts; changing the password or the secret invalidates every cookie.

export const COOKIE = 'webgrip_session'
const MAX_AGE = 30 * 24 * 3600 // seconds
const MAX_FAILURES = 10 // per minute, all clients together

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest()

export function cookieValue(header: string | undefined, name: string) {
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`

export function createAuth({ password, secret, now = () => Date.now() }: { password: string; secret: string; now?: () => number }) {
  const key = crypto
    .createHmac('sha256', secret)
    .update('webgrip-session\0' + password)
    .digest()
  const sign = (exp: number) => crypto.createHmac('sha256', key).update(String(exp)).digest('base64url')

  const token = () => {
    const exp = Math.floor(now() / 1000) + MAX_AGE
    return `${exp}.${sign(exp)}`
  }
  const valid = (value: string | undefined) => {
    const [exp, mac] = (value || '').split('.')
    if (!exp || !mac || Number(exp) * 1000 < now()) return false
    const expected = Buffer.from(sign(Number(exp)))
    const given = Buffer.from(mac)
    return given.length === expected.length && crypto.timingSafeEqual(given, expected)
  }
  const check = (given: unknown) => typeof given === 'string' && crypto.timingSafeEqual(sha256(given), sha256(password))

  let failures: number[] = []

  // Sets the session cookie when `given` is the password, else answers the error (and returns false).
  async function attempt(given: unknown, res: Response) {
    failures = failures.filter((t) => t > now() - 60_000)
    if (failures.length >= MAX_FAILURES) {
      res.status(429).json({ error: 'Too many attempts, try again in a minute' })
      return false
    }
    if (!check(given)) {
      failures.push(now())
      await new Promise((resolve) => setTimeout(resolve, 500)) // slows down guessing
      res.status(401).json({ error: 'Wrong password' })
      return false
    }
    res.setHeader('Set-Cookie', cookie(token(), MAX_AGE))
    return true
  }

  return {
    async login(req: Request, res: Response) {
      if (await attempt(req.body?.password, res)) res.json({ ok: true })
    },

    // Desktop app: the window opens GET /api/desktop-login?token=<launch token> (the password of this launch),
    // which sets the cookie and goes on to the app, so there is no login dialog.
    async tokenLogin(req: Request, res: Response) {
      if (await attempt(req.query.token, res)) res.redirect(303, '/')
    },

    logout(_req: Request, res: Response) {
      res.setHeader('Set-Cookie', cookie('', 0))
      res.json({ ok: true })
    },

    // every /api route but the login one
    guard(req: Request, res: Response, next: NextFunction) {
      if (valid(cookieValue(req.headers.cookie, COOKIE))) next()
      else res.status(401).json({ error: 'Not authenticated' })
    },
  }
}
