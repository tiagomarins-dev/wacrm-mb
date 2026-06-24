import { describe, expect, it } from 'vitest'
import { recordAgentRun, type AgentRunInsert } from './telemetry'

// Run mínima válida p/ os testes (campos que o insert recebe).
const RUN = {
  account_id: 'acc-1', connection_id: 'c', conversation_id: 'cv', contact_id: 'ct',
  profile_id: 'p', inbound_message_id: 'wamid', model: 'm', status: 'ok',
  error_phase: null, error_message: null, finish_reason: 'stop',
  requests: 1, turns: 1, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
  cost_usd: 0.0003, latency_ms: 120, llm_ms: 100, tools_used: [], topic: 'vendas',
  handoff: false, guardrail_hits: 0,
} as AgentRunInsert

// db fake: registra o insert; modo `throws` simula falha de boundary.
function makeDb(mode: 'ok' | 'error' | 'throws') {
  const inserts: unknown[] = []
  const db = {
    from: () => ({
      insert: (payload: unknown) => {
        if (mode === 'throws') throw new Error('relation "ai_agent_runs" does not exist')
        inserts.push(payload)
        return { error: mode === 'error' ? { message: 'boom' } : null }
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { db, inserts }
}

describe('recordAgentRun', () => {
  it('insere a run em ai_agent_runs', async () => {
    const { db, inserts } = makeDb('ok')
    await recordAgentRun(db, RUN)
    expect(inserts).toHaveLength(1)
    expect((inserts[0] as { status: string }).status).toBe('ok')
  })

  it('erro retornado pelo insert é engolido (não lança)', async () => {
    const { db } = makeDb('error')
    await expect(recordAgentRun(db, RUN)).resolves.toBeUndefined()
  })

  it('exceção do boundary (tabela ausente) é engolida (não lança)', async () => {
    const { db } = makeDb('throws')
    await expect(recordAgentRun(db, RUN)).resolves.toBeUndefined()
  })
})
