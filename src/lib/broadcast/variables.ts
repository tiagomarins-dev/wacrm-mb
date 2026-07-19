import type { SupabaseClient } from '@supabase/supabase-js'
import type { Contact } from '@/types'

/**
 * Mapeamento de variável de template — cada placeholder (`{{1}}`, `{{2}}`…,
 * pela chave) é resolvido no envio. `static` = valor fixo; `field` = campo
 * embutido do contato (name/phone/email/company); `custom_field` = valor em
 * contact_custom_values keyed pelo custom_fields.id guardado em `value`.
 *
 * Extraído do hook client para ser reusado pelo engine server (envio agendado).
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string }
  /** Valor vem do payload do webhook (value = chave, ex 'link_aula').
   *  NUNCA chega no engine: o clone materializa em 'static' antes. */
  | { type: 'payload'; value: string }

/** contactId → (customFieldId → value). */
export type CustomValueIndex = Map<string, Map<string, string>>

/**
 * Resolve os placeholders de um template para um contato. Funções `static` e
 * `field` resolvem direto; `custom_field` lê do índice pré-carregado (evita
 * N+1 no loop de envio). Função pura — usada igual no browser e no servidor.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Chaves normalmente "1","2",... — ordenação numérica mantém {{1}} antes de {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a)
    const bn = Number(b)
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
    return a.localeCompare(b)
  })

  return keys.map((key) => {
    const v = variables[key]
    if (v.type === 'static') return v.value

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      }
      return fieldMap[v.value] ?? ''
    }

    // payload não deveria chegar aqui (o clone do webhook materializa em
    // 'static' antes de gravar) — defensivo pra nunca vazar o placeholder
    if (v.type === 'payload') {
      console.warn('[broadcast] variável payload não materializada:', key)
      return ''
    }

    // custom_field
    return customValues?.get(v.value) ?? ''
  })
}

/**
 * Busca em lote os contact_custom_values de um conjunto de contatos. Retorna
 * um índice contact_id → field_id → value. Aceita qualquer SupabaseClient
 * (browser ou service-role) para servir tanto o hook quanto o engine server.
 */
export async function fetchCustomValueIndex(
  supabase: SupabaseClient,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map()
  if (contactIds.length === 0) return index

  // PostgREST limita o IN(...) ~1000 valores — pagina para ficar seguro.
  const PAGE = 500
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE)
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice)

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>()
      bucket.set(row.custom_field_id, row.value ?? '')
      index.set(row.contact_id, bucket)
    }
  }
  return index
}

/**
 * Chaves do payload referenciadas pelas variáveis do blueprint —
 * usadas pra validar o request do webhook antes de qualquer efeito.
 */
export function collectPayloadKeys(
  variables: Record<string, VariableMapping>,
): string[] {
  const keys = new Set<string>()
  for (const v of Object.values(variables ?? {})) {
    if (v.type === 'payload' && v.value) keys.add(v.value)
  }
  return [...keys]
}

/**
 * Materializa variáveis 'payload' em 'static' com os valores do request —
 * o clone grava o resultado e o engine (resolveVariables) segue intocado.
 * Não muta o input.
 */
export function materializePayloadVariables(
  variables: Record<string, VariableMapping>,
  payload: Record<string, unknown>,
): Record<string, VariableMapping> {
  const out: Record<string, VariableMapping> = {}
  for (const [key, v] of Object.entries(variables ?? {})) {
    out[key] =
      v.type === 'payload'
        ? { type: 'static', value: String(payload[v.value] ?? '') }
        : v
  }
  return out
}
