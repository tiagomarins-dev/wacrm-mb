/**
 * Shared editor primitives used by both the linear-list and canvas
 * views of a flow.
 *
 * What lives here vs in flow-builder.tsx / flow-canvas.tsx:
 *   - Types and metadata that BOTH views need to render a node
 *     consistently (icon, label, color, 1-line summary).
 *   - Editing-only helpers (defaultConfigFor, slugify, uniqueNodeKey,
 *     BuilderState) stay in flow-builder.tsx until the canvas grows
 *     editing affordances — pulled across in the PR that adds them.
 *
 * Why .tsx and not .ts: NODE_META holds lucide icon components, which
 * are typed as React components; importing them from a .ts module
 * works at runtime but trips TypeScript's
 * `verbatimModuleSyntax`-related linting in some setups. Keeping the
 * file .tsx future-proofs it for inline JSX in node-card renderers.
 */

import {
  Flag,
  GitFork,
  Inbox,
  ListChecks,
  ListPlus,
  MessageCircle,
  MousePointerClick,
  Paperclip,
  PlayCircle,
  Tag,
  UserPlus,
  Workflow,
} from "lucide-react";
import type { TFunction } from "i18next";

// ============================================================
// Node-type union — single source of truth for every place the UI
// enumerates types (add menu, type pickers, switch statements). Kept
// in lockstep with `FlowNodeType` in src/lib/flows/types.ts (which
// drives the engine's exhaustiveness check); a divergence between the
// two is always a bug.
// ============================================================

export type NodeType =
  | "start"
  | "send_message"
  | "send_buttons"
  | "send_list"
  | "send_media"
  | "collect_input"
  | "condition"
  | "set_tag"
  | "wait_for_link_click"
  | "handoff"
  | "end";

export interface BuilderNode {
  node_key: string;
  node_type: NodeType;
  config: Record<string, unknown>;
  /** Optional in v1 — defaults to 0 in the DB. Canvas view reads it
   *  to position nodes; list view ignores it. */
  position_x?: number;
  position_y?: number;
}

// ============================================================
// Per-node-type metadata used to render icons + labels everywhere
// the user sees a node summary.
//
// i18n: `label` continua sendo o rótulo EN — é a fonte do slug em
// `addNode` (o node_key é identificador interno e precisa ser estável
// independente do idioma). `labelKey` é a chave de tradução resolvida
// no render via `t(labelKey, { defaultValue: label })`.
// ============================================================

export const NODE_META: Record<
  NodeType,
  { label: string; labelKey: string; icon: typeof Workflow; color: string }
> = {
  start: {
    label: "Start",
    labelKey: "nodeStart",
    icon: PlayCircle,
    color: "text-emerald-400",
  },
  send_message: {
    label: "Send message",
    labelKey: "nodeSendMessage",
    icon: MessageCircle,
    color: "text-sky-400",
  },
  send_buttons: {
    label: "Send buttons",
    labelKey: "nodeSendButtons",
    icon: ListChecks,
    color: "text-primary",
  },
  send_list: {
    label: "Send list",
    labelKey: "nodeSendList",
    icon: ListPlus,
    color: "text-indigo-400",
  },
  send_media: {
    label: "Send media",
    labelKey: "nodeSendMedia",
    icon: Paperclip,
    color: "text-cyan-400",
  },
  collect_input: {
    label: "Collect input",
    labelKey: "nodeCollectInput",
    icon: Inbox,
    color: "text-teal-400",
  },
  condition: {
    label: "If / else",
    labelKey: "nodeCondition",
    icon: GitFork,
    color: "text-fuchsia-400",
  },
  set_tag: {
    label: "Tag contact",
    labelKey: "nodeSetTag",
    icon: Tag,
    color: "text-pink-400",
  },
  wait_for_link_click: {
    label: "Wait for link click",
    labelKey: "nodeWaitForLinkClick",
    icon: MousePointerClick,
    color: "text-blue-400",
  },
  handoff: {
    label: "Handoff to agent",
    labelKey: "nodeHandoff",
    icon: UserPlus,
    color: "text-amber-400",
  },
  end: {
    label: "End",
    labelKey: "nodeEnd",
    icon: Flag,
    color: "text-muted-foreground",
  },
};

/**
 * Resolve o rótulo traduzido de um tipo de nó. Centraliza o
 * `t(labelKey, { defaultValue: label })` para os 4 pontos que renderizam
 * o nome do nó (lista, canvas, side-sheet, dropdown).
 */
export function nodeLabel(type: NodeType, t: TFunction): string {
  const meta = NODE_META[type];
  return t(meta.labelKey, { defaultValue: meta.label });
}

// ============================================================
// Pure editing helpers — used by forms in both views.
// ============================================================

/**
 * Coerce an arbitrary string into a stable identifier (node_key,
 * reply_id, etc.). Lowercases, collapses non-alphanumerics into
 * single underscores, and trims leading/trailing underscores. Falls
 * back to `fallback` for inputs that reduce to an empty string.
 */
export function slugify(s: string, fallback: string): string {
  const cleaned = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

// ============================================================
// Summary helpers — short, single-line content previews used in
// collapsed node cards (list view) and node tiles (canvas view).
// Returns null when there's nothing meaningful to show (start/end,
// or a freshly-added node with no fields filled in).
// ============================================================

export function truncate(s: string, max = 80): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + "…";
}

