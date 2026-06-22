import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, serializeRecentMessages } from './prompt'

const baseArgs = {
  persona: 'PERSONA_DO_ADMIN_AQUI',
  courses: [{ slug: 'intensivo', nome: 'Método Blindado Intensivo', posicionamento: 'reta final ENEM' }],
  supportCategories: ['acesso', 'financeiro'],
  student: null,
}

describe('buildSystemPrompt', () => {
  it('inclui os guardrails da voz-milla', () => {
    const p = buildSystemPrompt(baseArgs)
    expect(p).toContain('BARREIRAS VERMELHAS')
  })

  it('persona vem ANTES da voz-milla (guardrails têm precedência)', () => {
    const p = buildSystemPrompt(baseArgs)
    expect(p.indexOf('PERSONA_DO_ADMIN_AQUI')).toBeLessThan(p.indexOf('BARREIRAS VERMELHAS'))
  })

  it('tem a instrução de roteamento e o catálogo de cursos', () => {
    const p = buildSystemPrompt(baseArgs)
    expect(p).toContain('ROTEAMENTO')
    expect(p).toContain('slug: intensivo')
    expect(p).toContain('acesso, financeiro')
  })

  it('aluno (student.success) adiciona o sinal de suporte', () => {
    const p = buildSystemPrompt({ ...baseArgs, student: { status: 'success', payload: {} } })
    expect(p).toContain('JÁ É ALUNO')
  })

  it('sem persona não quebra', () => {
    const p = buildSystemPrompt({ ...baseArgs, persona: null })
    expect(p).toContain('BARREIRAS VERMELHAS')
  })
})

// Mock db: .select().eq().order().limit() resolve p/ {data, error}.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(result: { data: any; error: any }) {
  const b: Record<string, unknown> = {
    select: () => b,
    eq: () => b,
    order: () => b,
    limit: () => Promise.resolve(result),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: () => b } as any
}

describe('serializeRecentMessages', () => {
  it('mapeia customer→user, bot→assistant e reinverte p/ ordem cronológica', async () => {
    // Vem decrescente do banco (mais recente primeiro).
    const db = makeDb({
      data: [
        { sender_type: 'bot', content_text: 'Oi! Como posso ajudar?', content_type: 'text' },
        { sender_type: 'customer', content_text: 'quero saber do intensivo', content_type: 'text' },
      ],
      error: null,
    })
    const msgs = await serializeRecentMessages(db, 'conv-1')
    expect(msgs).toEqual([
      { role: 'user', content: 'quero saber do intensivo' },
      { role: 'assistant', content: 'Oi! Como posso ajudar?' },
    ])
  })

  it('mídia sem texto vira placeholder', async () => {
    const db = makeDb({
      data: [{ sender_type: 'customer', content_text: null, content_type: 'audio' }],
      error: null,
    })
    const msgs = await serializeRecentMessages(db, 'conv-1')
    expect(msgs[0]).toEqual({ role: 'user', content: '[áudio]' })
  })

  it('erro → []', async () => {
    const db = makeDb({ data: null, error: { message: 'boom' } })
    expect(await serializeRecentMessages(db, 'conv-1')).toEqual([])
  })
})
