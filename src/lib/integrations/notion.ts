// ============================================================
// Notion — cria página numa database + introspecção (campos/opções e
// usuários) para o modal montar selects dinâmicos. Timeout em cada call.
// ============================================================

const NOTION_BASE = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const TIMEOUT_MS = 10_000

function notionFetch(path: string, apiKey: string, init: RequestInit) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  return fetch(`${NOTION_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout))
}

function paragraph(text: string) {
  return {
    object: 'block' as const,
    type: 'paragraph' as const,
    paragraph: { rich_text: [{ type: 'text' as const, text: { content: text } }] },
  }
}

// ── Introspecção ──────────────────────────────────────────────────────

/** Tipos de campo que o modal sabe preencher. */
export type NotionFieldType =
  | 'select'
  | 'status'
  | 'multi_select'
  | 'people'
  | 'date'

export interface NotionFieldMeta {
  name: string
  type: NotionFieldType
  /** Para select/status/multi_select. */
  options?: string[]
}

export interface NotionDatabaseMeta {
  titleProp: string
  fields: NotionFieldMeta[]
}

/** Lê o schema da database: prop de título + campos preenchíveis. */
export async function getDatabaseMeta(
  apiKey: string,
  databaseId: string,
): Promise<NotionDatabaseMeta> {
  let res: Response
  try {
    res = await notionFetch(`/databases/${databaseId}`, apiKey, { method: 'GET' })
  } catch {
    throw new Error('Notion request failed (database)')
  }
  if (!res.ok) throw new Error(`Notion error ${res.status} reading database`)

  const db = (await res.json()) as {
    properties?: Record<
      string,
      {
        type?: string
        select?: { options?: { name: string }[] }
        status?: { options?: { name: string }[] }
        multi_select?: { options?: { name: string }[] }
      }
    >
  }

  let titleProp = 'Name'
  const fields: NotionFieldMeta[] = []
  for (const [name, def] of Object.entries(db.properties ?? {})) {
    switch (def?.type) {
      case 'title':
        titleProp = name
        break
      case 'select':
        fields.push({ name, type: 'select', options: (def.select?.options ?? []).map((o) => o.name) })
        break
      case 'status':
        fields.push({ name, type: 'status', options: (def.status?.options ?? []).map((o) => o.name) })
        break
      case 'multi_select':
        fields.push({ name, type: 'multi_select', options: (def.multi_select?.options ?? []).map((o) => o.name) })
        break
      case 'people':
        fields.push({ name, type: 'people' })
        break
      case 'date':
        fields.push({ name, type: 'date' })
        break
    }
  }
  return { titleProp, fields }
}

export interface NotionUser {
  id: string
  name: string
}

/** Lista usuários (pessoas) do workspace — para o campo Responsável. */
export async function listNotionUsers(apiKey: string): Promise<NotionUser[]> {
  let res: Response
  try {
    res = await notionFetch('/users?page_size=100', apiKey, { method: 'GET' })
  } catch {
    throw new Error('Notion request failed (users)')
  }
  if (!res.ok) throw new Error(`Notion error ${res.status} reading users`)
  const data = (await res.json()) as {
    results?: { id: string; name?: string; type?: string }[]
  }
  return (data.results ?? [])
    .filter((u) => u.type === 'person')
    .map((u) => ({ id: u.id, name: u.name ?? 'Sem nome' }))
}

// ── Criação de página ─────────────────────────────────────────────────

/** Valor de um campo extra escolhido no modal (mapeado por tipo). */
export interface NotionPropAssignment {
  name: string
  type: NotionFieldType
  /** string p/ select/status/date; string[] p/ multi_select; id(s) p/ people. */
  value: string | string[]
}

function buildProperty(p: NotionPropAssignment): unknown | null {
  const v = p.value
  if (v == null || (Array.isArray(v) && v.length === 0) || v === '') return null
  switch (p.type) {
    case 'select':
      return { select: { name: v as string } }
    case 'status':
      return { status: { name: v as string } }
    case 'multi_select':
      return { multi_select: (v as string[]).map((name) => ({ name })) }
    case 'people':
      return { people: (Array.isArray(v) ? v : [v]).map((id) => ({ id })) }
    case 'date':
      return { date: { start: v as string } }
    default:
      return null
  }
}

export interface CreateNotionPageArgs {
  apiKey: string
  databaseId: string
  title: string
  body: string
  /** Campos extras (Categoria/Área/Prioridade/Status/Responsável/Prazo…). */
  extraProps?: NotionPropAssignment[]
  /** Nome da prop de título, se já conhecido (evita refetch). */
  titleProp?: string
}

/** Cria a página e devolve a URL. */
export async function createNotionPage(
  args: CreateNotionPageArgs,
): Promise<{ url: string }> {
  const { apiKey, databaseId, title, body, extraProps = [] } = args
  const titleProp = args.titleProp ?? (await getDatabaseMeta(apiKey, databaseId)).titleProp

  const children = body
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(0, 90)
    .map((l) => paragraph(l.slice(0, 2000)))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: Record<string, any> = {
    [titleProp]: { title: [{ text: { content: title.slice(0, 2000) } }] },
  }
  for (const p of extraProps) {
    const built = buildProperty(p)
    if (built) properties[p.name] = built
  }

  let res: Response
  try {
    res = await notionFetch('/pages', apiKey, {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties,
        children,
      }),
    })
  } catch {
    throw new Error('Notion request failed (page)')
  }
  if (!res.ok) {
    let detail = ''
    try {
      const b = (await res.json()) as { message?: string }
      detail = b?.message ?? ''
    } catch {
      /* ignore */
    }
    throw new Error(`Notion error ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  const page = (await res.json()) as { url?: string }
  return { url: page.url ?? '' }
}
