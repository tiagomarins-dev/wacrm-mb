"use client"

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import { useActiveConnection } from "@/hooks/use-active-connection"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { toast } from "sonner"
import {
  ArrowLeft,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
  MessageSquare,
  FileText,
  Tag,
  TagIcon,
  UserCheck,
  PencilLine,
  Briefcase,
  Hourglass,
  GitBranch,
  Webhook,
  CircleSlash,
  Zap,
  Loader2,
  ArrowDown,
  ArrowUp,
  Bot,
  Copy,
  RefreshCw,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type {
  AccountMember,
  AiProfilePublic,
  AutomationStepType,
  AutomationTriggerType,
  CustomField,
  KeywordMatchTriggerConfig,
  MessageTemplate,
  Tag as TagRecord,
} from "@/types"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"

// ------------------------------------------------------------
// Types (builder-local — mirror the flattened rows we POST)
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client id; the API assigns real UUIDs server-side. */
  cid: string
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branches?: { yes: BuilderStep[]; no: BuilderStep[] }
}

export interface BuilderInitial {
  id?: string
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  is_active: boolean
  steps: BuilderStep[]
  /** Token do trigger webhook (gerado no servidor ao salvar; mig 074). */
  webhook_token?: string | null
}

// ------------------------------------------------------------
// Step metadata — one source of truth for icon + label + border color
// ------------------------------------------------------------

interface StepMeta {
  // Chave i18n do rótulo do passo (resolvida com t no render).
  labelKey: string
  // Rótulo original em inglês usado como defaultValue do t.
  labelEn: string
  icon: typeof Zap
  /** Left-border accent color per spec. */
  border: string
}

const STEP_META: Record<AutomationStepType, StepMeta> = {
  send_message: { labelKey: "stepSendMessage", labelEn: "Send Message", icon: MessageSquare, border: "border-l-primary" },
  send_template: { labelKey: "stepSendTemplate", labelEn: "Send Template", icon: FileText, border: "border-l-primary" },
  add_tag: { labelKey: "stepAddTag", labelEn: "Add Tag", icon: Tag, border: "border-l-primary" },
  remove_tag: { labelKey: "stepRemoveTag", labelEn: "Remove Tag", icon: TagIcon, border: "border-l-primary" },
  assign_conversation: { labelKey: "stepAssignConversation", labelEn: "Assign Conversation", icon: UserCheck, border: "border-l-primary" },
  update_contact_field: { labelKey: "stepUpdateContactField", labelEn: "Update Contact Field", icon: PencilLine, border: "border-l-primary" },
  create_deal: { labelKey: "stepCreateDeal", labelEn: "Create Deal", icon: Briefcase, border: "border-l-primary" },
  wait: { labelKey: "stepWait", labelEn: "Wait", icon: Hourglass, border: "border-l-border" },
  condition: { labelKey: "stepCondition", labelEn: "Condition (If/Else)", icon: GitBranch, border: "border-l-amber-500" },
  send_webhook: { labelKey: "stepSendWebhook", labelEn: "Send Webhook", icon: Webhook, border: "border-l-primary" },
  close_conversation: { labelKey: "stepCloseConversation", labelEn: "Close Conversation", icon: CircleSlash, border: "border-l-primary" },
  ai_reply: { labelKey: "stepAiReply", labelEn: "Reply with AI", icon: Bot, border: "border-l-primary" },
}

const ADDABLE_STEPS: AutomationStepType[] = [
  "send_message",
  "send_template",
  "add_tag",
  "remove_tag",
  "assign_conversation",
  "update_contact_field",
  "create_deal",
  "wait",
  "condition",
  "send_webhook",
  "close_conversation",
  "ai_reply",
]

// Opções de gatilho. Os rótulos reutilizam as chaves já existentes no
// namespace `automations` (labelKey + labelEn como defaultValue); as dicas
// (hintKey) ficam no namespace novo `automationBuilder`.
const TRIGGER_OPTIONS: {
  value: AutomationTriggerType
  labelKey: string
  labelEn: string
  hintKey: string
  hintEn: string
}[] = [
  {
    value: "new_message_received",
    labelKey: "triggerNewMessage",
    labelEn: "New Message Received",
    hintKey: "triggerNewMessageHint",
    hintEn: "Any incoming message",
  },
  {
    value: "first_inbound_message",
    labelKey: "triggerFirstInbound",
    labelEn: "First Message from Contact",
    hintKey: "triggerFirstInboundHint",
    hintEn: "First time this contact ever messages you (works for manually-added contacts too)",
  },
  {
    value: "keyword_match",
    labelKey: "triggerKeywordMatch",
    labelEn: "Keyword Match",
    hintKey: "triggerKeywordMatchHint",
    hintEn: "Message contains specific keyword(s)",
  },
  {
    value: "new_contact_created",
    labelKey: "triggerNewContact",
    labelEn: "New Contact Created",
    hintKey: "triggerNewContactHint",
    hintEn: "When a contact is auto-created from an incoming message",
  },
  {
    value: "conversation_assigned",
    labelKey: "triggerConversationAssigned",
    labelEn: "Conversation Assigned",
    hintKey: "triggerConversationAssignedHint",
    hintEn: "When assigned to an agent",
  },
  {
    value: "tag_added",
    labelKey: "triggerTagAdded",
    labelEn: "Tag Added",
    hintKey: "triggerTagAddedHint",
    hintEn: "When a tag is added to a contact",
  },
  {
    value: "time_based",
    labelKey: "triggerTimeBased",
    labelEn: "Time-Based",
    hintKey: "triggerTimeBasedHint",
    hintEn: "On a recurring schedule",
  },
  {
    value: "webhook_received",
    labelKey: "triggerWebhook",
    labelEn: "Webhook (HTTP)",
    hintKey: "triggerWebhookHint",
    hintEn: "Fire when an external system POSTs to this automation's unique URL",
  },
]

function cid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { text: "" }
    case "send_template":
      return { template_name: "", language: "en_US" }
    case "add_tag":
    case "remove_tag":
      return { tag_id: "" }
    case "assign_conversation":
      return { mode: "round_robin" }
    case "update_contact_field":
      return { field: "name", value: "" }
    case "create_deal":
      return { pipeline_id: "", stage_id: "", title: "", value: 0 }
    case "wait":
      return { amount: 1, unit: "hours" }
    case "condition":
      return { subject: "tag_presence", operand: "", value: "" }
    case "send_webhook":
      return { url: "", headers: {}, body_template: "" }
    case "close_conversation":
      return {}
    case "ai_reply":
      // Campo opcional: nasce vazio p/ o passo continuar válido sem preenchimento.
      return { campaign_context: "" }
    default:
      return {}
  }
}

