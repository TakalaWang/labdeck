import { config } from './config.ts'
import { cut } from './util.ts'

// Every way out of the process that tests replace (the former tests patched httpx / core.notify the same way).

async function defaultNotify(text: string): Promise<void> {
  if (!config.discordWebhookUrl) return
  try {
    const r = await io.fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'labdeck' },
      body: JSON.stringify({ content: cut(text, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) console.warn(`discord notify failed: HTTPError ${r.status}`)
  } catch (e) {
    // never log the webhook URL
    console.warn(`discord notify failed: ${e instanceof Error ? e.name : 'Error'}`)
  }
}

export const io = {
  fetch: (input: string, init?: RequestInit): Promise<Response> => fetch(input, init),
  /** Post to the admins' Discord channel; mentions disabled so user text can't ping anyone. */
  notify: defaultNotify as (text: string) => Promise<void> | void,
}

export function notify(text: string): Promise<void> {
  return Promise.resolve(io.notify(text))
}
