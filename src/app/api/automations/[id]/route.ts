import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
  type StepLike,
} from '@/lib/automations/validate'
import {
  generateWebhookToken,
  validateWebhookMetaTemplateFirst,
} from '@/lib/automations/webhook-token'
import { getActiveConnection } from '@/lib/connections/active'

async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = supabaseAdmin()
  const { data: automation, error } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const steps = await loadStepsTree(id)
  return NextResponse.json({ automation, steps })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const admin = supabaseAdmin()

  // Ownership check before we touch anything. Load the fields we need
  // to compute the post-patch "effective" state for validation.
  const { data: existing } = await admin
    .from('automations')
    .select(
      'id, user_id, account_id, connection_id, is_active, trigger_type, trigger_config, webhook_token',
    )
    .eq('id', id)
    .maybeSingle()
  if (!existing || existing.user_id !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const update: Record<string, unknown> = {}
  for (const k of [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'is_active',
  ] as const) {
    if (k in body) update[k] = body[k]
  }

  const effectiveTrigger = (update.trigger_type ?? existing.trigger_type) as string

  // Trigger webhook (074): gera token quando não existe — cobre tanto a
  // troca de trigger quanto o clone do duplicate (que copia trigger_type
  // mas nasce sem token).
  if (effectiveTrigger === 'webhook_received' && !existing.webhook_token) {
    update.webhook_token = generateWebhookToken()
  }

  // If this PATCH leaves the automation active (either explicitly
  // activating it OR editing an already-active one), validate the
  // merged configuration first. Activation is the natural gate — drafts
  // are still allowed to be incomplete.
  const willBeActive =
    typeof update.is_active === 'boolean' ? update.is_active : existing.is_active
  if (willBeActive) {
    const mergedTriggerType = (update.trigger_type ?? existing.trigger_type) as string
    const mergedTriggerConfig = update.trigger_config ?? existing.trigger_config
    const mergedSteps = Array.isArray(body.steps)
      ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
      : await loadStepsTree(id)
    const issues = [
      ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
      ...validateStepsForActivation(mergedSteps),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot keep automation active with invalid configuration',
          issues,
        },
        { status: 400 },
      )
    }

    if (effectiveTrigger === 'webhook_received') {
      // Conexão: automação antiga/duplicada pode ter connection_id null.
      // Backfill pela conexão ativa (espelha o POST); conta sem conexão
      // não pode ativar webhook.
      let connId = existing.connection_id as string | null
      if (!connId) {
        const supabase = await createClient()
        const active = await getActiveConnection(supabase, existing.account_id).catch(
          () => null,
        )
        if (!active) {
          return NextResponse.json(
            {
              error: 'Cannot keep automation active with invalid configuration',
              issues: [
                {
                  path: 'trigger',
                  message:
                    'Automação webhook precisa de uma conexão WhatsApp configurada.',
                },
              ],
            },
            { status: 400 },
          )
        }
        connId = active.id
        update.connection_id = connId
      }
      const metaIssues = await validateWebhookMetaTemplateFirst(
        admin,
        connId,
        mergedSteps as unknown as StepLike[],
      )
      if (metaIssues.length > 0) {
        return NextResponse.json(
          {
            error: 'Cannot keep automation active with invalid configuration',
            issues: metaIssues,
          },
          { status: 400 },
        )
      }
    }
  }

  if (Object.keys(update).length > 0) {
    const { error: updErr } = await admin
      .from('automations')
      .update(update)
      .eq('id', id)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  if (Array.isArray(body.steps)) {
    const err = await replaceSteps(id, body.steps as BuilderStepInput[])
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }

  // Devolve o token (gerado agora ou já existente) pro builder atualizar
  // o card do webhook sem precisar de re-fetch.
  return NextResponse.json({
    ok: true,
    webhook_token:
      (update.webhook_token as string | undefined) ?? existing.webhook_token ?? null,
  })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await supabaseAdmin()
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
