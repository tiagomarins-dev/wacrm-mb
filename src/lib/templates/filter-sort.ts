// Lógica pura de filtro e ordenação dos Modelos de mensagem (settings?tab=templates).
// Fica fora do componente p/ ser testável (vitest env node). Espelha
// inbox/quick-replies.ts (filtro) e inbox/queue.ts::sortByTab (ordenação por cópia).
import type { MessageTemplate, MessageTemplateStatus } from '@/types';

export type TemplateSortKey = 'date' | 'status' | 'name';
export type TemplateSortDir = 'asc' | 'desc';

export interface TemplateFilter {
  connectionId: string; // 'all' = todas as conexões
  query: string;
}

// Ordem por status = ciclo de vida (acionáveis → aprovados → problema/terminais).
// Record<MessageTemplateStatus,…> força, em compile-time, classificar todo status novo.
export const STATUS_SORT_ORDER: Record<MessageTemplateStatus, number> = {
  DRAFT: 0,
  PENDING: 1,
  IN_APPEAL: 2,
  APPROVED: 3,
  PAUSED: 4,
  REJECTED: 5,
  DISABLED: 6,
  PENDING_DELETION: 7,
};

// Índice de ordenação de um status (ausente/desconhecido afunda pro fim).
function statusRank(status?: MessageTemplateStatus): number {
  return status && status in STATUS_SORT_ORDER
    ? STATUS_SORT_ORDER[status]
    : Number.MAX_SAFE_INTEGER;
}

// Filtra por conexão e por texto (nome + corpo). 'all' ignora a conexão;
// query vazia ignora a busca. Espelha filterQuickReplies (quick-replies.ts:30).
export function filterTemplates(
  list: MessageTemplate[],
  { connectionId, query }: TemplateFilter,
): MessageTemplate[] {
  const q = query.trim().toLowerCase();
  return list.filter((tpl) => {
    if (connectionId !== 'all' && tpl.connection_id !== connectionId) return false;
    if (!q) return true;
    return (
      tpl.name.toLowerCase().includes(q) ||
      tpl.body_text.toLowerCase().includes(q)
    );
  });
}

// Ordena uma CÓPIA (nunca muta o array de estado React) por data/status/nome,
// com desempate determinístico por created_at desc. Espelha sortByTab (queue.ts:43).
export function sortTemplates(
  list: MessageTemplate[],
  key: TemplateSortKey,
  dir: TemplateSortDir,
  locale: string,
): MessageTemplate[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    let cmp = 0;
    if (key === 'name') {
      cmp = a.name.localeCompare(b.name, locale, { sensitivity: 'base' });
    } else if (key === 'status') {
      cmp = statusRank(a.status) - statusRank(b.status);
    } else {
      cmp = Date.parse(a.created_at) - Date.parse(b.created_at);
    }
    if (cmp !== 0) return cmp * factor;
    // Tie-break estável: mais recente primeiro, independe da direção principal.
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}
