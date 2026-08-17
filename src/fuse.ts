import { emit } from './bus.ts'
import { config, member, type PoolMember, proposers } from './config.ts'
import { complete, type ChatRequest, type Message, type ToolCall } from './upstream.ts'
import {
  type Edit,
  materialize,
  scorersFor,
  scoreWorkspace,
  verifyConfig,
  workspaceRoot,
} from './verify.ts'

export type Proposal = {
  member: PoolMember
  message: Message
  finish_reason: string
  ms: number
}

const DRAFT_LIMIT = 4000

/** Fan out the same turn to every available proposer, in parallel. */
export async function propose(
  req: ChatRequest,
  opts: { signal?: AbortSignal; exclude?: string[]; turn?: string } = {},
): Promise<Proposal[]> {
  const { signal, exclude = [], turn = '' } = opts
  const pool = proposers().filter((m) => !exclude.includes(m.id))

  const settled = await Promise.allSettled(
    pool.map(async (m): Promise<Proposal> => {
      const started = Date.now()
      emit({ type: 'node', turn, id: m.id, state: 'thinking' })
      const { message, finish_reason } = await complete(
        m,
        // The client's cap governs the answer it receives, not the internal
        // drafts — a reasoning model handed max_tokens=400 spends all of it
        // thinking and returns nothing.
        {
          ...req,
          max_tokens: Math.max(req.max_tokens ?? 0, config.router.proposerMaxTokens),
        },
        { timeoutMs: config.router.proposerTimeoutMs, signal },
      )
      const ms = Date.now() - started
      emit({
        type: 'node',
        turn,
        id: m.id,
        state: 'answered',
        ms,
        note: message.tool_calls?.[0]?.function.name ?? `${(message.content ?? '').length} chars`,
      })
      return { member: m, message, finish_reason, ms }
    }),
  )

  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      console.warn(`[fugu] proposer ${pool[i].id} failed: ${s.reason}`)
      emit({ type: 'node', turn, id: pool[i].id, state: 'error', note: String(s.reason).slice(0, 80) })
    }
  })

  // A reasoning model that spent its whole budget thinking contributes nothing.
  return settled
    .flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
    .filter((p) => (p.message.content ?? '').trim() !== '' || (p.message.tool_calls?.length ?? 0) > 0)
}

const argsKey = (tc: ToolCall) => {
  try {
    const parsed = JSON.parse(tc.function.arguments || '{}')
    return JSON.stringify(Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b))))
  } catch {
    return tc.function.arguments
  }
}

const callKey = (m: Message) =>
  (m.tool_calls ?? []).map((tc) => `${tc.function.name}(${argsKey(tc)})`).join('|')

/**
 * Tool calls cannot be blended, so on tool turns the pool votes instead: if a
 * majority proposed the identical call, take it without paying for a judge.
 */
export function consensus(toolCallers: Proposal[]): Proposal | null {
  if (toolCallers.length === 0) return null

  const groups = new Map<string, Proposal[]>()
  for (const p of toolCallers) {
    const k = callKey(p.message)
    groups.set(k, [...(groups.get(k) ?? []), p])
  }

  const [best] = [...groups.values()].sort((a, b) => b.length - a.length)
  return best.length * 2 > toolCallers.length ? best[0] : null
}

/** Break a tie by asking the aggregator to pick one candidate whole. */
export async function judge(
  req: ChatRequest,
  candidates: Proposal[],
  signal?: AbortSignal,
): Promise<Proposal> {
  const summary = candidates
    .map((p, i) => {
      const calls = (p.message.tool_calls ?? [])
        .map((tc) => `${tc.function.name} ${tc.function.arguments}`)
        .join('\n')
      return `[${i}]\n${calls || (p.message.content ?? '').slice(0, DRAFT_LIMIT)}`
    })
    .join('\n\n')

  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')

  try {
    const { message } = await complete(
      member(config.aggregator),
      {
        model: '',
        messages: [
          {
            role: 'system',
            content:
              'You pick the single best next action for a coding agent. Reply with only a JSON object: {"pick": <index>}.',
          },
          {
            role: 'user',
            content: `Task:\n${typeof lastUser?.content === 'string' ? lastUser.content.slice(0, DRAFT_LIMIT) : '(continuation)'}\n\nCandidate next actions:\n${summary}\n\nWhich index is most likely correct and safe?`,
          },
        ],
        // Enough room to think and still emit the answer: a reasoning model
        // capped at a few tokens returns empty content, which silently turned
        // this judge into "always pick the first candidate".
        max_tokens: config.router.reasoningHeadroom + 64,
        temperature: 0,
      },
      { timeoutMs: config.router.proposerTimeoutMs, signal },
    )
    const digits = String(message.content ?? '').match(/\d+/g)
    const pick = Number(digits?.[digits.length - 1])
    if (Number.isInteger(pick) && candidates[pick]) return candidates[pick]
  } catch (e) {
    console.warn(`[fugu] judge failed, falling back to first candidate: ${(e as Error).message}`)
  }

  return candidates[0]
}

