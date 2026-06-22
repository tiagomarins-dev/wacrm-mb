import { describe, expect, it } from 'vitest'
import { VOZ_MILLA } from './voz-milla'

// R6: guarda contra dessincronização — se o snapshot da skill ficar vazio
// ou perder as barreiras vermelhas, o agente perde os guardrails de marca.
describe('VOZ_MILLA snapshot', () => {
  it('não está vazio e tem as barreiras vermelhas', () => {
    expect(VOZ_MILLA.length).toBeGreaterThan(500)
    expect(VOZ_MILLA).toContain('BARREIRAS VERMELHAS')
    expect(VOZ_MILLA).toContain('Bonde')
  })
})
