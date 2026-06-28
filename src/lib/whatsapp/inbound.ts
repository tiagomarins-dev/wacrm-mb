// ============================================================
// Criação idempotente de contato/conversa no inbound. Extraído do
// webhook (mover, não reescrever) p/ ser reusado pelo cron Evolution
// (fase D). Única mudança vs. o original: recebe `db` (service-role)
// como 1º argumento — o webhook passa supabaseAdmin(); o cron passa o
// seu próprio admin client.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

export interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

// Acha (por telefone, dedup por-conexão) ou cria o contato do inbound.
export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  connectionId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  // Dedup é por-conexão (033): o mesmo número em duas conexões da conta
  // gera dois contatos (sem isso, casaria o contato da outra conexão).
  const existingContact = await findExistingContact(
    db,
    accountId,
    phone,
    connectionId,
  )

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      connection_id: connectionId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone, connectionId)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

// Acha (por contato, escopado à conexão) ou cria a conversa do inbound.
export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  connectionId: string,
  contactId: string,
) {
  // Busca a conversa existente DESTE contato NESTA conexão (033). Sem o
  // filtro por connection_id, o mesmo contato em duas conexões colidiria
  // — e o `.single()` antigo lançaria PGRST116 com 2 linhas. `.maybeSingle()`
  // trata 0 linhas como caso normal (cai na criação).
  const { data: existing } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('connection_id', connectionId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) {
    return existing
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      connection_id: connectionId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    // Perdeu a race: outra entrega concorrente criou a conversa entre o
    // lookup e o insert; o índice UNIQUE (migration 041) rejeitou a
    // duplicata. Re-resolve em vez de derrubar a mensagem — espelha o
    // recovery de findOrCreateContact acima. O `.limit(1)` é salvaguarda:
    // com o índice ativo só pode existir 1 linha.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('connection_id', connectionId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (raced) return raced
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return newConv
}

// Acha (por chat_id, escopado à conexão) ou cria a conversa de GRUPO (058).
// Espelha findOrCreateConversation, mas keia por chat_id (@g.us), contact_id
// NULL e is_group=true. O nome do grupo (best-effort) entra só no create como
// preview; a UI cai no fallback "Grupo" quando não há.
export async function findOrCreateGroupConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  connectionId: string,
  chatId: string,
  groupName: string | null,
) {
  const { data: existing } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('connection_id', connectionId)
    .eq('chat_id', chatId)
    .eq('is_group', true)
    .maybeSingle()

  if (existing) return existing

  const { data: created, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      connection_id: connectionId,
      contact_id: null,
      is_group: true,
      chat_id: chatId,
      last_message_text: groupName ? `[grupo] ${groupName}` : null,
    })
    .select()
    .single()

  if (createError) {
    // Mesma recuperação de race: índice único de grupo (058) rejeita a
    // duplicata concorrente → re-resolve por chat_id.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('connection_id', connectionId)
        .eq('chat_id', chatId)
        .eq('is_group', true)
        .maybeSingle()
      if (raced) return raced
    }
    console.error('Error creating group conversation:', createError)
    return null
  }

  return created
}
