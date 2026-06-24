// ============================================================
// Identidade da IA como "responsável" pela conversa.
//
// UUID sintético FIXO e global: representa o agente de IA em
// conversations.assigned_agent_id (coluna SEM foreign key, então não
// precisa de usuário de auth/profile). O gate roda sempre dentro de uma
// conta, então a mesma constante servir todas as contas não vaza nada.
//
// Compartilhado entre backend (gate) e front (seletor de responsável):
// atribuir a conversa a este id = "a IA assume"; reatribuir a um humano =
// "humano assume" e o bot para.
// ============================================================
export const AI_AGENT_USER_ID = '00000000-0000-0000-0000-0000000000a1'
export const AI_AGENT_LABEL = 'Assistente IA'
