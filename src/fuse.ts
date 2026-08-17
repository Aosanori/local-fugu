import { emit } from './bus.ts'
import { seatFor } from './router.ts'
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
  /** prompt + completion tokens the upstream reported */
  tokens?: number
}

const DRAFT_LIMIT = 4000

/**
 * Prompt-size-aware ceiling. A fixed timeout that fits a short prompt is a
 * death sentence for a long one — prefill on tens of thousands of tokens can
 * take longer than the whole base allowance — so the ceiling grows with the
 * conversation being sent.
 */
export const turnTimeoutMs = (req: ChatRequest): number => {
  const chars = req.messages.reduce(
    (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
    0,
  )
  return config.router.proposerTimeoutMs + chars * (config.router.timeoutPerCharMs ?? 2)
}

/** Fan out the same turn to every available proposer, in parallel. */
export async function propose(
  req: ChatRequest,
  opts: { signal?: AbortSignal; exclude?: string[]; turn?: string } = {},
): Promise<Proposal[]> {
  const { signal, exclude = [], turn = '' } = opts
  const pool = proposers().filter((m) => !exclude.includes(m.id))
  const ceiling = turnTimeoutMs(req)

  const settled = await Promise.allSettled(
    pool.map(async (m): Promise<Proposal> => {
      const started = Date.now()
      emit({ type: 'node', turn, id: m.id, state: 'thinking' })
      const { message, finish_reason, tokens } = await complete(
        m,
        // The client's cap governs the answer it receives, not the internal
        // drafts — a reasoning model handed max_tokens=400 spends all of it
        // thinking and returns nothing.
        {
          ...req,
          max_tokens: Math.max(req.max_tokens ?? 0, config.router.proposerMaxTokens),
        },
        { timeoutMs: ceiling, signal },
      )
      const ms = Date.now() - started
      emit({
        type: 'node',
        turn,
        id: m.id,
        state: 'answered',
        ms,
        tokens,
        note: message.tool_calls?.[0]?.function.name ?? `${(message.content ?? '').length} chars`,
      })
      return { member: m, message, finish_reason, ms, tokens }
    }),
  )

  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      console.warn(
        `[magi] proposer ${pool[i].id} failed (ceiling ${Math.round(ceiling / 1000)}s): ${s.reason}`,
      )
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
      seatFor(req).aggregator,
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
      { timeoutMs: turnTimeoutMs(req), signal },
    )
    const digits = String(message.content ?? '').match(/\d+/g)
    const pick = Number(digits?.[digits.length - 1])
    if (Number.isInteger(pick) && candidates[pick]) return candidates[pick]
  } catch (e) {
    console.warn(`[magi] judge failed, falling back to first candidate: ${(e as Error).message}`)
  }

  return candidates[0]
}

/**
 * The conversation's owner reads the drafts and decides whether a debate would
 * change anything.
 *
 * This is the hand-rolled version of Fugu's query-adaptive routing: instead of
 * a rule ("text turn → always debate"), the model that owns the conversation
 * looks at what the panel actually produced. Drafts that already agree, or a
 * question with a checkable answer, are not worth another 90-300 s round.
 */
export async function debateWorthIt(
  req: ChatRequest,
  drafts: Proposal[],
  owner: PoolMember,
  signal?: AbortSignal,
): Promise<{ debate: boolean; why: string }> {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
  const summary = drafts
    .map((d) => `<answer model="${d.member.label ?? d.member.id}">\n${(d.message.content ?? '').slice(0, 900)}\n</answer>`)
    .join('\n')

  try {
    const { message } = await complete(
      owner,
      {
        model: '',
        messages: [
          {
            role: 'system',
            content:
              'You triage answers from a panel of models. Decide if a debate round (each model reads the others and revises) would materially improve the final answer. Debate pays off when the answers disagree on substance, or the question is a judgment call with real trade-offs. It is waste when the answers already agree, or the question is factual, mechanical, or easily checked. Reply with only JSON: {"debate": true|false, "why": "<ten words max>"}',
          },
          {
            role: 'user',
            content: `Question:\n${typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 2000) : '(continuation)'}\n\nPanel answers:\n${summary}`,
          },
        ],
        max_tokens: config.router.reasoningHeadroom + 64,
        temperature: 0,
      },
      { timeoutMs: turnTimeoutMs(req), signal },
    )

    const text = String(message.content ?? '')
    const parsed = /"debate"\s*:\s*(true|false)/.exec(text)
    if (parsed) {
      const why = /"why"\s*:\s*"([^"]{0,120})"/.exec(text)?.[1] ?? ''
      return { debate: parsed[1] === 'true', why }
    }
  } catch (e) {
    console.warn(`[magi] debate triage failed: ${(e as Error).message}`)
  }

  // No verdict — skip. Failing toward the cheap path keeps an overloaded pool
  // from paying for a debate on top of whatever just went wrong.
  return { debate: false, why: 'triage failed, skipped' }
}

/**
 * Self-triage for a continuation turn: the owner just wrote a turn-ending
 * answer with no tool call, and decides whether it is the kind of conclusion
 * that independent opinions could realistically change. This is the entrance
 * through which a debate can restart in the middle of agentic work — the
 * fan-out triage never sees those turns.
 */
