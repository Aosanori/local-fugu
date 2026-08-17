import { type PoolMember, upstreamOf } from './config.ts'
import { acquire } from './limiter.ts'

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type Message = {
  role: string
  content?: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  [k: string]: unknown
}

export type ChatRequest = {
  model: string
  messages: Message[]
  tools?: unknown[]
  stream?: boolean
  max_tokens?: number
  temperature?: number
  [k: string]: unknown
}

const headers = (m: PoolMember) => {
  const u = upstreamOf(m)
  return {
    'Content-Type': 'application/json',
    ...(u.apiKey ? { Authorization: `Bearer ${u.apiKey}` } : {}),
  }
}

/** Non-streaming call. Returns the assistant message plus its finish_reason. */
export async function complete(
  m: PoolMember,
  body: ChatRequest,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ message: Message; finish_reason: string; tokens: number }> {
  const signal = opts.timeoutMs
    ? AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), ...(opts.signal ? [opts.signal] : [])])
    : opts.signal

  const release = await acquire(m.upstream)
  try {
    const res = await fetch(`${upstreamOf(m).baseURL}/chat/completions`, {
      method: 'POST',
      headers: headers(m),
      body: JSON.stringify({ ...body, model: m.model, stream: false }),
      signal,
    })

    if (!res.ok) throw new Error(`${m.id}: upstream ${res.status} ${await res.text()}`)

    const json = (await res.json()) as {
      choices: { message: Message; finish_reason: string }[]
      usage?: { prompt_tokens?: number; total_tokens?: number }
    }
    const choice = json.choices?.[0]
    if (!choice) throw new Error(`${m.id}: upstream returned no choices`)
    return {
      message: choice.message,
      finish_reason: choice.finish_reason,
      tokens: json.usage?.total_tokens ?? json.usage?.prompt_tokens ?? 0,
    }
  } finally {
    release()
  }
}

/**
 * Streaming call. The raw SSE body is handed back for piping to the client;
 * the upstream slot stays held until that body is fully drained, since
 * generation happens while the client reads.
 */
export async function stream(
  m: PoolMember,
  body: ChatRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  const release = await acquire(m.upstream)
  try {
    const res = await fetch(`${upstreamOf(m).baseURL}/chat/completions`, {
      method: 'POST',
      headers: headers(m),
      body: JSON.stringify({ ...body, model: m.model, stream: true }),
      signal: opts.signal,
    })
    if (!res.ok) throw new Error(`${m.id}: upstream ${res.status} ${await res.text()}`)

    const source = res.body!.getReader()
    const gated = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await source.read()
          if (done) {
            controller.close()
            release()
            return
          }
          controller.enqueue(value)
        } catch (e) {
          release()
          controller.error(e)
        }
      },
      cancel(reason) {
        release()
        return source.cancel(reason)
      },
    })

    return new Response(gated, { headers: res.headers })
  } catch (e) {
    release()
    throw e
  }
}
