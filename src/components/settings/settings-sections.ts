import {
  Bot,
  Coins,
  FileText,
  LayoutGrid,
  MessageSquare,
  Palette,
  PlugZap,
  Shield,
  Tags,
  TrendingUp,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'templates',
  'quick-replies',
  'integrations',
  'lead-score',
  'ai-agent',
  'fields',
  'deals',
  'members',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  /** Chave i18n (namespace settingsNav) resolvida no render do rail. */
  labelKey: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
  /** Escondido para quem não é admin (filtrado no settings-rail). */
  adminOnly?: boolean;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', labelKey: 'overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', labelKey: 'profile', icon: User, group: 'account' },
  security: { id: 'security', labelKey: 'security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', labelKey: 'appearance', icon: Palette, group: 'account' },
  whatsapp: { id: 'whatsapp', labelKey: 'whatsapp', icon: PlugZap, group: 'workspace' },
  templates: { id: 'templates', labelKey: 'templates', icon: FileText, group: 'workspace' },
  'quick-replies': { id: 'quick-replies', labelKey: 'quickReplies', icon: MessageSquare, group: 'workspace' },
  integrations: { id: 'integrations', labelKey: 'integrations', icon: Zap, group: 'workspace', adminOnly: true },
  'lead-score': { id: 'lead-score', labelKey: 'leadScore', icon: TrendingUp, group: 'workspace', adminOnly: true },
  'ai-agent': { id: 'ai-agent', labelKey: 'aiAgent', icon: Bot, group: 'workspace', adminOnly: true },
  fields: { id: 'fields', labelKey: 'fields', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', labelKey: 'deals', icon: Coins, group: 'workspace' },
  members: { id: 'members', labelKey: 'members', icon: UsersRound, group: 'workspace' },
};

export const RAIL_GROUPS: { labelKey: string | null; group: SectionMeta['group'] }[] = [
  { labelKey: null, group: 'top' },
  { labelKey: 'groupAccount', group: 'account' },
  { labelKey: 'groupWorkspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
