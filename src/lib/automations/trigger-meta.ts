import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  /** Rótulo em inglês (fallback; ainda usado pelo builder não-migrado). */
  label: string
  /** Chave i18n (namespace automations) resolvida com t no render. */
  labelKey: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    label: 'New Message',
    labelKey: 'triggerNewMessage',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
  first_inbound_message: {
    label: 'First Message from Contact',
    labelKey: 'triggerFirstInbound',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  },
  keyword_match: {
    label: 'Keyword Match',
    labelKey: 'triggerKeywordMatch',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  },
  new_contact_created: {
    label: 'New Contact',
    labelKey: 'triggerNewContact',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    label: 'Conversation Assigned',
    labelKey: 'triggerConversationAssigned',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  },
  tag_added: {
    label: 'Tag Added',
    labelKey: 'triggerTagAdded',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  time_based: {
    label: 'Time-Based',
    labelKey: 'triggerTimeBased',
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  },
}

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? {
      label: t,
      labelKey: t,
      pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
    }
  )
}

// Tempo relativo localizado. Recebe o `t` (namespace automations) do componente
// que chama, para resolver "nunca"/"agora"/"há Nmin/h/d" no idioma ativo.
type RelTFn = (key: string, opts?: Record<string, unknown>) => string

export function formatRelative(
  iso: string | null | undefined,
  t: RelTFn,
): string {
  if (!iso) return t('relNever')
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return t('relNever')
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('relJustNow')
  if (diffSec < 3600) return t('relMinAgo', { n: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('relHourAgo', { n: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('relDayAgo', { n: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString()
}
