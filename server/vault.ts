import crypto from 'node:crypto'

// Encryption of the saved connections (passwords included) with a secret kept outside the data folder (.env).
// File format: JSON { v: 1, salt, iv, tag, data } (base64), AES-256-GCM with a key derived from the secret by scrypt.

interface Sealed {
  v: 1
  salt: string
  iv: string
  tag: string
  data: string
}

const keyOf = (secret: string, salt: Buffer) => crypto.scryptSync(secret, salt, 32)

export function seal(plain: string, secret: string): string {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyOf(secret, salt), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const sealed: Sealed = {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
  return JSON.stringify(sealed)
}

export const isSealed = (value: unknown): value is Sealed =>
  !!value && typeof value === 'object' && (value as Sealed).v === 1 && typeof (value as Sealed).data === 'string'

// Throws if the secret is wrong or the file was altered (GCM authentication).
export function unseal(sealed: Sealed, secret: string): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyOf(secret, Buffer.from(sealed.salt, 'base64')),
    Buffer.from(sealed.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Cannot decrypt the connections file: wrong WEBGRIP_SECRET or altered file')
  }
}
