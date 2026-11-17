// ============================================================
// Sync de templates da Meta POR CONEXÃO (multi-número, 033).
//
// Lib pura/testável (espelha src/lib/broadcast/send-engine.ts):
// recebe o `db` por parâmetro, não importa next/*. O route lista as
// conexões da conta, decifra o token de cada uma e chama esta função
// por conexão, agregando os contadores. `fetchFn` é injetável para o
// teste não tocar a rede.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TemplateButton, TemplateSampleValues } from "@/types";
import { normalizeStatus } from "@/lib/whatsapp/template-status-normalize";

const META_API_VERSION = "v21.0";
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;
const PAGE_CAP = 20;
// Teto de linhas por resposta do PostgREST: a leitura dos existentes pagina
// neste tamanho para a lista não vir cortada.
const SELECT_PAGE = 1000;
// Linhas por gravação em lote: mantém o corpo da requisição pequeno mesmo
// no catálogo máximo (PAGE_CAP × 100 templates).
const WRITE_CHUNK = 500;
// Gravações simultâneas quando um lote é refeito linha a linha.
const ROW_CONCURRENCY = 10;
// Colunas do índice único que identifica um template dentro da conexão.
const CONFLICT_KEY = "connection_id,name,language";

interface MetaButton {
  type: string;
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
}

interface MetaTemplateComponent {
  type: string;
  text?: string;
  format?: string;
  buttons?: MetaButton[];
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
}

interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: MetaTemplateComponent[];
  quality_score?: { score?: string } | string;
}

/** Conexão decifrada que o route passa para o sync. */
export interface ConnLite {
  id: string;
  waba_id: string | null;
  access_token: string; // já decifrado pelo route
}

/** Resultado do sync de UMA conexão (o route agrega entre conexões). */
export interface SyncResult {
  total: number;
  inserted: number;
  updated: number;
  errors: { name: string; language: string; message: string }[];
  truncated: boolean;
}

// Normaliza a categoria da Meta para o enum local.
function normalizeCategory(
  meta: string,
): "Marketing" | "Utility" | "Authentication" {
  const upper = meta.toUpperCase();
  if (upper === "UTILITY") return "Utility";
  if (upper === "AUTHENTICATION") return "Authentication";
  return "Marketing";
}

// Normaliza o quality_score (string ou objeto) para o enum local.
function normalizeQualityScore(
  raw: MetaTemplate["quality_score"],
): "GREEN" | "YELLOW" | "RED" | null {
  const score =
    typeof raw === "string" ? raw : raw?.score ? String(raw.score) : null;
  if (!score) return null;
  const upper = score.toUpperCase();
  return upper === "GREEN" || upper === "YELLOW" || upper === "RED"
    ? (upper as "GREEN" | "YELLOW" | "RED")
    : null;
}

// Converte os botões da Meta para o formato local (OTP/FLOW caem fora).
function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return [];
  const out: TemplateButton[] = [];
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case "QUICK_REPLY":
        out.push({ type: "QUICK_REPLY", text: b.text });
        break;
      case "URL":
        out.push({
          type: "URL",
          text: b.text,
          url: b.url ?? "",
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        });
        break;
      case "PHONE_NUMBER":
        out.push({
          type: "PHONE_NUMBER",
          text: b.text,
          phone_number: b.phone_number ?? "",
        });
        break;
      case "COPY_CODE":
        out.push({
          type: "COPY_CODE",
          text: b.text,
          example: Array.isArray(b.example)
            ? b.example[0] ?? ""
            : b.example ?? "",
        });
        break;
    }
  }
  return out;
}

// Extrai os valores de exemplo (body/header) que a Meta devolve.
function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): TemplateSampleValues | null {
  const bodySample = body?.example?.body_text?.[0];
  const headerSample = header?.example?.header_text;
  if (!bodySample?.length && !headerSample?.length) return null;
  const sv: TemplateSampleValues = {};
  if (bodySample?.length) sv.body = bodySample;
  if (headerSample?.length) sv.header = headerSample;
  return sv;
}

