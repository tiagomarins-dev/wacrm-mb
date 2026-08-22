import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mocka o par de funções da importação de contatos — aqui interessa a regra de
// quando marcar e com quem, não a mecânica de insert (já testada lá).
vi.mock('@/lib/contacts/resolve-import-tags', () => ({
  resolveImportTagIds: vi.fn(),
  assignImportedContactTags: vi.fn(),
}))

import { tagBroadcastRecipients } from './tag-recipients'
import {
  resolveImportTagIds,
  assignImportedContactTags,
} from '@/lib/contacts/resolve-import-tags'

const db = {} as never
const base = { accountId: 'acc-1', userId: 'user-1', canCreateTags: true }

// Resolução bem-sucedida da tag "lote 1" → id fixo.
function resolveOk() {
  vi.mocked(resolveImportTagIds).mockResolvedValue({
    tagIdByKey: new Map([['lote 1', 'tag-1']]),
    skippedNames: [],
  } as never)
  vi.mocked(assignImportedContactTags).mockResolvedValue(0 as never)
}

beforeEach(() => vi.clearAllMocks())

describe('tagBroadcastRecipients', () => {
  it('marca os contatos informados', async () => {
    resolveOk()
    vi.mocked(assignImportedContactTags).mockResolvedValue(2 as never)
    const n = await tagBroadcastRecipients(db, {
      ...base,
      tagName: 'lote 1',
      contactIds: ['c1', 'c2'],
    })
    expect(n).toBe(2)
    const [, assignments] = vi.mocked(assignImportedContactTags).mock.calls[0]
    expect(assignments).toEqual([
      { contactId: 'c1', tagNames: ['lote 1'] },
      { contactId: 'c2', tagNames: ['lote 1'] },
    ])
  })

  it('sem nome de tag → não toca no banco', async () => {
    expect(await tagBroadcastRecipients(db, { ...base, tagName: null, contactIds: ['c1'] })).toBe(0)
    expect(await tagBroadcastRecipients(db, { ...base, tagName: '   ', contactIds: ['c1'] })).toBe(0)
    expect(resolveImportTagIds).not.toHaveBeenCalled()
  })

  it('lista vazia (todos falharam no envio) → não marca ninguém', async () => {
    expect(await tagBroadcastRecipients(db, { ...base, tagName: 'lote 1', contactIds: [] })).toBe(0)
    expect(resolveImportTagIds).not.toHaveBeenCalled()
  })

  it('dedup: contato repetido vira um vínculo só', async () => {
    resolveOk()
    await tagBroadcastRecipients(db, { ...base, tagName: 'lote 1', contactIds: ['c1', 'c1', 'c2'] })
    const [, assignments] = vi.mocked(assignImportedContactTags).mock.calls[0]
    expect(assignments).toHaveLength(2)
  })

  it('tag inexistente e sem permissão de criar → não marca', async () => {
    vi.mocked(resolveImportTagIds).mockResolvedValue({
      tagIdByKey: new Map(),
      skippedNames: ['lote 1'],
    } as never)
    const n = await tagBroadcastRecipients(db, {
      ...base,
      canCreateTags: false,
      tagName: 'lote 1',
      contactIds: ['c1'],
    })
    expect(n).toBe(0)
    expect(assignImportedContactTags).not.toHaveBeenCalled()
  })

  it('erro no banco não propaga — o disparo já saiu', async () => {
    vi.mocked(resolveImportTagIds).mockRejectedValue(new Error('boom'))
    const n = await tagBroadcastRecipients(db, {
      ...base,
      tagName: 'lote 1',
      contactIds: ['c1'],
    })
    expect(n).toBe(0)
  })
})
