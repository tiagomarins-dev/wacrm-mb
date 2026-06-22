/**
 * Agregador dos catálogos de tradução.
 *
 * Um JSON por (idioma, namespace). A migração é faseada: cada tela traz seu
 * namespace. Importação estática na Fase 1 (catálogo pequeno); migrar para
 * `i18next-resources-to-backend` (import dinâmico) só se o bundle pesar.
 *
 * ⚠️ Ao adicionar um namespace: criar os 2 JSONs (pt-BR + en), importar aqui,
 * registrar em `resources` E em `NAMESPACES`.
 */
import ptCommon from "./pt-BR/common.json";
import ptNav from "./pt-BR/nav.json";
import ptHeader from "./pt-BR/header.json";
import ptSettings from "./pt-BR/settings.json";
import ptAuth from "./pt-BR/auth.json";
import ptDashboard from "./pt-BR/dashboard.json";
import ptBroadcasts from "./pt-BR/broadcasts.json";
import ptContacts from "./pt-BR/contacts.json";
import ptInbox from "./pt-BR/inbox.json";
import ptSettingsNav from "./pt-BR/settingsNav.json";
import ptPipelines from "./pt-BR/pipelines.json";
import ptLeadScore from "./pt-BR/leadScore.json";
import ptAutomations from "./pt-BR/automations.json";
import ptFlows from "./pt-BR/flows.json";
import ptJoin from "./pt-BR/join.json";
import ptBroadcastWizard from "./pt-BR/broadcastWizard.json";
import ptSettingsWhatsapp from "./pt-BR/settingsWhatsapp.json";
import ptSettingsTemplates from "./pt-BR/settingsTemplates.json";
import ptSettingsQuickReplies from "./pt-BR/settingsQuickReplies.json";
import ptSettingsMembers from "./pt-BR/settingsMembers.json";
import enCommon from "./en/common.json";
import enNav from "./en/nav.json";
import enHeader from "./en/header.json";
import enSettings from "./en/settings.json";
import enAuth from "./en/auth.json";
import enDashboard from "./en/dashboard.json";
import enBroadcasts from "./en/broadcasts.json";
import enContacts from "./en/contacts.json";
import enInbox from "./en/inbox.json";
import enSettingsNav from "./en/settingsNav.json";
import enPipelines from "./en/pipelines.json";
import enLeadScore from "./en/leadScore.json";
import enAutomations from "./en/automations.json";
import enFlows from "./en/flows.json";
import enJoin from "./en/join.json";
import enBroadcastWizard from "./en/broadcastWizard.json";
import enSettingsWhatsapp from "./en/settingsWhatsapp.json";
import enSettingsTemplates from "./en/settingsTemplates.json";
import enSettingsQuickReplies from "./en/settingsQuickReplies.json";
import enSettingsMembers from "./en/settingsMembers.json";

export const NAMESPACES = ["common", "nav", "header", "settings", "auth", "dashboard", "broadcasts", "contacts", "inbox", "settingsNav", "pipelines", "leadScore", "automations", "flows", "join", "broadcastWizard", "settingsWhatsapp", "settingsTemplates", "settingsQuickReplies", "settingsMembers"] as const;
export const DEFAULT_NS = "common";

export const resources = {
  "pt-BR": { common: ptCommon, nav: ptNav, header: ptHeader, settings: ptSettings, auth: ptAuth, dashboard: ptDashboard, broadcasts: ptBroadcasts, contacts: ptContacts, inbox: ptInbox, settingsNav: ptSettingsNav, pipelines: ptPipelines, leadScore: ptLeadScore, automations: ptAutomations, flows: ptFlows, join: ptJoin, broadcastWizard: ptBroadcastWizard, settingsWhatsapp: ptSettingsWhatsapp, settingsTemplates: ptSettingsTemplates, settingsQuickReplies: ptSettingsQuickReplies, settingsMembers: ptSettingsMembers },
  en: { common: enCommon, nav: enNav, header: enHeader, settings: enSettings, auth: enAuth, dashboard: enDashboard, broadcasts: enBroadcasts, contacts: enContacts, inbox: enInbox, settingsNav: enSettingsNav, pipelines: enPipelines, leadScore: enLeadScore, automations: enAutomations, flows: enFlows, join: enJoin, broadcastWizard: enBroadcastWizard, settingsWhatsapp: enSettingsWhatsapp, settingsTemplates: enSettingsTemplates, settingsQuickReplies: enSettingsQuickReplies, settingsMembers: enSettingsMembers },
} as const;
