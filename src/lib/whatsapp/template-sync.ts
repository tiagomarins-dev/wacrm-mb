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

// Sincroniza os templates da Meta de UMA conexão (WABA) para o banco,
// escopados por (account_id, connection_id). Mantém lookup→update/insert
// (não upsert) de propósito: preserva a contagem inserted/updated que o
// toast do template-manager exibe; o índice único (033) impede duplicata.
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
  // lenta não pode travar o loop do route que chama esta função.
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
      // Aborta esta conexão; o route segue para as demais.
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

  // Persistência por template, escopada à conexão.
  for (const t of metaTemplates) {
    const row = buildRow(t, accountId, conn.id, userId);
    const { data: existing, error: lookupErr } = await db
      .from("message_templates")
      .select("id")
      .eq("account_id", accountId)
      .eq("connection_id", conn.id)
      .eq("name", t.name)
      .eq("language", t.language)
      .maybeSingle();

    if (lookupErr) {
      errors.push({ name: t.name, language: t.language, message: lookupErr.message });
      continue;
    }

    if (existing?.id) {
      const { error } = await db
        .from("message_templates")
        .update(row)
        .eq("id", existing.id);
      if (error)
        errors.push({ name: t.name, language: t.language, message: error.message });
      else updated++;
    } else {
      const { error } = await db.from("message_templates").insert(row);
      if (error)
        errors.push({ name: t.name, language: t.language, message: error.message });
      else inserted++;
    }
  }

  return {
    total: metaTemplates.length,
    inserted,
    updated,
    errors,
    truncated: pageCount >= PAGE_CAP && nextUrl !== null,
  };
}
