// ============================================================
// sales-cron.ts — worker (I/O) de atribuição de venda via matrícula MB.
// Re-consulta a Millaborges p/ contatos da janela (o snapshot student_info só
// atualiza ao abrir a conversa) e grava vendas atribuídas ao atendente humano.
// Cadência: 1x/dia (no-op temporal de 20h) — o sidecar pode chamar mais vezes.
// Regra pura fica em ./sales-attribution.ts; aqui é só orquestração + I/O.
// ============================================================
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { fetchStudentInfo, type StudentInfoResponse } from '@/lib/integrations/student-info'
import { pickAttributableSales, detectReversions } from './sales-attribution'
import { classifySaleType } from './sale-type'
import { AI_AGENT_USER_ID } from '@/lib/ai-agent/constants'

const NO_OP_HOURS = 20      // não roda 2x no mesmo dia
const CAP_PER_RUN = 500     // teto de contatos por conta/execução (timeout do curl)
const BATCH = 8             // chamadas MB em paralelo por lote

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Resolve o atendente HUMANO da conversa (evento mais recente → responsável atual),
// descartando ids de IA. null = sem humano (venda não é contada pela RPC).
function resolveResponsible(
  assignedAgentId: string | null,
  events: { to_agent_id: string | null }[],
  aiAgentIds: Set<string>,
): string | null {
  for (const e of events) {
    if (e.to_agent_id && !aiAgentIds.has(e.to_agent_id)) return e.to_agent_id
  }
  if (assignedAgentId && !aiAgentIds.has(assignedAgentId)) return assignedAgentId
  return null
}

type ConvRow = {
  id: string
  contact_id: string
  connection_id: string | null
  assigned_agent_id: string | null
  ai_topic: string | null
  report_intent: string | null   // Fase 3: fallback de intenção quando ai_topic null
}