export async function worthSecondOpinions(
  req: ChatRequest,
  answer: string,
  owner: PoolMember,
  signal?: AbortSignal,
): Promise<{ escalate: boolean; why: string }> {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')

  try {
    const { message } = await complete(
      owner,
      {
        model: '',
        messages: [
          {
            role: 'system',
            content:
              'You review an answer a coding agent is about to give after investigating. Decide if independent second opinions could realistically change the recommendation. Escalate for judgment calls — architecture choices, trade-offs, migration strategies, anything reasonable experts could answer differently. Do not escalate for factual reports, mechanical summaries of what was found or done, status updates, or anything a test could check. Reply with only JSON: {"escalate": true|false, "why": "<ten words max>"}',
          },
          {
            role: 'user',
            content: `Task:\n${typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 1500) : '(continuation)'}\n\nAnswer about to be given:\n${answer.slice(0, 2500)}`,
          },
        ],
        max_tokens: config.router.reasoningHeadroom + 64,
        temperature: 0,
      },
      { timeoutMs: turnTimeoutMs(req), signal },
    )
    const text = String(message.content ?? '')
    const parsed = /"escalate"\s*:\s*(true|false)/.exec(text)
    if (parsed) {
      const why = /"why"\s*:\s*"([^"]{0,120})"/.exec(text)?.[1] ?? ''
      return { escalate: parsed[1] === 'true', why }
    }
  } catch (e) {
    console.warn(`[magi] self-escalation triage failed: ${(e as Error).message}`)
  }
  return { escalate: false, why: 'triage failed, kept own answer' }
}

/** Character-bigram overlap — language-neutral, works for Japanese as well. */
const bigrams = (s: string): Set<string> => {
  const t = s.replace(/\s+/g, ' ').trim().toLowerCase()
  const out = new Set<string>()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

export function similarity(a: string, b: string): number {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 && B.size === 0) return 1
  let shared = 0
  for (const g of A) if (B.has(g)) shared++
  return shared / (A.size + B.size - shared)
}

/**
 * One round of cross-examination.
 *
 * The proposal round is deliberately blind — that is where the diversity comes
 * from. This is the opposite: every model reads what the others produced and
 * answers again. It only pays off on turns no scorer can settle (design calls,
 * trade-offs), and it costs a full extra fan-out per round, which is why the
 * verifiable paths never run it.
 */
export async function debate(
  req: ChatRequest,
  drafts: Proposal[],
  opts: { signal?: AbortSignal; turn?: string; round: number },
): Promise<Proposal[]> {
  const { signal, turn = '', round } = opts
  const limit = config.debate?.maxPeerChars ?? 2000

  emit({ type: 'debate', turn, round, participants: drafts.map((d) => d.member.id) })

  const settled = await Promise.allSettled(
    drafts.map(async (own): Promise<Proposal> => {
      const peers = drafts.filter((d) => d.member.id !== own.member.id)
      if (peers.length === 0) return own

      emit({ type: 'node', turn, id: own.member.id, state: 'debating' })
      const started = Date.now()

      const transcript = peers
        .map((p) => `<peer id="${p.member.label ?? p.member.id}">\n${(p.message.content ?? '').slice(0, limit)}\n</peer>`)
        .join('\n\n')

      const { message, finish_reason, tokens } = await complete(
        own.member,
        {
          ...req,
          max_tokens: Math.max(req.max_tokens ?? 0, config.router.proposerMaxTokens),
          messages: [
            ...req.messages,
            {
              role: 'user',
              content: `Other models answered this independently. Read them, then answer again yourself.\n\n${transcript}\n\n<your-previous-answer>\n${(own.message.content ?? '').slice(0, limit)}\n</your-previous-answer>\n\nWhere a peer is right and you were wrong, change your position. Where a peer is wrong about something that matters, correct it plainly instead of hedging. Where you already had it right, keep it and do not pad. Output only your improved answer — no commentary about the peers, this instruction, or the fact that you revised.`,
            },
          ],
        },
        { timeoutMs: turnTimeoutMs(req), signal },
      )

      const ms = Date.now() - started

      // A debater that burned its budget thinking and produced nothing has not
      // revised — treating the empty string as its new position would poison
      // the convergence measure (similarity 0 reads as a total rewrite) and
      // hand the synthesizer a blank draft. It keeps its previous answer.
      if ((message.content ?? '').trim() === '') {
        emit({
          type: 'node',
          turn,
          id: own.member.id,
          state: 'answered',
          ms,
          note: `round ${round} · kept previous`,
        })
        return own
      }

      emit({
        type: 'node',
        turn,
        id: own.member.id,
        state: 'answered',
        ms,
        tokens,
        note: `round ${round} · ${(message.content ?? '').length} chars`,
      })
      return { member: own.member, message, finish_reason, ms, tokens }
    }),
  )

  // A model that failed to revise keeps the answer it already gave.
  return settled.map((s, i) => (s.status === 'fulfilled' ? s.value : drafts[i]))
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
