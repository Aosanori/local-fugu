import { join } from 'node:path'
import { emit, newTurn, replay, subscribe } from './bus.ts'
import { config, member, probe, proposers } from './config.ts'
import { consensus, judge, propose, synthesisRequest, verifiedSelect } from './fuse.ts'
import { modeOf, route } from './router.ts'
import { jsonFromMessage, passthroughStream, sseFromMessage } from './sse.ts'
import { complete, stream, type ChatRequest, type Message } from './upstream.ts'
import { verifyConfig } from './verify.ts'

await probe()

const VIRTUAL_MODELS = ['fugu-auto', 'fugu-moa', 'fugu-fast']

const log = (parts: Record<string, unknown>) =>
  console.log(
    '[fugu] ' +
      Object.entries(parts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  )

const nodes = () =>
  config.pool
    .filter((m) => m.available)
    .map((m) => ({ id: m.id, label: m.label ?? m.id.toUpperCase(), model: m.model }))

/** Last thing the user actually asked, for the console's 提訴 panel. */
const petition = (messages: Message[]): string => {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  const text = typeof last?.content === 'string' ? last.content : ''
  return text.replace(/\s+/g, ' ').slice(0, 240)
}

async function handleChat(req: Request): Promise<Response> {
  const body = (await req.json()) as ChatRequest
  const virtual = body.model

  if (process.env.FUGU_DUMP) await Bun.write(process.env.FUGU_DUMP, JSON.stringify(body, null, 2))
  const mode = modeOf(virtual)
  const decision = route(body, mode)
  const started = Date.now()
  const wantsStream = body.stream !== false
  const turn = newTurn()

  emit({
    type: 'turn',
    turn,
    route: decision.kind,
    reason: decision.reason,
    prompt: petition(body.messages),
    tools: body.tools?.length ?? 0,
  })

  // Strip our virtual id; each upstream call sets its own real model.
  const base: ChatRequest = { ...body, model: '' }

  const single = async (m: ReturnType<typeof member>, request: ChatRequest, label: string) => {
    emit({ type: 'node', turn, id: m.id, state: 'thinking' })
    if (wantsStream) {
      const res = await stream(m, request, { signal: req.signal })
      return passthroughStream(res, () => {
        emit({ type: 'node', turn, id: m.id, state: 'winner' })
        emit({ type: 'decision', turn, mode: label, winner: m.id, ms: Date.now() - started })
      })
    }
    const { message, finish_reason } = await complete(m, request, { signal: req.signal })
    emit({ type: 'node', turn, id: m.id, state: 'winner' })
    emit({ type: 'decision', turn, mode: label, winner: m.id, ms: Date.now() - started })
    return jsonFromMessage(message, finish_reason, virtual)
  }

  if (decision.kind === 'passthrough') {
    const m = member(config.primary)
    log({ route: 'passthrough', why: `"${decision.reason}"`, model: m.id })
    return single(m, base, 'passthrough')
  }

  if (decision.kind === 'speculative') {
    const m = member(config.primary)
    emit({ type: 'node', turn, id: m.id, state: 'thinking' })
    const first = await complete(m, base, { signal: req.signal })
    const call = first.message.tool_calls?.[0]
    const isEdit = !!call && (verifyConfig()?.editTools.includes(call.function.name) ?? false)
    emit({
      type: 'node',
      turn,
      id: m.id,
      state: 'answered',
      ms: Date.now() - started,
      note: call?.function.name ?? 'text',
    })

    if (!isEdit) {
      log({ route: 'speculative', escalated: 'no', model: m.id, call: call?.function.name ?? '-' })
      emit({ type: 'node', turn, id: m.id, state: 'winner' })
      emit({
        type: 'decision',
        turn,
        mode: 'speculative',
        winner: m.id,
        call: call?.function.name,
        ms: Date.now() - started,
      })
      return wantsStream
        ? sseFromMessage(first.message, first.finish_reason, virtual)
        : jsonFromMessage(first.message, first.finish_reason, virtual)
    }

    // An edit is on the table, so it is worth paying for rivals to score against.
    const rivals = await propose(base, { signal: req.signal, exclude: [m.id], turn })
    const candidates = [
      { member: m, message: first.message, finish_reason: first.finish_reason, ms: 0 },
      ...rivals.filter((r) => (r.message.tool_calls?.length ?? 0) > 0),
    ]
    const verified = await verifiedSelect(candidates, turn).catch((e) => {
      console.warn(`[fugu] verify failed: ${(e as Error).message}`)
      return null
    })
    const winner = verified?.winner ?? candidates[0]

    log({
      route: 'speculative',
      escalated: 'yes',
      candidates: candidates.length,
      ...(verified
        ? {
            baseline: verified.baseline,
            best: verified.best,
            scored: verified.scored,
            regression: verified.regression,
            scores: `"${verified.detail}"`,
          }
        : { verified: 'n/a' }),
      winner: winner.member.id,
      ms: Date.now() - started,
    })
    announce(turn, candidates.map((c) => c.member.id), winner.member.id)
    emit({
      type: 'decision',
      turn,
      mode: verified ? 'verify' : 'speculative',
      winner: winner.member.id,
      call: winner.message.tool_calls?.[0]?.function.name,
      ms: Date.now() - started,
    })

    const finish = winner.finish_reason || 'tool_calls'
    return wantsStream
      ? sseFromMessage(winner.message, finish, virtual)
      : jsonFromMessage(winner.message, finish, virtual)
  }

  const drafts = await propose(base, { signal: req.signal, turn })

  if (drafts.length < config.router.minProposers) {
    const m = member(config.primary)
    log({ route: 'fanout', result: 'degraded', proposers: drafts.length, fallback: m.id })
    return single(m, base, 'degraded')
  }

  const toolCallers = drafts.filter((d) => (d.message.tool_calls?.length ?? 0) > 0)

  // Tool-call turn: pick one candidate whole rather than merging.
  if (toolCallers.length * 2 >= drafts.length) {
    const agreed = consensus(toolCallers)

    // A deterministic score beats a model's opinion whenever one is available,
    // so it is tried even when the pool already agrees — a unanimous edit can
    // still be a regression.
    const verified = await verifiedSelect(toolCallers, turn).catch((e) => {
      console.warn(`[fugu] verify failed: ${(e as Error).message}`)
      return null
    })

    const winner = verified?.winner ?? agreed ?? (await judge(base, toolCallers, req.signal))
    log({
      route: 'fanout',
      mode: verified ? 'verify' : 'select',
      proposers: `${drafts.length}/${proposers().length}`,
      consensus: agreed ? 'yes' : 'no',
      ...(verified
        ? {
            baseline: verified.baseline,
            best: verified.best,
            scored: verified.scored,
            regression: verified.regression,
            scores: `"${verified.detail}"`,
          }
        : {}),
      winner: winner.member.id,
      call: winner.message.tool_calls?.[0]?.function.name,
      ms: Date.now() - started,
    })
    announce(turn, drafts.map((d) => d.member.id), winner.member.id)
    emit({
      type: 'decision',
      turn,
      mode: verified ? 'verify' : 'select',
      winner: winner.member.id,
      call: winner.message.tool_calls?.[0]?.function.name,
      ms: Date.now() - started,
    })

    const finish = winner.finish_reason || 'tool_calls'
    return wantsStream
      ? sseFromMessage(winner.message, finish, virtual)
      : jsonFromMessage(winner.message, finish, virtual)
  }

  // Text turn: synthesize one answer from the drafts.
  const agg = member(config.aggregator)
  const synth = synthesisRequest(base, drafts)
  log({
    route: 'fanout',
    mode: 'synthesize',
    proposers: `${drafts.length}/${proposers().length}`,
    aggregator: agg.id,
    fanoutMs: Date.now() - started,
  })
  emit({ type: 'node', turn, id: agg.id, state: 'thinking' })

  const finish = () => {
    announce(turn, [...drafts.map((d) => d.member.id), agg.id], agg.id, 'contributed')
    emit({
      type: 'decision',
      turn,
      mode: 'synthesize',
      winner: agg.id,
      ms: Date.now() - started,
    })
  }

  if (wantsStream) {
    return passthroughStream(await stream(agg, synth, { signal: req.signal }), finish)
  }
  const { message, finish_reason } = await complete(agg, synth, { signal: req.signal })
  finish()
  return jsonFromMessage(message, finish_reason, virtual)
}

/**
 * Mark the winner and everyone else, so the console can settle. Losers of a
 * selection are 否決; drafts that fed a synthesis are 参考 — they were used.
 */
function announce(turn: string, participants: string[], winner: string, loser: 'rejected' | 'contributed' = 'rejected'): void {
  for (const id of new Set(participants)) {
    emit({ type: 'node', turn, id, state: id === winner ? 'winner' : loser })
  }
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }

const server = Bun.serve({
  port: config.listen,
  idleTimeout: 255,
  async fetch(req) {
    const { pathname } = new URL(req.url)

    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

    if (pathname === '/' || pathname === '/console') {
      return new Response(Bun.file(join(import.meta.dir, 'console.html')), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    if (pathname === '/events') {
      const encoder = new TextEncoder()
      let unsubscribe = () => {}
      const body = new ReadableStream({
        start(controller) {
          const send = (e: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
          send({ type: 'hello', nodes: nodes() })
          for (const e of replay()) send(e)
          unsubscribe = subscribe((e) => {
            try {
              send(e)
            } catch {
              unsubscribe()
            }
          })
        },
        cancel() {
          unsubscribe()
        },
      })
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS },
      })
    }

    if (pathname === '/health') {
      return Response.json(
        {
          ok: true,
          pool: config.pool.map((m) => ({ id: m.id, model: m.model, available: !!m.available })),
        },
        { headers: CORS },
      )
    }

    if (pathname === '/v1/models') {
      return Response.json(
        {
          object: 'list',
          data: VIRTUAL_MODELS.map((id) => ({ id, object: 'model', owned_by: 'local-fugu' })),
        },
        { headers: CORS },
      )
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      try {
        return await handleChat(req)
      } catch (e) {
        const msg = (e as Error).message
        console.error(`[fugu] error: ${msg}`)
        return Response.json({ error: { message: msg, type: 'fugu_error' } }, { status: 500 })
      }
    }

    return new Response('not found', { status: 404 })
  },
})

log({
  listening: `http://localhost:${server.port}/v1`,
  console: `http://localhost:${server.port}/`,
  pool: proposers()
    .map((m) => m.id)
    .join(','),
  primary: config.primary,
  aggregator: config.aggregator,
})
