import type { Message } from './upstream.ts'

const id = () => `chatcmpl-magi-${Math.random().toString(36).slice(2, 12)}`

const chunk = (model: string, cid: string, delta: unknown, finish: string | null) =>
  `data: ${JSON.stringify({
    id: cid,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
}

/**
 * Replay an already-complete message as a stream. Used by the select path,
 * where the winning candidate is emitted verbatim so its tool_calls survive
 * intact — a merged tool call is a broken tool call.
 */
export function sseFromMessage(message: Message, finish: string, model: string): Response {
  const cid = id()
  const parts: string[] = [chunk(model, cid, { role: 'assistant' }, null)]

  if (message.content) parts.push(chunk(model, cid, { content: message.content }, null))

  message.tool_calls?.forEach((tc, index) => {
    parts.push(
      chunk(
        model,
        cid,
        { tool_calls: [{ index, id: tc.id, type: 'function', function: tc.function }] },
        null,
      ),
    )
  })

  parts.push(chunk(model, cid, {}, finish))
  parts.push('data: [DONE]\n\n')

  return new Response(parts.join(''), { headers: SSE_HEADERS })
}

export function jsonFromMessage(message: Message, finish: string, model: string): Response {
  return Response.json({
    id: id(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
  })
}

/** Pipe an upstream SSE body straight through to the client. */
export function passthroughStream(res: Response, onEnd?: () => void): Response {
  if (!onEnd) return new Response(res.body, { headers: SSE_HEADERS })

  const reader = res.body!.getReader()
  let ended = false
  const finish = () => {
    if (ended) return
    ended = true
    onEnd()
  }

  const watched = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        finish()
        return
      }
      controller.enqueue(value)
    },
    cancel(reason) {
      finish()
      return reader.cancel(reason)
    },
  })

  return new Response(watched, { headers: SSE_HEADERS })
}
