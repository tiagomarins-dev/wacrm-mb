import { describe, expect, it } from 'vitest'
import { isBotUserAgent } from './user-agent'

describe('isBotUserAgent', () => {
  it('bots/prefetch conhecidos → true', () => {
    expect(isBotUserAgent('facebookexternalhit/1.1')).toBe(true)
    expect(isBotUserAgent('WhatsApp/2.23')).toBe(true)
    expect(isBotUserAgent('Twitterbot/1.0')).toBe(true)
  })

  it('browser real → false', () => {
    expect(
      isBotUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Mobile Safari/604.1',
      ),
    ).toBe(false)
  })

  it('UA ausente → true (conservador)', () => {
    expect(isBotUserAgent(null)).toBe(true)
    expect(isBotUserAgent(undefined)).toBe(true)
    expect(isBotUserAgent('')).toBe(true)
  })
})
