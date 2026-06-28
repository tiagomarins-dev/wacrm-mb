// ============================================================
// sale-type.ts — venda ativa vs passiva (PURO).
// Sinal = direção da 1ª mensagem da conversa (único disponível no schema):
//   agent (humano prospectou 1:1) → 'ativa'; customer/bot → 'passiva'.
// "Origem anúncio/broadcast" fica FORA (broadcast não escreve em messages e não
// há campo de origem; precisa de conversations.origin do webhook — fase futura).
// Na prática o caso broadcast/anúncio cai em 'passiva' (o cliente responde 1º).
// ============================================================
import type { SaleType } from "@/types";

// Classifica o tipo da venda pela direção da 1ª msg. Sem mensagens → null.
export function classifySaleType(firstSenderType: "customer" | "agent" | "bot" | null): SaleType | null {
  if (firstSenderType === "agent") return "ativa";
  if (firstSenderType === "customer" || firstSenderType === "bot") return "passiva";
  return null;
}