// ------------------------------------------------------------
// Account resources (tags, members, approved templates)
//
// Loaded once at the builder root and shared via context so the
// tag / agent / template pickers below can offer existing resources
// by name instead of asking the user to paste raw UUIDs. Every picker
// falls back to a raw input when its list is empty (fresh account or
// an older deployment), so an automation is always authorable.
// ------------------------------------------------------------

interface AutomationResources {
  tags: TagRecord[]
  members: AccountMember[]
  templates: MessageTemplate[]
  customFields: CustomField[]
  aiProfiles: AiProfilePublic[]
}

const ResourcesContext = createContext<AutomationResources>({
  tags: [],
  members: [],
  templates: [],
  customFields: [],
  aiProfiles: [],
})

function useResources(): AutomationResources {
  return useContext(ResourcesContext)
}

function ResourcesProvider({ children }: { children: ReactNode }) {
  const [tags, setTags] = useState<TagRecord[]>([])
  const [members, setMembers] = useState<AccountMember[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [aiProfiles, setAiProfiles] = useState<AiProfilePublic[]>([])
  // Conexão ativa (033): a automação é gravada com connection_id = ativa
  // (api/automations/route.ts), então os templates listados são os dela.
  const { activeConnectionId } = useActiveConnection()

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    // Tags, templates and custom fields come straight from the DB — RLS
    // scopes them to the caller's account. Only APPROVED templates can
    // actually be sent (anything else 400s at send time), matching the
    // broadcast picker.
    // Filtra os templates pela conexão ativa (033) quando houver.
    let tplQuery = supabase
      .from("message_templates")
      .select("*")
      .eq("status", "APPROVED")
    if (activeConnectionId) tplQuery = tplQuery.eq("connection_id", activeConnectionId)

    void (async () => {
      const [tagsRes, templatesRes, customFieldsRes, aiProfilesRes] = await Promise.all([
        supabase.from("tags").select("*").order("name"),
        tplQuery.order("name"),
        supabase.from("custom_fields").select("*").order("field_name"),
        // Perfis de IA atribuíveis — view pública (RLS escopa por conta).
        supabase.from("ai_profiles_public").select("id, nome, enabled").eq("enabled", true),
      ])
      if (cancelled) return
      setTags((tagsRes.data as TagRecord[] | null) ?? [])
      setTemplates((templatesRes.data as MessageTemplate[] | null) ?? [])
      setCustomFields((customFieldsRes.data as CustomField[] | null) ?? [])
      setAiProfiles((aiProfilesRes.data as AiProfilePublic[] | null) ?? [])
    })()

    // Members go through the API so we inherit its email-visibility
    // rules (agents/viewers don't see emails). Unreachable on older
    // deployments → pickers fall back to a raw agent-id input.
    void (async () => {
      try {
        const res = await fetch("/api/account/members", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { members?: AccountMember[] }
        if (!cancelled) setMembers(json.members ?? [])
      } catch {
        // Members endpoint absent — caller falls back to raw input.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeConnectionId])

  return (
    <ResourcesContext.Provider value={{ tags, members, templates, customFields, aiProfiles }}>
      {children}
    </ResourcesContext.Provider>
  )
}

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

/** Tag dropdown by name + color, storing the tag's id. Falls back to a
 *  raw id input when no tags exist yet. */
function TagSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useTranslation(["automationBuilder", "automations", "common"])
  const { tags } = useResources()
  // Param renomeado para `tag` para não sombrear o `t` da tradução.
  if (tags.length === 0) {
    return (
      <Input
        placeholder={t("tagIdPlaceholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = tags.find((tag) => tag.id === value)
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: selected?.color ?? "transparent" }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">{t("selectTag")}</option>
        {tags.map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.name}
          </option>
        ))}
        {/* Preserve a saved tag that's since been deleted so editing an
            existing automation doesn't silently drop it. */}
        {value && !selected && (
          <option value={value}>{t("unknownTagOption", { value })}</option>
        )}
      </select>
    </div>
  )
}

/** Contact-field dropdown for "Update Contact Field": built-in columns plus
 *  any account custom fields (stored as `custom:<id>`). A saved custom field
 *  that's since been deleted is preserved as a labelled option so editing an
 *  existing automation doesn't silently drop it. */
function ContactFieldSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useTranslation(["automationBuilder", "common"])
  const { customFields } = useResources()
  const customValue = value.startsWith("custom:") ? value : ""
  const knownCustom =
    customValue && customFields.some((f) => `custom:${f.id}` === customValue)
  return (
    <select
      value={value || "name"}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="name">{t("fieldName")}</option>
      <option value="email">{t("fieldEmail")}</option>
      <option value="company">{t("fieldCompany")}</option>
      {customFields.length > 0 && (
        <optgroup label={t("customFieldsGroup")}>
          {customFields.map((f) => (
            <option key={f.id} value={`custom:${f.id}`}>
              {f.field_name}
            </option>
          ))}
        </optgroup>
      )}
      {customValue && !knownCustom && (
        <option value={customValue}>
          {t("unknownFieldOption", { value: customValue })}
        </option>
      )}
    </select>
  )
}

/** Agent dropdown by name, storing the member's user_id. Falls back to
 *  a raw id input when the member list is unavailable. */
function AgentSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useTranslation(["automationBuilder", "common"])
  const { members, aiProfiles } = useResources()
  const isAiValue = aiProfiles.some((ap) => ap.id === value)
  // Sem membros carregados ainda: oferece os perfis de IA + entrada manual de id.
  if (members.length === 0) {
    return (
      <select
        value={isAiValue ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">{t("selectAgent")}</option>
        {aiProfiles.map((ap) => (
          <option key={ap.id} value={ap.id}>
            🤖 {ap.nome}
          </option>
        ))}
      </select>
    )
  }
  const selected = members.find((m) => m.user_id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">{t("selectAgent")}</option>
      {/* Perfis de IA (responsáveis virtuais). Atribuir a conversa a um deles faz
          o agente assumir com a config DAQUELE perfil (ex: gatilho "AJUDA" →
          atribuir ao perfil Suporte). */}
      {aiProfiles.map((ap) => (
        <option key={ap.id} value={ap.id}>
          🤖 {ap.nome}
        </option>
      ))}
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
      {value && !selected && !isAiValue && (
        <option value={value}>{t("unknownAgentOption", { value })}</option>
      )}
    </select>
  )
}

/** Template dropdown showing approved templates by name + language,
 *  storing both template_name and language. Falls back to manual name +
 *  language inputs when no approved templates are synced yet. */
function SendTemplateFields({
  templateName,
  language,
  variables,
  onChange,
}: {
  templateName: string
  language: string
  variables: Record<string, string>
  onChange: (patch: {
    template_name: string
    language: string
    variables?: Record<string, string>
  }) => void
}) {
  const { t } = useTranslation(["automationBuilder", "common"])
  const { templates } = useResources()

  // Grava uma variável posicional preservando nome/idioma atuais.
  const setVariable = (key: string, value: string) =>
    onChange({
      template_name: templateName,
      language,
      variables: { ...variables, [key]: value },
    })

  if (templates.length === 0) {
    return (
      <>
        <FieldBlock label={t("templateName")}>
          <Input
            value={templateName}
            onChange={(e) =>
              onChange({ template_name: e.target.value, language, variables })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("language")}>
          <Input
            value={language}
            onChange={(e) =>
              onChange({
                template_name: templateName,
                language: e.target.value,
                variables,
              })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <TemplateVariablesEditor
          variables={variables}
          onSet={setVariable}
          onRemove={(key) => {
            const next = { ...variables }
            delete next[key]
            onChange({ template_name: templateName, language, variables: next })
          }}
          manual
        />
      </>
    )
  }

  // Encode name + language in the option value so two templates that
  // share a name across languages stay distinct.
  const toValue = (name: string, lang: string) => `${name}::${lang}`
  const current = templateName ? toValue(templateName, language) : ""
  const selected = templates.find(
    (tpl) => toValue(tpl.name, tpl.language ?? "en_US") === current,
  )

  // Placeholders {{1}}, {{2}}… do corpo do template selecionado, em ordem
  // numérica — cada um vira um input de variável.
  const placeholders = selected
    ? [...new Set(selected.body_text?.match(/\{\{(\d+)\}\}/g) ?? [])]
        .map((m) => m.replace(/\D/g, ""))
        .sort((a, b) => Number(a) - Number(b))
    : []

  return (
    <>
      <FieldBlock label={t("template")}>
        <select
          value={current}
          onChange={(e) => {
            const [name, lang] = e.target.value.split("::")
            // Trocar de template zera as variáveis — as posições do antigo
            // não têm relação com as do novo.
            onChange({
              template_name: name ?? "",
              language: lang ?? "",
              variables: {},
            })
          }}
          className={SELECT_CLASS}
        >
          <option value="">{t("selectTemplate")}</option>
          {/* Param renomeado para `tpl` para não sombrear o `t` da tradução. */}
          {templates.map((tpl) => {
            const lang = tpl.language ?? "en_US"
            return (
              <option key={tpl.id} value={toValue(tpl.name, lang)}>
                {tpl.name} ({lang})
              </option>
            )
          })}
          {current && !selected && (
            <option value={current}>
              {t("templateNotApproved", {
                name: templateName,
                language: language || t("unknownLanguage"),
              })}
            </option>
          )}
        </select>
      </FieldBlock>
      {selected?.body_text && (
        <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 text-[10px] leading-relaxed text-muted-foreground">
          {selected.body_text}
        </pre>
      )}
      {placeholders.length > 0 ? (
        <FieldBlock label={t("templateVariables")}>
          <div className="space-y-1.5">
            {placeholders.map((key) => (
              <div key={key} className="flex items-start gap-1.5">
                <span className="w-10 shrink-0 pt-2 font-mono text-[11px] text-muted-foreground">{`{{${key}}}`}</span>
                <VariableValueField
                  value={variables[key] ?? ""}
                  onChange={(v) => setVariable(key, v)}
                />
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("templateVariablesHint", { example: "{{vars.campo}}" })}
          </p>
        </FieldBlock>
      ) : (
        current &&
        !selected && (
          <TemplateVariablesEditor
            variables={variables}
            onSet={setVariable}
            onRemove={(key) => {
              const next = { ...variables }
              delete next[key]
              onChange({ template_name: templateName, language, variables: next })
            }}
            manual
          />
        )
      )}
    </>
  )
}

/** Valor de uma variável de template: select com as origens conhecidas
 *  (payload do webhook + campos customizados + contexto) e opção "Texto
 *  livre" que abre um input. Valor que não casa com nenhum token conhecido
 *  cai automaticamente no modo texto livre. */
const FREE_TEXT = "__free__"

function VariableValueField({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useTranslation(["automationBuilder", "common"])
  const { customFields } = useResources()

  // Só campos cujo nome o interpolate() consegue resolver ({{vars.x}} usa
  // [\w.]+ — letras/dígitos/underscore, sem espaço nem acento).
  const interpolableFields = customFields.filter((f) =>
    /^\w+$/.test(f.field_name),
  )

  const payloadTokens = [
    { token: "{{vars.name}}", label: "name" },
    { token: "{{vars.phone}}", label: "phone" },
    { token: "{{vars.email}}", label: "email" },
  ]
  const contextTokens = [
    { token: "{{message.text}}", label: t("varMessageText") },
  ]
  const knownTokens = [
    ...payloadTokens.map((o) => o.token),
    ...interpolableFields.map((f) => `{{vars.${f.field_name}}}`),
    ...contextTokens.map((o) => o.token),
  ]

  // Modo texto livre: valor preenchido que não é token conhecido, ou
  // escolha explícita do usuário (estado local — valor vazio é ambíguo).
  const [freeMode, setFreeMode] = useState(
    () => value !== "" && !knownTokens.includes(value),
  )
  const isFree = freeMode || (value !== "" && !knownTokens.includes(value))
  const selectValue = isFree ? FREE_TEXT : value

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value
          if (v === FREE_TEXT) {
            setFreeMode(true)
            onChange("")
          } else {
            setFreeMode(false)
            onChange(v)
          }
        }}
        className={SELECT_CLASS}
      >
        <option value="">{t("varSelectSource")}</option>
        <optgroup label={t("varPayloadGroup")}>
          {payloadTokens.map((o) => (
            <option key={o.token} value={o.token}>
              {o.label} — {o.token}
            </option>
          ))}
        </optgroup>
        {interpolableFields.length > 0 && (
          <optgroup label={t("customFieldsGroup")}>
            {interpolableFields.map((f) => (
              <option key={f.id} value={`{{vars.${f.field_name}}}`}>
                {f.field_name} — {`{{vars.${f.field_name}}}`}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label={t("varContextGroup")}>
          {contextTokens.map((o) => (
            <option key={o.token} value={o.token}>
              {o.label}
            </option>
          ))}
        </optgroup>
        <option value={FREE_TEXT}>{t("varFreeText")}</option>
      </select>
      {isFree && (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("varFreeTextPlaceholder")}
          autoFocus={freeMode && value === ""}
          className="bg-muted text-xs text-foreground"
        />
      )}
    </div>
  )
}

/** Editor manual de variáveis posicionais (fallback quando o corpo do
 *  template não está sincronizado — sem placeholders pra derivar). */
function TemplateVariablesEditor({
  variables,
  onSet,
  onRemove,
  manual,
}: {
  variables: Record<string, string>
  onSet: (key: string, value: string) => void
  onRemove: (key: string) => void
  manual?: boolean
}) {
  const { t } = useTranslation(["automationBuilder", "common"])
  const keys = Object.keys(variables).sort((a, b) => Number(a) - Number(b))
  // Próxima posição livre: maior chave numérica + 1.
  const nextKey = String(
    keys.reduce((max, k) => Math.max(max, Number(k) || 0), 0) + 1,
  )
  if (!manual && keys.length === 0) return null
  return (
    <FieldBlock label={t("templateVariables")}>
      <div className="space-y-1.5">
        {keys.map((key) => (
          <div key={key} className="flex items-start gap-1.5">
            <span className="w-10 shrink-0 pt-2 font-mono text-[11px] text-muted-foreground">{`{{${key}}}`}</span>
            <VariableValueField
              value={variables[key] ?? ""}
              onChange={(v) => onSet(key, v)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onRemove(key)}
              title={t("common:delete")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-1.5"
        onClick={() => onSet(nextKey, "")}
      >
        <Plus className="h-3.5 w-3.5" />
        {t("templateAddVariable")}
      </Button>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {t("templateVariablesHint", { example: "{{vars.campo}}" })}
      </p>
    </FieldBlock>
  )
}

// ------------------------------------------------------------
// Main builder component
// ------------------------------------------------------------

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const { t } = useTranslation(["automationBuilder", "automations", "common"])
  const router = useRouter()
  const isEditing = !!initial.id
  const [state, setState] = useState<BuilderInitial>(initial)
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function patchTop<K extends keyof BuilderInitial>(key: K, value: BuilderInitial[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  // --- Step tree mutations (immutable) ---

  function updateStep(path: StepPath, updater: (s: BuilderStep) => BuilderStep) {
    setState((s) => ({ ...s, steps: mapAtPath(s.steps, path, updater) }))
  }

  function addStepAt(parent: ParentScope, index: number, type: AutomationStepType) {
    const node: BuilderStep = {
      cid: cid(),
      step_type: type,
      step_config: blankConfig(type),
      branches: type === "condition" ? { yes: [], no: [] } : undefined,
    }
    setState((s) => ({ ...s, steps: insertAt(s.steps, parent, index, node) }))
    setExpandedId(node.cid)
  }

  function deleteStepAt(path: StepPath) {
    setState((s) => ({ ...s, steps: removeAt(s.steps, path) }))
  }

  function moveStepAt(path: StepPath, direction: -1 | 1) {
    setState((s) => ({ ...s, steps: moveAt(s.steps, path, direction) }))
  }

  async function save() {
    setSaving(true)
    try {
      const payload = {
        name: state.name || "Untitled automation",
        description: state.description || null,
        trigger_type: state.trigger_type,
        trigger_config: state.trigger_config,
        is_active: state.is_active,
        steps: toApiSteps(state.steps),
      }

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // If the server blocked activation with validation issues,
        // surface the first concrete problem so the user can fix it
        // without opening DevTools for the full array.
        const firstIssue: { path?: string; message?: string } | undefined =
          body?.issues?.[0]
        if (firstIssue?.message) {
          toast.error(firstIssue.message, {
            description: firstIssue.path
              ? t("issueAtPath", { path: firstIssue.path })
              : undefined,
          })
        } else {
          toast.error(body?.error ?? t("toastSaveFailed"))
        }
        return
      }
      toast.success(isEditing ? t("toastSaved") : t("toastCreated"))
      // PATCH devolve o token do webhook quando gerado agora (trigger
      // trocado pra webhook ou clone sem token) — atualiza o card na hora.
      if (isEditing && typeof body?.webhook_token === "string") {
        setState((s) => ({ ...s, webhook_token: body.webhook_token }))
      }
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Top bar. At sub-sm widths the "Active" label is hidden and the
          switch moves to the right of the save button, so the name input
          gets maximum width. */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push("/automations")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("backToAutomations")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={state.name}
          onChange={(e) => patchTop("name", e.target.value)}
          placeholder={t("untitledAutomation")}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:bg-muted focus:outline-none sm:text-base"
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">{t("active")}</span>
          <Switch
            checked={state.is_active}
            onCheckedChange={(v) => patchTop("is_active", !!v)}
            aria-label={t("active")}
          />
        </div>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isEditing ? t("save") : t("saveDraft")}
        </Button>
      </header>

      {/* Canvas */}
      <div className="relative flex-1 overflow-y-auto">
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:20px_20px] pointer-events-none" />
        <div className="relative mx-auto flex max-w-4xl flex-col items-center gap-0 px-4 py-10">
          <ResourcesProvider>
            <TriggerCard
              type={state.trigger_type}
              config={state.trigger_config}
              onTypeChange={(t) => patchTop("trigger_type", t)}
              onConfigChange={(c) => patchTop("trigger_config", c)}
              webhookToken={state.webhook_token ?? null}
              automationId={initial.id}
              onWebhookTokenChange={(tok) =>
                setState((s) => ({ ...s, webhook_token: tok }))
              }
            />
            <StepList
              steps={state.steps}
              parentPath={[]}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
              updateStep={updateStep}
              addStepAt={addStepAt}
              deleteStepAt={deleteStepAt}
              moveStepAt={moveStepAt}
            />
          </ResourcesProvider>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Trigger card
// ------------------------------------------------------------

function TriggerCard({
  type,
  config,
  onTypeChange,
  onConfigChange,
  webhookToken,
  automationId,
  onWebhookTokenChange,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  onTypeChange: (t: AutomationTriggerType) => void
  onConfigChange: (c: Record<string, unknown>) => void
  webhookToken?: string | null
  automationId?: string
  onWebhookTokenChange?: (token: string) => void
}) {
  const { t } = useTranslation(["automationBuilder", "automations", "common"])
  const [open, setOpen] = useState(false)
  // Helper: resolve o rótulo do gatilho reutilizando o namespace `automations`.
  const triggerLabel = (o: (typeof TRIGGER_OPTIONS)[number]) =>
    t(`automations:${o.labelKey}`, { defaultValue: o.labelEn })
  const selectedOption = TRIGGER_OPTIONS.find((o) => o.value === type)
  return (
    // Largura fluida com teto de 520px: enche a coluna do canvas
    // (max-w-4xl + px-4) e encolhe sem estourar em telas menores.
    <div className="z-10 w-full max-w-[520px]">
      <div className="rounded-lg border border-border border-l-4 border-l-blue-500 bg-card shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-blue-300">{t("trigger")}</div>
            <div className="truncate text-sm font-medium text-foreground">
              {selectedOption ? triggerLabel(selectedOption) : type}
            </div>
          </div>
          <ChevronDown
            className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="space-y-3 border-t border-border px-4 py-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t("triggerType")}
              </label>
              <select
                value={type}
                onChange={(e) => onTypeChange(e.target.value as AutomationTriggerType)}
                className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                {TRIGGER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {triggerLabel(o)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {selectedOption
                  ? t(selectedOption.hintKey, { defaultValue: selectedOption.hintEn })
                  : null}
              </p>
            </div>
            {type === "keyword_match" && (
              <KeywordMatchConfig
                config={config as unknown as KeywordMatchTriggerConfig}
                onChange={onConfigChange}
              />
            )}
            {type === "tag_added" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("triggerTagLabel")}
                </label>
                <TagSelect
                  value={(config.tag_id as string) ?? ""}
                  onChange={(v) => onConfigChange({ ...config, tag_id: v })}
                />
              </div>
            )}
            {type === "time_based" && (
              <Input
                placeholder={t("timeBasedPlaceholder")}
                value={(config.schedule as string) ?? ""}
                onChange={(e) =>
                  onConfigChange({ ...config, schedule: e.target.value })
                }
                className="bg-muted text-foreground"
              />
            )}
            {type === "webhook_received" && (
              <WebhookTriggerConfig
                webhookToken={webhookToken ?? null}
                automationId={automationId}
                onTokenChange={onWebhookTokenChange}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Bloco de código somente-leitura com rótulo e botão de cópia no canto.
function CopyableBlock({
  label,
  content,
  copyTitle,
  onCopy,
}: {
  label: string
  content: string
  copyTitle: string
  onCopy: () => void
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-xs font-medium text-muted-foreground">
          {label}
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onCopy}
          title={copyTitle}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-muted p-2 text-[10px] leading-relaxed text-muted-foreground">
        {content}
      </pre>
    </div>
  )
}

// Config do trigger webhook: mostra a URL pública da automação, o payload
// de exemplo, o curl equivalente e a regeneração do token com confirmação.
// Draft ainda sem token exibe placeholder pedindo pra salvar primeiro.
function WebhookTriggerConfig({
  webhookToken,
  automationId,
  onTokenChange,
}: {
  webhookToken: string | null
  automationId?: string
  onTokenChange?: (token: string) => void
}) {
  const { t } = useTranslation(["automationBuilder", "common"])
  const { customFields } = useResources()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  // Origin só existe no browser — evita quebrar a pré-renderização.
  const [origin, setOrigin] = useState("")
  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  if (!webhookToken) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {t("webhookDraftPlaceholder")}
      </p>
    )
  }

  const url = `${origin}/api/automations/webhook/${webhookToken}`

  // Exemplo montado com os campos customizados da conta: a rota rejeita
  // (400) qualquer chave fora de phone/name/email que não exista em
  // custom_fields. Só entram nomes que o interpolate() resolve — mesmo
  // filtro do seletor de variáveis — porque campo com espaço ou acento
  // nunca vira {{vars.campo}} nos nós. As três chaves reservadas nunca são
  // sobrescritas: a rota as trata como contato, não como campo custom, e
  // um phone de mentira derrubaria o exemplo na primeira chamada.
  const sample: Record<string, string> = {
    phone: "5521999998888",
    name: "Fulano de Tal",
    email: "fulano@email.com",
  }
  for (const f of customFields) {
    if (/^\w+$/.test(f.field_name) && !(f.field_name in sample)) {
      sample[f.field_name] = t("webhookSampleValue")
    }
  }
  const payload = JSON.stringify(sample, null, 2)
  const curl = `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Idempotency-Key: evento-123' \\\n  -d '${JSON.stringify(sample)}'`

  // Copiar com fallback: navigator.clipboard falha em HTTP puro
  // (self-host por IP sem TLS) — espelha o padrão do briefing-modal.
  async function copy(text: string, successMessage: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement("textarea")
        ta.value = text
        ta.style.position = "fixed"
        ta.style.opacity = "0"
        document.body.appendChild(ta)
        ta.select()
        document.execCommand("copy")
        document.body.removeChild(ta)
      }
      toast.success(successMessage)
    } catch {
      toast.error(t("webhookCopyFailed"))
    }
  }

  // Regenera o token no servidor — a URL antiga morre na hora.
  async function regenerate() {
    if (!automationId) return
    setRegenerating(true)
    try {
      const res = await fetch(
        `/api/automations/${automationId}/regenerate-webhook-token`,
        { method: "POST" },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body?.webhook_token) {
        toast.error(body?.error ?? t("toastSaveFailed"))
        return
      }
      onTokenChange?.(body.webhook_token)
      toast.success(t("webhookRegenerated"))
      setConfirmOpen(false)
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("webhookUrlLabel")}
        </label>
        <div className="flex items-center gap-1.5">
          <Input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="bg-muted font-mono text-[11px] text-foreground"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => copy(url, t("webhookCopied"))}
            title={t("webhookCopy")}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <CopyableBlock
        label={t("webhookPayloadLabel")}
        content={payload}
        copyTitle={t("webhookPayloadCopy")}
        onCopy={() => copy(payload, t("webhookPayloadCopied"))}
      />
      <CopyableBlock
        label={t("webhookCurlLabel")}
        content={curl}
        copyTitle={t("webhookCurlCopy")}
        onCopy={() => copy(curl, t("webhookCurlCopied"))}
      />
      {/* {{vars.campo}} literal vai por interpolação — chaves duplas no JSON
          seriam engolidas pelo i18next */}
      <p className="text-[11px] text-muted-foreground">
        {t("webhookVarsHint", { example: "{{vars.campo}}" })}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        disabled={!automationId}
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {t("webhookRegenerate")}
      </Button>
      <Dialog open={confirmOpen} onOpenChange={(v) => !v && setConfirmOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("webhookRegenerateTitle")}</DialogTitle>
            <DialogDescription>
              {t("webhookRegenerateDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={regenerating}
            >
              {t("common:cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={regenerate}
              disabled={regenerating}
            >
              {regenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t("webhookRegenerate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function KeywordMatchConfig({
  config,
  onChange,
}: {
  config: KeywordMatchTriggerConfig
  onChange: (c: Record<string, unknown>) => void
}) {
  const { t } = useTranslation(["automationBuilder", "common"])
  const keywords = config?.keywords ?? []
  // Keep a local draft string so the comma and trailing space aren't
  // stripped on every keystroke (which made multi-word, comma-separated
  // entry like "SEO, search engine optimization" impossible to type).
  // We only parse into the keywords array on blur, then re-display the
  // cleaned, rejoined form. Seeded once on mount; this component remounts
  // when the trigger type changes, so the seed stays in sync.
  const [draft, setDraft] = useState(keywords.join(", "))

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    // Grava o match_type junto: o select exibe "contains" como padrão, mas só
    // o usuário mexer nele persistiria o valor — e a ativação exige o campo.
    onChange({ ...config, match_type: config?.match_type ?? "contains", keywords: parsed })
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("keywordsLabel")}
        </label>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={t("keywordsPlaceholder")}
          className="bg-muted text-foreground"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("matchType")}
        </label>
        <select
          value={config?.match_type ?? "contains"}
          onChange={(e) => onChange({ ...config, match_type: e.target.value as "exact" | "contains" })}
          className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:outline-none"
        >
          <option value="contains">{t("matchContains")}</option>
          <option value="exact">{t("matchExact")}</option>
        </select>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Step list + card + connectors
// ------------------------------------------------------------

type ParentScope =
  | { kind: "root" }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no" }

type StepPath = (
  | { kind: "root"; index: number }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no"; index: number }
)[]

interface StepListProps {
  steps: BuilderStep[]
  parentPath: StepPath
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  updateStep: (path: StepPath, updater: (s: BuilderStep) => BuilderStep) => void
  addStepAt: (parent: ParentScope, index: number, type: AutomationStepType) => void
  deleteStepAt: (path: StepPath) => void
  moveStepAt: (path: StepPath, direction: -1 | 1) => void
}

function StepList(props: StepListProps) {
  const { steps, parentPath, ...rest } = props
  const parentScope: ParentScope =
    parentPath.length === 0
      ? { kind: "root" }
      : (() => {
          const last = parentPath[parentPath.length - 1]
          if (last.kind !== "branch") return { kind: "root" } as const
          return { kind: "branch", parentCid: last.parentCid, branch: last.branch } as const
        })()

  return (
    <div className="flex flex-col items-center">
      <AddButton onPick={(t) => props.addStepAt(parentScope, 0, t)} />
      {steps.map((step, idx) => (
        <StepRenderer
          key={step.cid}
          step={step}
          index={idx}
          total={steps.length}
          parentScope={parentScope}
          parentPath={parentPath}
          {...rest}
        />
      ))}
    </div>
  )
}

function StepRenderer({
  step,
  index,
  total,
  parentScope,
  parentPath,
  ...props
}: {
  step: BuilderStep
  index: number
  total: number
  parentScope: ParentScope
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const { t } = useTranslation(["automationBuilder", "common"])
  const path: StepPath = [
    ...parentPath,
    parentScope.kind === "root"
      ? { kind: "root", index }
      : { kind: "branch", parentCid: parentScope.parentCid, branch: parentScope.branch, index },
  ]
  const meta = STEP_META[step.step_type]
  const Icon = meta.icon
  const expanded = props.expandedId === step.cid
  const isCondition = step.step_type === "condition"
  // Largura fluida com teto (400px / 480px na condition): enche a coluna
  // do canvas (max-w-3xl) e, aninhado nas branches de condition, encolhe
  // pra largura da coluna sem estourar — sem largura fixa por breakpoint.
  const width = isCondition
    ? "w-full max-w-[640px]"
    : "w-full max-w-[520px]"

  return (
    <>
      <div className={cn("z-10 flex flex-col", width)}>
        <div
          className={cn(
            "rounded-lg border border-border border-l-4 bg-card shadow-lg",
            meta.border,
          )}
        >
          <button
            type="button"
            onClick={() => props.setExpandedId(expanded ? null : step.cid)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <GripVertical className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {isCondition
                  ? t("labelCondition")
                  : step.step_type === "wait"
                  ? t("labelWait")
                  : t("labelAction")}
              </div>
              <div className="truncate text-sm font-medium text-foreground">
                {t(meta.labelKey, { defaultValue: meta.labelEn })}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">{previewFor(step, t)}</div>
            </div>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")}
            />
          </button>
          {expanded && (
            <div className="border-t border-border px-4 py-3">
              <StepEditor
                step={step}
                onChange={(next) => props.updateStep(path, () => next)}
              />
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === 0}
                    aria-label={t("moveUp")}
                    onClick={() => props.moveStepAt(path, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === total - 1}
                    aria-label={t("moveDown")}
                    onClick={() => props.moveStepAt(path, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => props.deleteStepAt(path)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("common:delete")}
                </Button>
              </div>
            </div>
          )}
        </div>

        {isCondition && (
          <ConditionBranches step={step} parentPath={path} {...props} />
        )}
      </div>

      {/* A condition branches into Yes/No (rendered above by
          ConditionBranches), so it has no linear "continue" path — adding
          the trailing connector here would produce a spurious third output. */}
      {!isCondition && (
        <AddButton
          onPick={(t) => props.addStepAt(parentScope, index + 1, t)}
        />
      )}
    </>
  )
}

function ConditionBranches({
  step,
  parentPath,
  ...props
}: {
  step: BuilderStep
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const { t } = useTranslation(["automationBuilder", "common"])
  const yes = step.branches?.yes ?? []
  const no = step.branches?.no ?? []
  // Build the child scope by appending a branch marker. The scope the
  // StepList uses is driven by the LAST element of parentPath, so the
  // tail's `index` doesn't matter — it's replaced per child during walks.
  const yesPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "yes", index: 0 },
  ]
  const noPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "no", index: 0 },
  ]
  return (
    // Stack Yes/No vertically on mobile — two columns at 375px would
    // cram each branch to ~170px which is too narrow for the nested
    // cards. Two-column grid returns on sm+.
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <BranchColumn label={t("branchYes")} color="text-primary">
        <StepList {...props} steps={yes} parentPath={yesPath} />
      </BranchColumn>
      <BranchColumn label={t("branchNo")} color="text-rose-400">
        <StepList {...props} steps={no} parentPath={noPath} />
      </BranchColumn>
    </div>
  )
}

function BranchColumn({
  label,
  color,
  children,
}: {
  label: string
  color: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center">
      <div className={cn("mb-2 text-[11px] font-semibold uppercase", color)}>{label}</div>
      {children}
    </div>
  )
}

function AddButton({ onPick }: { onPick: (type: AutomationStepType) => void }) {
  const { t } = useTranslation(["automationBuilder", "common"])
  return (
    <div className="relative flex flex-col items-center">
      <div className="h-4 w-[2px] bg-border" aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary data-[popup-open]:border-primary data-[popup-open]:bg-primary/20 data-[popup-open]:text-primary"
          aria-label={t("addStep")}
        >
          <Plus className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-80 min-w-56 overflow-y-auto border-border bg-popover"
        >
          {/* Param renomeado para `stepType` para não sombrear o `t`. */}
          {ADDABLE_STEPS.map((stepType) => {
            const Icon = STEP_META[stepType].icon
            return (
              <DropdownMenuItem key={stepType} onClick={() => onPick(stepType)}>
                <Icon className="h-4 w-4" />
                {t(STEP_META[stepType].labelKey, { defaultValue: STEP_META[stepType].labelEn })}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="h-4 w-[2px] bg-border" aria-hidden />
    </div>
  )
}

// ------------------------------------------------------------
// Per-step config editor
// ------------------------------------------------------------

function StepEditor({
  step,
  onChange,
}: {
  step: BuilderStep
  onChange: (s: BuilderStep) => void
}) {
  const { t } = useTranslation(["automationBuilder", "common"])
  const cfg = step.step_config
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...step, step_config: { ...cfg, ...patch } })

  switch (step.step_type) {
    case "send_message":
      return (
        <FieldBlock label={t("messageText")}>
          <Textarea
            value={(cfg.text as string) ?? ""}
            onChange={(e) => set({ text: e.target.value })}
            placeholder={t("messageTextPlaceholder")}
            className="min-h-24 bg-muted text-foreground"
          />
        </FieldBlock>
      )
    case "send_template":
      return (
        <SendTemplateFields
          templateName={(cfg.template_name as string) ?? ""}
          language={(cfg.language as string) ?? ""}
          variables={(cfg.variables as Record<string, string>) ?? {}}
          onChange={(patch) => set(patch)}
        />
      )
    case "add_tag":
    case "remove_tag":
      return (
        <FieldBlock label={t("tag")}>
          <TagSelect
            value={(cfg.tag_id as string) ?? ""}
            onChange={(v) => set({ tag_id: v })}
          />
        </FieldBlock>
      )
    case "assign_conversation":
      return (
        <>
          <FieldBlock label={t("mode")}>
            <select
              value={(cfg.mode as string) ?? "round_robin"}
              onChange={(e) => set({ mode: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="round_robin">{t("modeRoundRobin")}</option>
              <option value="specific">{t("modeSpecific")}</option>
            </select>
          </FieldBlock>
          {cfg.mode === "specific" && (
            <FieldBlock label={t("agent")}>
              <AgentSelect
                value={(cfg.agent_id as string) ?? ""}
                onChange={(v) => set({ agent_id: v })}
              />
            </FieldBlock>
          )}
        </>
      )
    case "update_contact_field":
      return (
        <>
          <FieldBlock label={t("field")}>
            <ContactFieldSelect
              value={(cfg.field as string) ?? "name"}
              onChange={(v) => set({ field: v })}
            />
          </FieldBlock>
          <FieldBlock label={t("value")}>
            <Input
              value={(cfg.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
              placeholder="Text or {{ vars.x }} / {{ message.text }}"
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "create_deal":
      return (
        <>
          <FieldBlock label={t("pipelineId")}>
            <Input
              value={(cfg.pipeline_id as string) ?? ""}
              onChange={(e) => set({ pipeline_id: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("stageId")}>
            <Input
              value={(cfg.stage_id as string) ?? ""}
              onChange={(e) => set({ stage_id: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("title")}>
            <Input
              value={(cfg.title as string) ?? ""}
              onChange={(e) => set({ title: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("value")}>
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "wait":
      return (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label={t("amount")}>
            <Input
              type="number"
              min={1}
              value={(cfg.amount as number) ?? 1}
              onChange={(e) => set({ amount: Math.max(1, Number(e.target.value)) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("unit")}>
            <select
              value={(cfg.unit as string) ?? "hours"}
              onChange={(e) => set({ unit: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="minutes">{t("unitMinutes")}</option>
              <option value="hours">{t("unitHours")}</option>
              <option value="days">{t("unitDays")}</option>
            </select>
          </FieldBlock>
        </div>
      )
    case "condition":
      return (
        <>
          <FieldBlock label={t("subject")}>
            <select
              value={(cfg.subject as string) ?? "tag_presence"}
              onChange={(e) => set({ subject: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="tag_presence">{t("subjectTagPresence")}</option>
              <option value="contact_field">{t("subjectContactField")}</option>
              <option value="message_content">{t("subjectMessageContent")}</option>
              <option value="time_of_day">{t("subjectTimeOfDay")}</option>
            </select>
          </FieldBlock>
          <FieldBlock label={t("operand")}>
            <Input
              placeholder={
                cfg.subject === "time_of_day"
                  ? t("operandTimeOfDayPlaceholder")
                  : cfg.subject === "contact_field"
                  ? t("operandContactFieldPlaceholder")
                  : cfg.subject === "tag_presence"
                  ? t("operandTagPresencePlaceholder")
                  : ""
              }
              value={(cfg.operand as string) ?? ""}
              onChange={(e) => set({ operand: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          {(cfg.subject === "contact_field" || cfg.subject === "message_content") && (
            <FieldBlock label={t("value")}>
              <Input
                value={(cfg.value as string) ?? ""}
                onChange={(e) => set({ value: e.target.value })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
          )}
        </>
      )
    case "send_webhook":
      return (
        <>
          <FieldBlock label={t("url")}>
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("bodyTemplateJson")}>
            <Textarea
              value={(cfg.body_template as string) ?? ""}
              onChange={(e) => set({ body_template: e.target.value })}
              className="min-h-20 bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "close_conversation":
      return (
        <p className="text-xs text-muted-foreground">
          {t("closeConversationNote")}
        </p>
      )
    case "ai_reply": {
      // Contexto da campanha (081): texto livre que descreve a ação alvo e o que o
      // template prometeu. Vai pro system prompt do agente e vale a conversa toda.
      const campaign = (cfg.campaign_context as string) ?? ""
      return (
        <>
          <p className="mb-2 text-xs text-muted-foreground">{t("aiReplyNote")}</p>
          <FieldBlock label={`${t("campaignContext")} · ${campaign.length}/2.000`}>
            <Textarea
              value={campaign}
              onChange={(e) => set({ campaign_context: e.target.value })}
              maxLength={2000}
              placeholder={t("campaignContextPlaceholder")}
              className="min-h-24 bg-muted text-foreground"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("campaignContextHint")}</p>
          </FieldBlock>
        </>
      )
    }
    default:
      return null
  }
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

// Texto de pré-visualização do passo. Recebe o `t` do chamador (não é hook)
// para traduzir os textos de fallback visíveis.
function previewFor(step: BuilderStep, t: TFunction): string {
  switch (step.step_type) {
    case "send_message":
      return (step.step_config.text as string) || t("previewNoText")
    case "send_template":
      return (step.step_config.template_name as string) || t("previewPickTemplate")
    case "wait":
      return `${step.step_config.amount ?? "?"} ${step.step_config.unit ?? ""}`
    case "condition":
      return t("previewConditionWhen", { subject: step.step_config.subject ?? "?" })
    case "send_webhook":
      return (step.step_config.url as string) || t("previewNoUrl")
    case "ai_reply":
      // Sem contexto cai em "" (igual a hoje): passo antigo não muda de aparência.
      return (step.step_config.campaign_context as string) || ""
    default:
      return ""
  }
}

// ------------------------------------------------------------
// Tree mutation helpers
// ------------------------------------------------------------

function insertAt(
  steps: BuilderStep[],
  parent: ParentScope,
  index: number,
  node: BuilderStep,
): BuilderStep[] {
  if (parent.kind === "root") {
    const copy = [...steps]
    copy.splice(index, 0, node)
    return copy
  }
  return steps.map((s) => {
    if (s.cid !== parent.parentCid || !s.branches) return s
    const list = [...s.branches[parent.branch]]
    list.splice(index, 0, node)
    return { ...s, branches: { ...s.branches, [parent.branch]: list } }
  })
}

function mapAtPath(
  steps: BuilderStep[],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)

  if (head.kind === "root") {
    return steps.map((s, i) => {
      if (i !== head.index) return s
      return rest.length === 0
        ? updater(s)
        : { ...s, branches: walkBranches(s.branches, rest, updater) }
    })
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const updated = bucket.map((child, i) => {
      if (i !== head.index) return child
      return rest.length === 0
        ? updater(child)
        : { ...child, branches: walkBranches(child.branches, rest, updater) }
    })
    return { ...s, branches: { ...s.branches, [head.branch]: updated } }
  })
}

function walkBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const bucket = branches[head.branch]
  const rest = path.slice(1)
  const updated = bucket.map((child, i) => {
    if (i !== head.index) return child
    return rest.length === 0
      ? updater(child)
      : { ...child, branches: walkBranches(child.branches, rest, updater) }
  })
  return { ...branches, [head.branch]: updated }
}

function removeAt(steps: BuilderStep[], path: StepPath): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  if (head.kind === "root") {
    if (rest.length === 0) return steps.filter((_, i) => i !== head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: removeFromBranches(s.branches, rest) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next =
      rest.length === 0
        ? bucket.filter((_, i) => i !== head.index)
        : bucket.map((child, i) =>
            i !== head.index
              ? child
              : { ...child, branches: removeFromBranches(child.branches, rest) },
          )
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function removeFromBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const next =
    rest.length === 0
      ? bucket.filter((_, i) => i !== head.index)
      : bucket.map((child, i) =>
          i !== head.index
            ? child
            : { ...child, branches: removeFromBranches(child.branches, rest) },
        )
  return { ...branches, [head.branch]: next }
}

function moveAt(
  steps: BuilderStep[],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  if (head.kind === "root") {
    if (rest.length === 0) return swap(steps, head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: moveInBranches(s.branches, rest, direction) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next = rest.length === 0 ? swap(bucket, head.index) : bucket
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function moveInBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  const next = rest.length === 0 ? swap(bucket, head.index) : bucket
  return { ...branches, [head.branch]: next }
}

// ------------------------------------------------------------
// Serialize builder tree → API payload (flattened shape)
// ------------------------------------------------------------

interface ApiStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: ApiStep[]; no?: ApiStep[] }
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }))
}

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string
  step_type: string
  step_config: Record<string, unknown>
  branches: { yes: ServerStepNode[]; no: ServerStepNode[] }
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => ({
    cid: cid(),
    step_type: n.step_type as AutomationStepType,
    step_config: n.step_config ?? {},
    branches:
      n.step_type === "condition"
        ? {
            yes: fromServerSteps(n.branches?.yes ?? []),
            no: fromServerSteps(n.branches?.no ?? []),
          }
        : undefined,
  }))
}
