import { describe, expect, it } from 'vitest';
import { filterTemplates, sortTemplates, STATUS_SORT_ORDER } from './filter-sort';
import type { MessageTemplate, MessageTemplateStatus } from '@/types';

// Fixture mínima — só os campos lidos pelo filtro/ordenação.
function tpl(p: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: 'x', name: 'modelo', body_text: 'corpo', connection_id: 'c1',
    created_at: '2026-01-01T00:00:00Z', ...p,
  } as unknown as MessageTemplate;
}

describe('filterTemplates', () => {
  const list = [
    tpl({ id: 'a', name: 'boas_vindas', body_text: 'Olá {{1}}', connection_id: 'c1' }),
    tpl({ id: 'b', name: 'cobranca', body_text: 'Fatura vencida', connection_id: 'c2' }),
    tpl({ id: 'c', name: 'orfao', connection_id: 'c9' }),
    tpl({ id: 'd', name: 'legado', connection_id: null }),
  ];

  it("'all' retorna todos", () => {
    expect(filterTemplates(list, { connectionId: 'all', query: '' })).toHaveLength(4);
  });

  it('id específico restringe; órfão some', () => {
    const r = filterTemplates(list, { connectionId: 'c1', query: '' });
    expect(r.map((t) => t.id)).toEqual(['a']);
  });

  it('connection_id null sai de filtro específico, fica em all', () => {
    expect(filterTemplates(list, { connectionId: 'c2', query: '' }).map((t) => t.id)).toEqual(['b']);
    expect(filterTemplates(list, { connectionId: 'all', query: '' }).some((t) => t.id === 'd')).toBe(true);
  });

  it('busca case-insensitive no nome E no corpo', () => {
    expect(filterTemplates(list, { connectionId: 'all', query: 'VENCIDA' }).map((t) => t.id)).toEqual(['b']);
    expect(filterTemplates(list, { connectionId: 'all', query: 'boas' }).map((t) => t.id)).toEqual(['a']);
  });

  it('query só com espaço retorna tudo; sem match retorna []', () => {
    expect(filterTemplates(list, { connectionId: 'all', query: '   ' })).toHaveLength(4);
    expect(filterTemplates(list, { connectionId: 'all', query: 'zzz' })).toHaveLength(0);
  });

  it('filtro + busca combinados', () => {
    const r = filterTemplates(list, { connectionId: 'c2', query: 'fatura' });
    expect(r.map((t) => t.id)).toEqual(['b']);
  });
});

describe('sortTemplates', () => {
  const list = [
    tpl({ id: 'a', name: 'Ávila', status: 'APPROVED', created_at: '2026-02-01T00:00:00Z' }),
    tpl({ id: 'b', name: 'banana', status: 'DRAFT', created_at: '2026-03-01T00:00:00Z' }),
    tpl({ id: 'c', name: 'Carro', status: 'REJECTED', created_at: '2026-01-01T00:00:00Z' }),
  ];

  it('date desc = mais novo primeiro', () => {
    expect(sortTemplates(list, 'date', 'desc', 'pt-BR').map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('date asc = mais antigo primeiro', () => {
    expect(sortTemplates(list, 'date', 'asc', 'pt-BR').map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('name asc respeita acento (sensitivity base)', () => {
    expect(sortTemplates(list, 'name', 'asc', 'pt-BR').map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('status asc segue STATUS_SORT_ORDER', () => {
    // DRAFT(0) < APPROVED(3) < REJECTED(5)
    expect(sortTemplates(list, 'status', 'asc', 'pt-BR').map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('tie-break por created_at desc quando a chave empata', () => {
    const empate = [
      tpl({ id: 'velho', status: 'APPROVED', created_at: '2026-01-01T00:00:00Z' }),
      tpl({ id: 'novo', status: 'APPROVED', created_at: '2026-05-01T00:00:00Z' }),
    ];
    expect(sortTemplates(empate, 'status', 'asc', 'pt-BR').map((t) => t.id)).toEqual(['novo', 'velho']);
  });

  it('não muta o array de entrada', () => {
    const copia = [...list];
    sortTemplates(list, 'name', 'asc', 'pt-BR');
    expect(list).toEqual(copia);
  });
});

describe('STATUS_SORT_ORDER', () => {
  it('classifica todos os MessageTemplateStatus (pega drift do enum)', () => {
    const todos: MessageTemplateStatus[] = [
      'DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION',
    ];
    for (const s of todos) expect(STATUS_SORT_ORDER[s]).toBeTypeOf('number');
  });
});