// i18n: recebe `t` (namespace flowEditor) para resolver as strings
// visíveis nos resumos. Conteúdo do usuário (texto, títulos, URLs,
// var_key) permanece intacto — só os rótulos fixos são traduzidos.
export function summarizeNode(node: BuilderNode, t: TFunction): string | null {
  const cfg = node.config;
  switch (node.node_type) {
    case "start":
    case "end":
      return null;
    case "send_message": {
      const text = typeof cfg.text === "string" ? cfg.text : "";
      return text.length > 0 ? truncate(text) : null;
    }
    case "send_buttons": {
      const text = typeof cfg.text === "string" ? cfg.text : "";
      const buttons = Array.isArray(cfg.buttons)
        ? (cfg.buttons as Array<Record<string, unknown>>)
        : [];
      const titles = buttons
        .map((b) => (typeof b.title === "string" ? b.title : ""))
        .filter(Boolean)
        .join(" / ");
      if (text.length > 0) {
        return titles ? `${truncate(text, 40)} · ${truncate(titles, 35)}` : truncate(text);
      }
      return titles || null;
    }
    case "send_list": {
      const text = typeof cfg.text === "string" ? cfg.text : "";
      const sections = Array.isArray(cfg.sections)
        ? (cfg.sections as Array<Record<string, unknown>>)
        : [];
      const rowCount = sections.reduce<number>((sum, s) => {
        const rows = Array.isArray(s.rows) ? s.rows : [];
        return sum + rows.length;
      }, 0);
      // Plural via _one/_other; o i18next escolhe pela `count`.
      const optionsStr = t("summaryOptions", { count: rowCount });
      if (text.length > 0) {
        return rowCount > 0
          ? `${truncate(text, 50)} · ${optionsStr}`
          : truncate(text);
      }
      return rowCount > 0
        ? t("summaryOptionsAcross", {
            count: rowCount,
            options: optionsStr,
            sections: t("summarySections", { count: sections.length }),
          })
        : null;
    }
    case "send_media": {
      const mediaType =
        typeof cfg.media_type === "string" ? cfg.media_type : "";
      const filename = typeof cfg.filename === "string" ? cfg.filename : "";
      const url = typeof cfg.media_url === "string" ? cfg.media_url : "";
      const caption = typeof cfg.caption === "string" ? cfg.caption : "";
      const label = mediaType
        ? mediaType.charAt(0).toUpperCase() + mediaType.slice(1)
        : t("summaryMedia");
      if (!url) return t("summaryMediaNoFile", { label });
      const name = filename || url.split("/").pop() || "file";
      return caption
        ? t("summaryMediaFileCaption", {
            label,
            name: truncate(name, 30),
            caption: truncate(caption, 40),
          })
        : t("summaryMediaFile", { label, name: truncate(name, 60) });
    }
    case "collect_input": {
      const prompt = typeof cfg.prompt_text === "string" ? cfg.prompt_text : "";
      const varKey = typeof cfg.var_key === "string" ? cfg.var_key : "";
      if (prompt.length > 0) {
        return varKey ? `${truncate(prompt, 50)} → vars.${varKey}` : truncate(prompt);
      }
      return varKey ? `→ vars.${varKey}` : null;
    }
    case "condition": {
      const subjectKey =
        typeof cfg.subject_key === "string" ? cfg.subject_key : "";
      if (!subjectKey) return null;
      const subject =
        cfg.subject === "tag"
          ? "tag"
          : cfg.subject === "contact_field"
            ? "field"
            : "var";
      const subjectStr =
        subject === "tag"
          ? t("summaryHasTag", { tag: truncate(subjectKey, 24) })
          : `${subject}.${subjectKey}`;
      const op =
        cfg.operator === "equals"
          ? "=="
          : cfg.operator === "contains"
            ? "contains"
            : cfg.operator === "present"
              ? "exists"
              : cfg.operator === "absent"
                ? "missing"
                : "";
      const value = typeof cfg.value === "string" ? cfg.value : "";
      const valStr =
        (cfg.operator === "equals" || cfg.operator === "contains") && value
          ? ` "${truncate(value, 20)}"`
          : "";
      return subject === "tag" ? subjectStr : `${subjectStr} ${op}${valStr}`;
    }
    case "set_tag": {
      const mode =
        cfg.mode === "remove" ? t("summaryRemoveTag") : t("summaryAddTag");
      const tagId = typeof cfg.tag_id === "string" ? cfg.tag_id : "";
      // No tag name available without an async lookup here; show a
      // short prefix of the UUID so users can disambiguate between
      // multiple set_tag nodes at a glance.
      return tagId
        ? t("summaryTagWithId", { mode, id: tagId.slice(0, 8) })
        : t("summaryTagNone", { mode });
    }
    case "wait_for_link_click": {
      const url = typeof cfg.link_url === "string" ? cfg.link_url : "";
      const text = typeof cfg.message_text === "string" ? cfg.message_text : "";
      if (url) return `🔗 ${truncate(url, 50)}`;
      return text.length > 0 ? truncate(text) : null;
    }
    case "handoff": {
      const note = typeof cfg.note === "string" ? cfg.note : "";
      return note.length > 0 ? truncate(note) : null;
    }
  }
}