export type VerifyOutcome = {
  winner: Proposal
  baseline: number
  best: number
  /** distinct edits actually scored — identical proposals collapse into one */
  scored: number
  regression: boolean
  detail: string
}

/**
 * Score-based selection: instead of asking a model which edit is best, apply
 * each candidate edit to a throwaway clone of the project and let the analyzer
 * and the test suite answer. Returns null when the turn is not scoreable, in
 * which case the caller falls back to consensus or the judge.
 */
export async function verifiedSelect(
  candidates: Proposal[],
  turn = '',
): Promise<VerifyOutcome | null> {
  const cfg = verifyConfig()
  if (!cfg?.enabled) return null

  const editors = candidates.filter((p) => {
    const call = p.message.tool_calls?.[0]
    return call && cfg.editTools.includes(call.function.name)
  })
  if (editors.length === 0) return null

  // One entry per distinct proposed edit; identical proposals score identically.
  const distinct = new Map<string, Proposal>()
  for (const p of editors) if (!distinct.has(callKey(p.message))) distinct.set(callKey(p.message), p)

  const shortlist = [...distinct.values()].slice(0, cfg.maxCandidates)
  const edits = await Promise.all(shortlist.map((p) => materialize(p.message.tool_calls![0])))

  const applicable = shortlist
    .map((proposal, i) => ({ proposal, edit: edits[i] }))
    .filter((c): c is { proposal: Proposal; edit: Edit } => c.edit !== null)
  if (applicable.length === 0) return null

  const root = workspaceRoot(applicable[0].edit.filePath, cfg.workspaceMarkers)
  if (!root) return null

  const scorers = scorersFor(applicable[0].edit.filePath, cfg.scorers)
  if (scorers.length === 0) return null

  const baseline = await scoreWorkspace(root, scorers, null)

  const scored = []
  for (const c of applicable) {
    const score = await scoreWorkspace(root, scorers, c.edit)
    scored.push({ ...c, score })
  }

  const winner = scored.reduce((a, b) => (b.score.total > a.score.total ? b : a))

  emit({
    type: 'verify',
    turn,
    baseline: baseline.total,
    best: winner.score.total,
    regression: winner.score.total < baseline.total,
    scores: scored.map((s) => ({
      id: s.proposal.member.id,
      total: s.score.total,
      detail: s.score.detail,
    })),
  })

  return {
    winner: winner.proposal,
    baseline: baseline.total,
    best: winner.score.total,
    scored: scored.length,
    regression: winner.score.total < baseline.total,
    detail: scored
      .map((s) => `${s.proposal.member.id}:${s.score.total}[${s.score.detail}]`)
      .join(' '),
  }
}

/**
 * Build the aggregator turn for text answers: the original conversation plus
 * the drafts as reference material.
 */
export function synthesisRequest(req: ChatRequest, drafts: Proposal[]): ChatRequest {
  const refs = drafts
    .map((p) => `<draft id="${p.member.id}">\n${(p.message.content ?? '').slice(0, DRAFT_LIMIT)}\n</draft>`)
    .join('\n\n')

  return {
    ...req,
    // Same reasoning-budget trap as the proposers: the aggregator has to think
    // *and* write the answer the client asked for.
    max_tokens: (req.max_tokens ?? config.router.proposerMaxTokens) + config.router.reasoningHeadroom,
    messages: [
      ...req.messages,
      {
        role: 'user',
        content: `Independent drafts for the request above were produced by other models. Treat them as reference only — they may be wrong.\n\n${refs}\n\nNow write the single best response yourself. Prefer what you can verify from the conversation over anything asserted only in a draft. Do not mention the drafts or this instruction.`,
      },
    ],
  }
}