type TemplateRow = ReturnType<typeof buildRow>;

// Chave de um template dentro da conexão. O separador é um caractere que
// não ocorre em nome nem em idioma, então pares distintos nunca colidem.
function templateKey(name: string, language: string): string {
  return `${name}\u0000${language}`;
}

// Monta a linha do banco a partir do template da Meta, amarrada à conta
// e à CONEXÃO (033). user_id é mantido só como auditoria/autor.
function buildRow(
  t: MetaTemplate,
  accountId: string,
  connectionId: string,
  userId: string,
) {
  const body = (t.components ?? []).find((c) => c.type === "BODY");
  const header = (t.components ?? []).find((c) => c.type === "HEADER");
  const footer = (t.components ?? []).find((c) => c.type === "FOOTER");
  const buttons = (t.components ?? []).find((c) => c.type === "BUTTONS");

  const parsedButtons = parseButtons(buttons?.buttons);
  const sampleValues = extractSampleValues(body, header);

  const headerFormat = header?.format?.toUpperCase();
  const headerType =
    headerFormat === "TEXT" ||
    headerFormat === "IMAGE" ||
    headerFormat === "VIDEO" ||
    headerFormat === "DOCUMENT"
      ? headerFormat.toLowerCase()
      : null;

  return {
    account_id: accountId,
    connection_id: connectionId,
    user_id: userId,
    name: t.name,
    category: normalizeCategory(t.category),
    language: t.language,
    header_type: headerType,
    header_content: header?.text ?? null,
    header_handle: header?.example?.header_handle?.[0] ?? null,
    body_text: body?.text ?? "",
    footer_text: footer?.text ?? null,
    buttons: parsedButtons.length ? parsedButtons : null,
    sample_values: sampleValues,
    status: normalizeStatus(t.status),
    meta_template_id: t.id,
    quality_score: normalizeQualityScore(t.quality_score),
    updated_at: new Date().toISOString(),
  };
}

// Lê (id, name, language) de todos os templates já gravados da conexão e
// devolve um mapa chave → id. É essa lista que separa "novo" de "existente"
// na contagem inserted/updated. Pagina com ordem estável porque o PostgREST
// corta a resposta em SELECT_PAGE linhas, e uma lista cortada contaria
// template existente como novo.
async function loadExistingIds(
  db: SupabaseClient,
  accountId: string,
  connectionId: string,
): Promise<{ ids: Map<string, string>; error: string | null }> {
  const ids = new Map<string, string>();
  for (let from = 0; ; from += SELECT_PAGE) {
    const { data, error } = await db
      .from("message_templates")
      .select("id, name, language")
      .eq("account_id", accountId)
      .eq("connection_id", connectionId)
      .order("id")
      .range(from, from + SELECT_PAGE - 1);
    if (error) return { ids, error: error.message };
    const page = (data ?? []) as { id: string; name: string; language: string }[];
    for (const r of page) ids.set(templateKey(r.name, r.language), r.id);
    if (page.length < SELECT_PAGE) return { ids, error: null };
  }
}

// Grava UMA linha pelo caminho individual: update por id quando o template
// já existe, insert quando é novo. Devolve a mensagem de erro ou null.
async function writeSingleRow(
  db: SupabaseClient,
  row: TemplateRow,
  existingId: string | undefined,
): Promise<string | null> {
  const { error } = existingId
    ? await db.from("message_templates").update(row).eq("id", existingId)
    : await db.from("message_templates").insert(row);
  return error ? error.message : null;
}

