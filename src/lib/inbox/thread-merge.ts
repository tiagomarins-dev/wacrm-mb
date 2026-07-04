// ============================================================
// Mescla mensagens + eventos internos (transferências) numa timeline única
// pra a thread do inbox. Função PURA. Ordena por created_at; empate determinístico
// por id (sem "pular" no re-render/realtime).
// ============================================================
import type { Message, ConversationEvent, ConversationNote } from "@/types";

export type ThreadItem =
  | { kind: "message"; id: string; created_at: string; msg: Message }
  | { kind: "event"; id: string; created_at: string; ev: ConversationEvent }
  | { kind: "note"; id: string; created_at: string; note: ConversationNote };

// Une mensagens + eventos + notas internas em ThreadItem[] ordenada
// cronologicamente (tie-break por id). `notes` tem default [] p/ não quebrar
// callers/testes de 2 args.
export function mergeThread(
  messages: Message[],
  events: ConversationEvent[],
  notes: ConversationNote[] = [],
): ThreadItem[] {
  const items: ThreadItem[] = [
    ...messages.map((m) => ({ kind: "message" as const, id: m.id, created_at: m.created_at, msg: m })),
    ...events.map((e) => ({ kind: "event" as const, id: e.id, created_at: e.created_at, ev: e })),
    ...notes.map((n) => ({ kind: "note" as const, id: n.id, created_at: n.created_at, note: n })),
  ];
  return items.sort((a, b) => {
    const d = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}
