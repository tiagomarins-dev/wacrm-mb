import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, serializeRecentMessages, coalesceHistory } from './prompt'

const baseArgs = {
  persona: 'PERSONA_DO_ADMIN_AQUI',
  courses: [{ slug: 'intensivo', nome: 'Método Blindado Intensivo', posicionamento: 'reta final ENEM' }],
  supportCategories: ['acesso', 'financeiro'],
  student: null,
}

describe('buildSystemPrompt', () => {
  it('COM persona: a persona é a base; NÃO duplica voz-milla nem o papel genérico', () => {
    const p = buildSystemPrompt(baseArgs)
    expect(p).toContain('PERSONA_DO_ADMIN_AQUI')
    expect(p).not.toContain('BARREIRAS VERMELHAS') // voz-milla pulada
    expect(p).not.toContain('assistente virtual da Prof. Milla Borges') // papel genérico pulado
  })

  it('SEM persona: usa o papel genérico + voz-milla', () => {
    const p = buildSystemPrompt({ ...baseArgs, persona: null })
    expect(p).toContain('assistente virtual da Prof. Milla Borges')
    expect(p).toContain('BARREIRAS VERMELHAS')
  })

  it('tem a instrução de roteamento e o catálogo de cursos', () => {
    const p = buildSystemPrompt(baseArgs)
    expect(p).toContain('ROTEAMENTO')
    expect(p).toContain('slug: intensivo')
    expect(p).toContain('acesso, financeiro')
  })

  it('formatação manda escrever SEM markdown (sem asteriscos)', () => {
    const p = buildSystemPrompt(baseArgs)
    expect(p).toContain('SEM markdown')
  })

  it('venda consultiva: prioriza 12x, empurra combo, não lidera pelo preço', () => {
    const p = buildSystemPrompt(baseArgs)
    expect(p).toContain('12x')
    expect(p).toContain('Carioca')
    expect(p).toContain('NÃO lidere pela')
  })

  it('encerrar: guard contra encerrar calado diante de pergunta', () => {
    const p = buildSystemPrompt(baseArgs)
    expect(p).toContain('ENCERRAR')
    expect(p).toContain('Nunca encerre calado')
  })

  it('estilo: manda ser breve e quebrar em mensagens separadas', () => {
    const p = buildSystemPrompt(baseArgs)
    expect(p).toContain('ESTILO DE RESPOSTA')
    expect(p).toContain('mensagem separada')
  })

  it('aluno (student.success) adiciona o sinal de suporte', () => {
    const p = buildSystemPrompt({ ...baseArgs, student: { status: 'success', payload: {} } })
    expect(p).toContain('JÁ É ALUNO')
  })

  it('DADOS DO CONTATO: injeta nome, email e cursos que possui', () => {
    const p = buildSystemPrompt({
      ...baseArgs,
      contactName: 'Tiago',
      contactEmail: 'tiago@x.com',
      studentCourses: ['Mestres da UERJ'],
    })
    expect(p).toContain('DADOS DO CONTATO')
    expect(p).toContain('Tiago')
    expect(p).toContain('tiago@x.com')
    expect(p).toContain('Mestres da UERJ')
    expect(p).toContain('JÁ É ALUNO') // cursos não-vazios → é aluno
  })

  it('opening:true injeta a diretriz de abertura (cumprimenta, não transfere)', () => {
    const p = buildSystemPrompt({ ...baseArgs, opening: true })
    expect(p).toContain('ABERTURA DE NOVA CONVERSA')
    expect(p).toContain('transferir_humano')
    expect(p).toContain('analista') // proíbe mencionar analista no texto
  })

  it('sem opening → NÃO injeta a diretriz de abertura', () => {
    expect(buildSystemPrompt(baseArgs)).not.toContain('ABERTURA DE NOVA CONVERSA')
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
    // Vem decrescente do banco (mais recente primeiro). Fluxo real: a última
    // mensagem é do cliente (o inbound que disparou o agente) → histórico
    // termina em 'user' (sobrevive ao coalesceHistory).
    const db = makeDb({
      data: [
        { sender_type: 'customer', content_text: 'e o valor?', content_type: 'text' },
        { sender_type: 'bot', content_text: 'Oi! Como posso ajudar?', content_type: 'text' },
        { sender_type: 'customer', content_text: 'quero saber do intensivo', content_type: 'text' },
      ],
      error: null,
    })
    const msgs = await serializeRecentMessages(db, 'conv-1')
    expect(msgs).toEqual([
      { role: 'user', content: 'quero saber do intensivo' },
      { role: 'assistant', content: 'Oi! Como posso ajudar?' },
      { role: 'user', content: 'e o valor?' },
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

  it('áudio transcrito (status done) usa a transcrição no lugar do placeholder', async () => {
    const db = makeDb({
      data: [
        {
          sender_type: 'customer',
          content_text: null,
          content_type: 'audio',
          transcription: 'Boa tarde, queria saber do intensivo',
          transcription_status: 'done',
        },
      ],
      error: null,
    })
    const msgs = await serializeRecentMessages(db, 'conv-1')
    expect(msgs[0]).toEqual({ role: 'user', content: 'Boa tarde, queria saber do intensivo' })
  })

  it('áudio sem conteúdo (status empty) vira "[áudio sem conteúdo]"', async () => {
    const db = makeDb({
      data: [
        { sender_type: 'customer', content_text: null, content_type: 'audio', transcription: 'Áudio sem conteúdo', transcription_status: 'empty' },
      ],
      error: null,
    })
    const msgs = await serializeRecentMessages(db, 'conv-1')
    expect(msgs[0]).toEqual({ role: 'user', content: '[áudio sem conteúdo]' })
  })

  it('áudio ainda pendente (status pending) cai no placeholder', async () => {
    const db = makeDb({
      data: [
        { sender_type: 'customer', content_text: null, content_type: 'audio', transcription: null, transcription_status: 'pending' },
      ],
      error: null,
    })
    const msgs = await serializeRecentMessages(db, 'conv-1')
    expect(msgs[0]).toEqual({ role: 'user', content: '[áudio]' })
  })

  it('erro → []', async () => {
    const db = makeDb({ data: null, error: { message: 'boom' } })
    expect(await serializeRecentMessages(db, 'conv-1')).toEqual([])
  })

  // Regressão do bug de prod: multi-bolha do bot (bolhas consecutivas) não pode
  // gerar 'assistant' adjacentes (Anthropic 400). Vem decrescente; termina em user.
  it('bolhas bot consecutivas → 1 assistant mesclado, alternando e terminando em user', async () => {
    const db = makeDb({
      data: [
        { sender_type: 'customer', content_text: 'quero o intensivo', content_type: 'text' },
        { sender_type: 'bot', content_text: 'Como posso ajudar?', content_type: 'text' },
        { sender_type: 'bot', content_text: 'Sou a Ruth.', content_type: 'text' },
        { sender_type: 'bot', content_text: 'Olá, Tiago!', content_type: 'text' },
        { sender_type: 'customer', content_text: 'oi', content_type: 'text' },
      ],
      error: null,
    })
    const msgs = await serializeRecentMessages(db, 'conv-1')
    expect(msgs).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'Olá, Tiago!\nSou a Ruth.\nComo posso ajudar?' },
      { role: 'user', content: 'quero o intensivo' },
    ])
  })
})

describe('coalesceHistory', () => {
  it('mescla assistant consecutivos num único turn', () => {
    expect(
      coalesceHistory([
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'e aí' },
      ]),
    ).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'a\nb' },
      { role: 'user', content: 'e aí' },
    ])
  })

  it('dropa o prefixo que não começa em user', () => {
    expect(
      coalesceHistory([
        { role: 'assistant', content: 'abertura' },
        { role: 'user', content: 'oi' },
      ]),
    ).toEqual([{ role: 'user', content: 'oi' }])
  })

  it('dropa o sufixo que não termina em user (C1)', () => {
    expect(
      coalesceHistory([
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'resposta' },
      ]),
    ).toEqual([{ role: 'user', content: 'oi' }])
  })

  it('descarta vazio/whitespace; os dois user ficam adjacentes e mesclam', () => {
    expect(
      coalesceHistory([
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: '   ' }, // vazio → removido
        { role: 'user', content: 'tem aí?' },
      ]),
    ).toEqual([{ role: 'user', content: 'oi\ntem aí?' }])
  })

  it('alternância normal → inalterada', () => {
    const h = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
      { role: 'user' as const, content: 'c' },
    ]
    expect(coalesceHistory(h)).toEqual(h)
  })

  it('histórico sem nenhum user → [] (degrade → skipped:no_history)', () => {
    expect(
      coalesceHistory([
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
      ]),
    ).toEqual([])
  })

  it('nunca deixa papéis adjacentes iguais (invariante)', () => {
    const out = coalesceHistory([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ])
    for (let i = 1; i < out.length; i++) expect(out[i].role).not.toBe(out[i - 1].role)
    expect(out[out.length - 1].role).toBe('user')
  })
})
