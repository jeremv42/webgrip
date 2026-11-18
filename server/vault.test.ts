import { describe, expect, it } from 'vitest'
import { isSealed, seal, unseal } from './vault.ts'

describe('vault', () => {
  it('encrypts and decrypts with the same secret', () => {
    const sealed = seal('{"password":"hunter2"}', 'some-long-secret!')
    expect(sealed).not.toContain('hunter2')
    const parsed = JSON.parse(sealed)
    expect(isSealed(parsed)).toBe(true)
    expect(unseal(parsed, 'some-long-secret!')).toBe('{"password":"hunter2"}')
  })

  it('uses a new salt and iv each time', () => {
    expect(seal('x', 'some-long-secret!')).not.toBe(seal('x', 'some-long-secret!'))
  })

  it('rejects a wrong secret or an altered file', () => {
    const parsed = JSON.parse(seal('[]', 'some-long-secret!'))
    expect(() => unseal(parsed, 'another-secret!!')).toThrow(/WEBGRIP_SECRET/)
    const data = Buffer.from(parsed.data, 'base64')
    data[0] ^= 1
    expect(() => unseal({ ...parsed, data: data.toString('base64') }, 'some-long-secret!')).toThrow(/altered/)
  })

  it('does not take a plain connection list for an encrypted file', () => {
    expect(isSealed([])).toBe(false)
    expect(isSealed(null)).toBe(false)
  })
})