// Processa uma conta: re-consulta MB e grava/reverte vendas. Retorna contagens.
async function processAccount(
  acc: string,
  encKey: string | null,
  windowDays: number,
): Promise<{ contacts: number; matched: number; inserted: number; reverted: number }> {
  const db = supabaseAdmin()
  // key: tenta decriptar (catch → null) e cai no env como fallback. Nunca logada.
  let key: string | null = null
  try {
    key = encKey ? decrypt(encKey) : null
  } catch {
    key = null
  }
  key = key ?? process.env.API_ALUNO_KEY ?? null
  if (!key) return { contacts: 0, matched: 0, inserted: 0, reverted: 0 }

  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  // ids de IA (bot genérico + perfis) — nunca recebem crédito de venda.
  const { data: aiProfiles } = await db.from('ai_profiles').select('id').eq('account_id', acc)
  const aiAgentIds = new Set<string>([AI_AGENT_USER_ID, ...((aiProfiles as { id: string }[] | null) ?? []).map((p) => p.id)])

  // cursos que contam como venda
  const { data: paidRows } = await db
    .from('mb_paid_courses').select('id_curso').eq('account_id', acc).eq('enabled', true)
  const paidCourseIds = new Set<number>(((paidRows as { id_curso: number }[] | null) ?? []).map((r) => r.id_curso))
  if (paidCourseIds.size === 0) return { contacts: 0, matched: 0, inserted: 0, reverted: 0 }

  // conjunto de conversas = atividade recente ∪ conversas com venda confirmada na janela (p/ reversão)
  const [{ data: activeConvs }, { data: revertConvs }] = await Promise.all([
    db.from('conversations').select('id, contact_id, connection_id, assigned_agent_id, ai_topic, report_intent')
      .eq('account_id', acc).gte('last_message_at', cutoff),
    db.from('attributed_sales').select('conversation_id')
      .eq('account_id', acc).eq('status', 'confirmed').gte('data_matricula', cutoff),
  ])
  const convById = new Map<string, ConvRow>()
  for (const c of (activeConvs as ConvRow[] | null) ?? []) convById.set(c.id, c)
  const revertIds = [...new Set(((revertConvs as { conversation_id: string }[] | null) ?? []).map((r) => r.conversation_id))]
  // carrega as conversas de reversão que não vieram em "ativas"
  const missing = revertIds.filter((id) => !convById.has(id))
  if (missing.length) {
    const { data: extra } = await db.from('conversations')
      .select('id, contact_id, connection_id, assigned_agent_id, ai_topic, report_intent').in('id', missing)  // 2ª busca (reversão)
    for (const c of (extra as ConvRow[] | null) ?? []) convById.set(c.id, c)
  }

  const convs = [...convById.values()].slice(0, CAP_PER_RUN)
  if (convs.length === 0) return { contacts: 0, matched: 0, inserted: 0, reverted: 0 }
  const convIds = convs.map((c) => c.id)
  const contactIds = [...new Set(convs.map((c) => c.contact_id))]

  // contatos (email/phone), 1ª msg do cliente, eventos e vendas existentes — em lote
  const [{ data: contacts }, { data: msgsRows }, { data: events }, { data: existing }] = await Promise.all([
    db.from('contacts').select('id, email, phone').in('id', contactIds),
    // TODAS as msgs (qualquer sender), ordem cronológica → deriva 1º contato do
    // cliente (âncora da janela) E o sender da 1ª msg da conversa (ativa/passiva).
    db.from('messages').select('conversation_id, sender_type, created_at')
      .in('conversation_id', convIds).order('created_at', { ascending: true }),
    db.from('conversation_events').select('conversation_id, to_agent_id, created_at')
      .in('conversation_id', convIds).order('created_at', { ascending: false }),
    db.from('attributed_sales').select('conversation_id, id_curso, data_matricula')
      .eq('account_id', acc).in('conversation_id', convIds).eq('status', 'confirmed'),
  ])

  const contactById = new Map((contacts as { id: string; email: string | null; phone: string | null }[] | null ?? []).map((c) => [c.id, c]))
  const firstMsgByConv = new Map<string, string>()           // 1ª msg do CLIENTE (janela)
  const firstSenderByConv = new Map<string, 'customer' | 'agent' | 'bot'>() // sender da 1ª msg (ativa/passiva)
  for (const m of (msgsRows as { conversation_id: string; sender_type: 'customer' | 'agent' | 'bot'; created_at: string }[] | null) ?? []) {
    if (!firstSenderByConv.has(m.conversation_id)) firstSenderByConv.set(m.conversation_id, m.sender_type)
    if (m.sender_type === 'customer' && !firstMsgByConv.has(m.conversation_id)) {
      firstMsgByConv.set(m.conversation_id, m.created_at)
    }
  }
  const eventsByConv = new Map<string, { to_agent_id: string | null }[]>()
  for (const e of (events as { conversation_id: string; to_agent_id: string | null }[] | null) ?? []) {
    const arr = eventsByConv.get(e.conversation_id) ?? []
    arr.push({ to_agent_id: e.to_agent_id })
    eventsByConv.set(e.conversation_id, arr)
  }
  const existingByConv = new Map<string, { id_curso: number; data_matricula: string }[]>()
  for (const s of (existing as { conversation_id: string; id_curso: number; data_matricula: string }[] | null) ?? []) {
    const arr = existingByConv.get(s.conversation_id) ?? []
    arr.push({ id_curso: s.id_curso, data_matricula: s.data_matricula })
    existingByConv.set(s.conversation_id, arr)
  }

  let contactsChecked = 0, matched = 0, inserted = 0, reverted = 0

  // processa em lotes (throttle p/ não estourar rate-limit da MB)
  for (let i = 0; i < convs.length; i += BATCH) {
    const slice = convs.slice(i, i + BATCH)
    await Promise.all(slice.map(async (conv) => {
      const contact = contactById.get(conv.contact_id)
      if (!contact || (!contact.email && !contact.phone)) return // sem identificador → não chama MB
      const firstContact = firstMsgByConv.get(conv.id)
      if (!firstContact) return // sem msg do cliente → sem turno de venda
      contactsChecked++

      let payload: StudentInfoResponse
      try {
        payload = await fetchStudentInfo({ apiKey: key as string, email: contact.email, phone: contact.phone })
      } catch {
        return // falha de rede/timeout — sem retry (não amplificar); próximo run tenta de novo
      }
      // snapshot (não sobrescreve um bom com erro)
      if (['success', 'nao_encontrado', 'multiplos'].includes(payload.status)) {
        await db.from('student_info').upsert(
          { account_id: acc, contact_id: conv.contact_id, status: payload.status, matched_by: payload.matched_by ?? null, payload, fetched_at: new Date().toISOString() },
          { onConflict: 'account_id,contact_id' },
        )
      }
      if (payload.status === 'success') matched++

      const responsibleUserId = resolveResponsible(conv.assigned_agent_id, eventsByConv.get(conv.id) ?? [], aiAgentIds)
      // Fase 3: report_intent (classificador) é fallback de ai_topic p/ elevar confidence.
      const isVendas = conv.ai_topic === 'vendas' || conv.report_intent === 'vendas'
      // ativa/passiva pela direção da 1ª msg da conversa (Fase 3).
      const saleType = classifySaleType(firstSenderByConv.get(conv.id) ?? null)
      const candidates = pickAttributableSales({
        payload, paidCourseIds, firstContactAt: new Date(firstContact), windowDays,
        responsibleUserId, aiTopicIsVendas: isVendas,
      })
      if (candidates.length) {
        const { data: ins } = await db.from('attributed_sales').upsert(
          candidates.map((s) => ({
            account_id: acc, conversation_id: conv.id, contact_id: conv.contact_id,
            connection_id: conv.connection_id, atendente_id: s.atendente_id,
            id_curso: s.id_curso, nome_curso: s.nome_curso, data_matricula: s.data_matricula,
            confidence: s.confidence, sale_type: saleType,
          })),
          { onConflict: 'account_id,conversation_id,id_curso', ignoreDuplicates: true },
        ).select('id')
        inserted += (ins as { id: string }[] | null)?.length ?? 0
      }

      // reversão: vendas confirmadas cujo curso sumiu do retorno e cuja janela está aberta
      const confirmed = existingByConv.get(conv.id) ?? []
      if (confirmed.length) {
        const windowOpen = (dm: string) => Date.now() <= new Date(dm).getTime() + windowDays * 86_400_000
        const toRevert = detectReversions(confirmed, payload, windowOpen)
        if (toRevert.length) {
          await db.from('attributed_sales').update({ status: 'reverted' })
            .eq('account_id', acc).eq('conversation_id', conv.id).in('id_curso', toRevert)
          reverted += toRevert.length
        }
      }
    }))
    await sleep(300) // respiro entre lotes
  }

  await db.from('sales_cron_runs').insert({
    account_id: acc, contacts_checked: contactsChecked, matched, sales_inserted: inserted, reverted,
  })
  return { contacts: contactsChecked, matched, inserted, reverted }
}

