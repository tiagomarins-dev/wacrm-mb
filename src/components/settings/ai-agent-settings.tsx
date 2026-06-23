'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { AiProfilesManager } from './ai-profiles-manager';
import { AiCoursesManager } from './ai-courses-manager';
import { AiSupportManager } from './ai-support-manager';

type Tab = 'profiles' | 'courses' | 'support';

/**
 * Painel "Agente IA": sub-abas Perfis / Cursos / Suporte, montando os três
 * managers. Seção admin-only (filtrada no settings-rail; RLS reforça no banco).
 */
export function AiAgentSettings() {
  const { t } = useTranslation('settingsAiAgent');
  const [tab, setTab] = useState<Tab>('profiles');

  const tabs: { id: Tab; label: string }[] = [
    { id: 'profiles', label: t('tabProfiles') },
    { id: 'courses', label: t('tabCourses') },
    { id: 'support', label: t('tabSupport') },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => setTab(tb.id)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              tab === tb.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'profiles' && <AiProfilesManager />}
      {tab === 'courses' && <AiCoursesManager />}
      {tab === 'support' && <AiSupportManager />}
    </div>
  );
}