// Sincroniza os templates da Meta de UMA conexão (WABA) para o banco,
// escopados por (account_id, connection_id), em duas idas ao banco: uma
// leitura dos templates existentes e uma gravação em lote (upsert no índice
// único connection_id+name+language). O upsert não informa o que foi criado
// e o que foi alterado, então inserted/updated — exibidos no toast do
// template-manager — saem da comparação com a lista lida antes.
export async function syncConnectionTemplates(
  db: SupabaseClient,
  conn: ConnLite,
  accountId: string,
  userId: string,
  fetchFn: typeof fetch = fetch,
): Promise<SyncResult> {
  const errors: SyncResult["errors"] = [];
  let inserted = 0;
  let updated = 0;

  if (!conn.waba_id) {
    return { total: 0, inserted, updated, errors, truncated: false };
  }

  // Paginação da Meta com timeout por página (AbortController) — uma WABA
  // lenta não pode segurar a resposta do route, que espera todas as conexões.
  const metaTemplates: MetaTemplate[] = [];
  let nextUrl: string | null = `${META_API_BASE}/${conn.waba_id}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`;
  let pageCount = 0;
  while (nextUrl && pageCount < PAGE_CAP) {
    pageCount++;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetchFn(nextUrl, {
        headers: { Authorization: `Bearer ${conn.access_token}` },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Meta API ${res.status}`);
      const body: { data?: MetaTemplate[]; paging?: { next?: string } } =
        await res.json();
      if (body.data) metaTemplates.push(...body.data);
      nextUrl = body.paging?.next ?? null;
    } catch (e) {
      // Para a paginação desta conexão; o que já veio ainda é gravado.
      errors.push({
        name: "*",
        language: "*",
        message: e instanceof Error ? e.message : String(e),
      });
      break;
    } finally {
      clearTimeout(to);
    }
  }

  const total = metaTemplates.length;
  const truncated = pageCount >= PAGE_CAP && nextUrl !== null;
  if (total === 0) return { total, inserted, updated, errors, truncated };

  // Sem a lista dos existentes não há como classificar novo/existente:
  // a conexão não é gravada e o erro sai com o curinga "*", como na falha
  // da Meta.
  const existing = await loadExistingIds(db, accountId, conn.id);
  if (existing.error) {
    errors.push({ name: "*", language: "*", message: existing.error });
    return { total, inserted, updated, errors, truncated };
  }

  // Uma linha por chave (a última ocorrência vale): o Postgres rejeita o
  // lote inteiro se a mesma chave aparecer duas vezes no mesmo upsert.
  const byKey = new Map<string, TemplateRow>();
  for (const t of metaTemplates) {
    byKey.set(
      templateKey(t.name, t.language),
      buildRow(t, accountId, conn.id, userId),
    );
  }
  const rows = [...byKey.values()];

  // Contabiliza uma linha gravada como nova ou existente.
  const count = (row: TemplateRow) => {
    if (existing.ids.has(templateKey(row.name, row.language))) updated++;
    else inserted++;
  };

  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const { error: batchErr } = await db
      .from("message_templates")
      .upsert(chunk, { onConflict: CONFLICT_KEY });
    if (!batchErr) {
      chunk.forEach(count);
      continue;
    }

    // O upsert é atômico: uma linha inválida derruba o lote inteiro e o
    // erro não diz qual foi. O lote é então refeito linha a linha, por
    // update/insert simples (que não dependem do índice único nem do
    // ON CONFLICT), para gravar as válidas e apontar em `errors` o nome e
    // o idioma de cada uma que falhar.
    console.warn(
      `[template-sync] lote da conexão ${conn.id} falhou (${batchErr.message}); gravando linha a linha`,
    );
    for (let j = 0; j < chunk.length; j += ROW_CONCURRENCY) {
      const group = chunk.slice(j, j + ROW_CONCURRENCY);
      const results = await Promise.all(
        group.map((row) =>
          writeSingleRow(
            db,
            row,
            existing.ids.get(templateKey(row.name, row.language)),
          ),
        ),
      );
      results.forEach((message, k) => {
        const row = group[k];
        if (message)
          errors.push({ name: row.name, language: row.language, message });
        else count(row);
      });
    }
  }

  return { total, inserted, updated, errors, truncated };
}
