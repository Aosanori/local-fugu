import { config } from './config.ts'
import type { ChatRequest } from './upstream.ts'

export type Mode = 'auto' | 'moa' | 'fast'
export type Route = { kind: 'passthrough' | 'fanout' | 'speculative'; reason: string }

/** Virtual model id -> fusion mode. */
export function modeOf(model: string): Mode {
  if (model.endsWith('-moa')) return 'moa'
  if (model.endsWith('-fast')) return 'fast'
  return 'auto'
}

/**
 * The routing policy Fugu learns, written by hand instead.
 *
 * The rule that matters for agentic coding: a turn that merely continues the
 * tool loop (last message is a tool result) is high-frequency and low-value, so
 * it goes straight to the primary model. Fan-out is spent on the turns where a
 * decision is actually being made.
 */
export function route(req: ChatRequest, mode: Mode): Route {
  if (mode === 'fast') return { kind: 'passthrough', reason: 'mode=fast' }
  if (mode === 'moa') return { kind: 'fanout', reason: 'mode=moa' }

  const last = req.messages[req.messages.length - 1]

  if (last?.role === 'tool' && !config.router.fanoutOnContinuation) {
    // The edit almost always lands on a continuation turn — the agent reads
    // first, then writes — so a policy that never fans out here can never put
    // competing patches in front of the verifier. Generate once with the
    // primary and escalate only if that turn turns out to be an edit.
    return config.router.speculativeEdit
      ? { kind: 'speculative', reason: 'tool-loop continuation' }
      : { kind: 'passthrough', reason: 'tool-loop continuation' }
  }

  const userChars = req.messages
    .filter((m) => m.role === 'user')
    .reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)

  if (!req.tools && userChars < config.router.trivialChars) {
    return { kind: 'passthrough', reason: `trivial turn (${userChars} chars, no tools)` }
  }

  return { kind: 'fanout', reason: 'deliberate turn' }
}
