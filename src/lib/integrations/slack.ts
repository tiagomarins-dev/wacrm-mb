// ============================================================
// Slack — posta uma mensagem num canal via chat.postMessage (bot token).
// Slack responde { ok:false, error } com HTTP 200, então checamos o body.
// ============================================================

const SLACK_URL = 'https://slack.com/api/chat.postMessage'
const TIMEOUT_MS = 10_000

export interface PostSlackArgs {
  botToken: string
  channelId: string
  text: string
}

/** Posta no canal. Devolve ts (id da msg) + channel. */
export async function postSlackMessage(
  args: PostSlackArgs,
): Promise<{ ts: string; channel: string }> {
  const { botToken, channelId, text } = args
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(SLACK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error('Slack timed out')
    throw new Error('Slack request failed')
  } finally {
    clearTimeout(timeout)
  }

  const data = (await res.json()) as {
    ok?: boolean
    error?: string
    ts?: string
    channel?: string
  }
  if (!data.ok) {
    throw new Error(`Slack error: ${data.error ?? 'unknown'}`)
  }
  return { ts: data.ts ?? '', channel: data.channel ?? channelId }
}
