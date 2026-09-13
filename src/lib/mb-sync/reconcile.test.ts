import { describe, expect, it } from 'vitest'
import {
  diffTag,
  filterEligible,
  matchStudents,
  parseIdList,
  removalGuard,
  type MbStudentRow,
} from './reconcile'

// Aluno ativo padrão; cada teste sobrescreve só o que importa.
function student(over: Partial<MbStudentRow> = {}): MbStudentRow {
  return {
    id_aluno: 1,
    id_curso: 90,
    nome: 'Ana Souza',
    email: 'ana@gmail.com',
    telefone: '5521987654321',
    usuario_vigente: 'S',
    ...over,
  }
}

describe('parseIdList', () => {
  it('extrai inteiros positivos e ignora lixo', () => {
    expect(parseIdList('20, 31,x,-1,,0')).toEqual(new Set([20, 31]))
  })

  it('vazio ou ausente → conjunto vazio', () => {
    expect(parseIdList(undefined)).toEqual(new Set())
    expect(parseIdList('')).toEqual(new Set())
  })
})

describe('filterEligible', () => {
  it('exclui opt-out de WhatsApp (maiúsculo ou minúsculo)', () => {
    const rows = [
      student({ id_aluno: 1, mensagens_whatsapp: 'N' }),
      student({ id_aluno: 2, mensagens_whatsapp: 'n' }),
      student({ id_aluno: 3, mensagens_whatsapp: null }),
    ]
    expect(filterEligible(rows, [90], new Set()).map((r) => r.id_aluno)).toEqual([3])
  })

  it('exclui permissões de equipe, domínio da empresa e ids listados', () => {
    const rows = [
      student({ id_aluno: 1, permissao: 1 }),
      student({ id_aluno: 2, permissao: 5 }),
      student({ id_aluno: 3, permissao: 50 }),
      student({ id_aluno: 4, email: 'Fulano@ProfMillaBorges.com ' }),
      student({ id_aluno: 20 }),
      student({ id_aluno: 5 }),
    ]
    expect(filterEligible(rows, [90], new Set([20])).map((r) => r.id_aluno)).toEqual([5])
  })

  it('exclui cadastro desativado na plataforma', () => {
    const rows = [
      student({ id_aluno: 1, usuario_vigente: 'N' }),
      student({ id_aluno: 2, usuario_vigente: null }),
      student({ id_aluno: 3 }),
    ]
    expect(filterEligible(rows, [90], new Set()).map((r) => r.id_aluno)).toEqual([3])
  })

  it('sem os campos opcionais da API o aluno segue elegível; permissão em string também filtra', () => {
    const rows = [
      student({ id_aluno: 1 }), // sem permissao/mensagens_whatsapp
      student({ id_aluno: 2, permissao: '50' }),
    ]
    expect(filterEligible(rows, [90], new Set()).map((r) => r.id_aluno)).toEqual([1])
  })

  it('considera só os cursos da tag e deduplica aluno em vários cursos', () => {
    const rows = [
      student({ id_aluno: 1, id_curso: 90 }),
      student({ id_aluno: 1, id_curso: 88 }),
      student({ id_aluno: 2, id_curso: 78 }),
    ]
    expect(filterEligible(rows, [90, 88], new Set()).map((r) => r.id_aluno)).toEqual([1])
  })
})

describe('matchStudents', () => {
  it('prioriza a chave exata sobre a variante do 9º dígito', () => {
    const out = matchStudents([student()], [
      { id: 'sem9', phone_normalized: '552187654321' },
      { id: 'exato', phone_normalized: '5521987654321' },
    ])
    expect(out.matchedContactIds).toEqual(['exato'])
    expect(out.toCreate).toEqual([])
  })

  it('casa contato gravado sem 55', () => {
    const out = matchStudents([student({ telefone: '5521987654321' })], [
      { id: 'local', phone_normalized: '21987654321' },
    ])
    expect(out.matchedContactIds).toEqual(['local'])
  })

  it('sem contato → cria com telefone canônico e nome da plataforma', () => {
    const out = matchStudents([student({ telefone: '21987654321', nome: '  Ana Souza ' })], [])
    expect(out.toCreate).toEqual([{ phone: '5521987654321', name: 'Ana Souza' }])
  })

  it('nome vazio vira o telefone', () => {
    const out = matchStudents([student({ nome: '' })], [])
    expect(out.toCreate).toEqual([{ phone: '5521987654321', name: '5521987654321' }])
  })

  it('telefone repetido entre usuários conta uma vez', () => {
    const out = matchStudents(
      [student({ id_aluno: 1 }), student({ id_aluno: 2, telefone: '21987654321' })],
      [],
    )
    expect(out.toCreate).toHaveLength(1)
  })

  it('telefone inválido soma em skipped', () => {
    const out = matchStudents([student({ telefone: '123' }), student({ telefone: null })], [])
    expect(out.skipped).toBe(2)
    expect(out.toCreate).toEqual([])
  })
})

describe('diffTag', () => {
  it('adiciona quem falta e remove pelo id do vínculo', () => {
    const out = diffTag(['a', 'b'], [
      { id: 'ct-b', contact_id: 'b' },
      { id: 'ct-c', contact_id: 'c' },
    ])
    expect(out).toEqual({ add: ['a'], remove: ['ct-c'] })
  })

  it('estado igual → nada a fazer', () => {
    expect(diffTag(['a'], [{ id: 'ct-a', contact_id: 'a' }])).toEqual({ add: [], remove: [] })
  })
})

describe('removalGuard', () => {
  it('zero elegíveis sempre aborta', () => {
    expect(removalGuard(0, null)).toBe('no_eligible_students')
  })

  it('sem base, qualquer total positivo passa', () => {
    expect(removalGuard(5, null)).toBeNull()
  })

  it('queda abaixo de 50% da base ≥ 20 aborta', () => {
    expect(removalGuard(49, 100)).toBe('drop_over_50pct')
    expect(removalGuard(50, 100)).toBeNull()
  })

  it('base pequena (< 20) não aciona a regra relativa', () => {
    expect(removalGuard(1, 19)).toBeNull()
  })
})
