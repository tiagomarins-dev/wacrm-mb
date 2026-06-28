// ============================================================
// response-time.ts — pareamento de turnos cliente→resposta do atendente (puro).
// ⚠️ ESPELHADO na RPC agent_response_time (050_agent_report_rpcs.sql).
// DIVERGE de loadResponseTime (src/lib/dashboard/queries.ts:240), que pareia
// cliente → próxima msg 'agent' OU 'bot'. AQUI medimos RESPOSTA HUMANA: o 'bot'
// é IGNORADO (não fecha o turno) — só uma msg 'agent' fecha.
// ============================================================

export type TurnMsg = {
  sender_type: "customer" | "agent" | "bot";
  sender_id?: string | null;
  assigned_agent_id?: string | null;
  created_at: string;
};

// Um turno = bloco do cliente sem resposta humana → 1ª resposta 'agent'.
export type Turn = {
  custAt: string;        // 1ª msg do cliente do bloco
  respAt: string;        // 1ª resposta humana
  responder: string | null; // sender_id (fallback assigned_agent_id)
  isFirst: boolean;      // 1º turno da conversa = First Response Time (FRT)
};

// Cap de outlier (min) — turno acima disso é truncado downstream (RPC/página).
export const CAP_MINUTES = 240;

// Trunca segundos→minutos no cap. Espelha o least(..,240) da RPC.
export function cappedMinutes(seconds: number): number {
  return Math.min(seconds / 60, CAP_MINUTES);
}

// Pareia turnos de UMA conversa (mensagens já ordenadas por created_at asc).
export function pairTurns(msgs: TurnMsg[]): Turn[] {
  const turns: Turn[] = [];
  let pendingCustomerAt: string | null = null; // 1ª msg do cliente sem resposta
  let firstDone = false;

  for (const m of msgs) {
    if (m.sender_type === "customer") {
      // só marca a 1ª de um bloco (msgs seguidas do cliente = 1 turno)
      if (pendingCustomerAt === null) pendingCustomerAt = m.created_at;
    } else if (m.sender_type === "agent") {
      // resposta humana fecha o turno pendente
      if (pendingCustomerAt !== null) {
        turns.push({
          custAt: pendingCustomerAt,
          respAt: m.created_at,
          responder: m.sender_id ?? m.assigned_agent_id ?? null,
          isFirst: !firstDone,
        });
        pendingCustomerAt = null;
        firstDone = true;
      }
    }
    // sender_type === 'bot': ignorado de propósito (não fecha o turno).
  }
  return turns;
}