// Entrada do worker: no-op temporal + varre cada conta com key MB.
export async function runSalesCron(): Promise<{ skipped?: boolean; accounts?: number; inserted?: number; reverted?: number }> {
  const db = supabaseAdmin()
  // no-op se já rodou nas últimas NO_OP_HOURS (qualquer conta)
  const { data: last } = await db.from('sales_cron_runs').select('ran_at').order('ran_at', { ascending: false }).limit(1)
  const lastAt = (last as { ran_at: string }[] | null)?.[0]?.ran_at
  if (lastAt && Date.now() - new Date(lastAt).getTime() < NO_OP_HOURS * 3_600_000) {
    return { skipped: true }
  }

  const { data: cfgs } = await db.from('integrations_config')
    .select('account_id, millaborges_api_key, mb_attribution_window_days')
    .not('millaborges_api_key', 'is', null)
  const rows = (cfgs as { account_id: string; millaborges_api_key: string | null; mb_attribution_window_days: number | null }[] | null) ?? []

  let inserted = 0, reverted = 0
  for (const cfg of rows) {
    const r = await processAccount(cfg.account_id, cfg.millaborges_api_key, cfg.mb_attribution_window_days ?? 30)
    inserted += r.inserted
    reverted += r.reverted
  }
  return { accounts: rows.length, inserted, reverted }
}
