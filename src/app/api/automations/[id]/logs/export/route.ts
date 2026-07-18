import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { AutomationLogStepResult } from '@/types'

// Exporta os logs de execução de uma automação em CSV (download).
// Usa o client de SESSÃO (RLS) — o acesso é o mesmo da página de logs:
// membro da conta enxerga, fora dela não. Sem service-role de propósito.
const MAX_ROWS = 10_000

// Escapa um valor pro CSV: aspas duplas seguras + defesa contra CSV
// formula injection — nome/erro vêm de dado controlável externamente
// (payload do webhook); começando com = + - @ tab/CR, o Excel executaria
// como fórmula. Prefixo com apóstrofo neutraliza.
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return `"${s.replace(/"/g, '""')}"`
}

// Motivo do erro: error_message do log + detalhe de cada etapa que falhou.
function errorReason(
  errorMessage: string | null | undefined,
  steps: AutomationLogStepResult[] | null | undefined,
): string {
  const parts: string[] = []
  if (errorMessage) parts.push(errorMessage)
  for (const s of steps ?? []) {
    if (s.status === 'failed' && s.detail) parts.push(`${s.step_type}: ${s.detail}`)
  }
  return parts.join(' | ')
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Automação (RLS filtra por conta) — também dá o nome pro arquivo.
  const { data: automation } = await supabase
    .from('automations')
    .select('id, name')
    .eq('id', id)
    .maybeSingle()
  if (!automation) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data: logs, error } = await supabase
    .from('automation_logs')
    .select('status, trigger_event, error_message, steps_executed, created_at, contact:contacts(name, phone, email)')
    .eq('automation_id', id)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const header = [
    'data_hora',
    'status',
    'gatilho',
    'contato_nome',
    'telefone',
    'email',
    'etapas',
    'erro',
  ]
  const lines = [header.join(',')]
  for (const log of logs ?? []) {
    const contact = (log.contact ?? null) as {
      name?: string | null
      phone?: string | null
      email?: string | null
    } | null
    const steps = (log.steps_executed ?? []) as AutomationLogStepResult[]
    lines.push(
      [
        csvCell(log.created_at),
        csvCell(log.status),
        csvCell(log.trigger_event),
        csvCell(contact?.name),
        csvCell(contact?.phone),
        csvCell(contact?.email),
        csvCell(steps.length),
        csvCell(errorReason(log.error_message as string | null, steps)),
      ].join(','),
    )
  }

  // BOM pro Excel abrir acentos certos; nome do arquivo com slug da automação.
  const csv = '\uFEFF' + lines.join('\r\n')
  const slug = (automation.name as string)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="logs-${slug || 'automacao'}.csv"`,
    },
  })
}
