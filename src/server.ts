import { join } from 'node:path'
import pkg from '../package.json'
import { emit, newTurn, replay, subscribe } from './bus.ts'
import { catalog, load, unload } from './catalog.ts'
import { config, member, probe, proposers, setPool } from './config.ts'
import { consensus, debate, judge, propose, synthesisRequest, turnTimeoutMs, verifiedSelect } from './fuse.ts'
import { modeOf, route } from './router.ts'
import { jsonFromMessage, sseKeepAlive, type Turn } from './sse.ts'
import { complete, stream, type ChatRequest, type Message } from './upstream.ts'
import { verifyConfig } from './verify.ts'

await probe()

const VIRTUAL_MODELS = ['magi-auto', 'magi-moa', 'magi-fast']

const log = (parts: Record<string, unknown>) =>
  console.log(
    '[magi] ' +
      Object.entries(parts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  )

const nodes = () =>
  config.pool
    .filter((m) => m.available)
    .map((m) => ({
      id: m.id,
      label: m.label ?? m.id.toUpperCase(),
      model: m.model,
      context: m.contextLength,
    }))

/** Last thing the user actually asked, for the console's 提訴 panel. */
const petition = (messages: Message[]): string => {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  const text = typeof last?.content === 'string' ? last.content : ''
  return text.replace(/\s+/g, ' ').slice(0, 240)
}

async function runTurn(body: ChatRequest, req: Request, wantsStream: boolean): Promise<Turn> {
  const virtual = body.model

  const mode = modeOf(virtual)
  const decision = route(body, mode)
  const started = Date.now()
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

  // propose() reports its own failures per seat; these are for the calls made
  // directly — primary and aggregator — which used to fail invisibly, leaving
  // the console deliberating forever.
  const fail = (id: string, e: Error) => {
    emit({ type: 'node', turn, id, state: 'error', note: e.message.slice(0, 80) })
    emit({ type: 'decision', turn, mode: 'error', winner: id, ms: Date.now() - started })
  }

  const single = async (
    m: ReturnType<typeof member>,
    request: ChatRequest,
    label: string,
  ): Promise<Turn> => {
    emit({ type: 'node', turn, id: m.id, state: 'thinking' })
    const settle = () => {
      emit({ type: 'node', turn, id: m.id, state: 'winner' })
      emit({ type: 'decision', turn, mode: label, winner: m.id, ms: Date.now() - started })
    }
    try {
      if (wantsStream) {
        return { pipe: await stream(m, request, { signal: req.signal }), onEnd: settle }
      }
      const { message, finish_reason } = await complete(m, request, {
        signal: req.signal,
        timeoutMs: turnTimeoutMs(request),
      })
      settle()
      return { message, finish: finish_reason }
    } catch (e) {
      fail(m.id, e as Error)
      throw e
    }
  }

  if (decision.kind === 'passthrough') {
    const m = member(config.primary)
    log({ route: 'passthrough', why: `"${decision.reason}"`, model: m.id })
    return single(m, base, 'passthrough')
  }

  if (decision.kind === 'speculative') {
    const m = member(config.primary)
    emit({ type: 'node', turn, id: m.id, state: 'thinking' })
    let first
    try {
      first = await complete(m, base, { signal: req.signal, timeoutMs: turnTimeoutMs(base) })
    } catch (e) {
      fail(m.id, e as Error)
      throw e
    }
    const call = first.message.tool_calls?.[0]
    const isEdit = !!call && (verifyConfig()?.editTools.includes(call.function.name) ?? false)
    emit({
      type: 'node',
      turn,
      id: m.id,
      state: 'answered',
      ms: Date.now() - started,
      tokens: first.tokens,
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
      return { message: first.message, finish: first.finish_reason }
    }

    // An edit is on the table, so it is worth paying for rivals to score against.
    const rivals = await propose(base, { signal: req.signal, exclude: [m.id], turn })
    const candidates = [
      { member: m, message: first.message, finish_reason: first.finish_reason, ms: 0 },
      ...rivals.filter((r) => (r.message.tool_calls?.length ?? 0) > 0),
    ]
    const verified = await verifiedSelect(candidates, turn).catch((e) => {
      console.warn(`[magi] verify failed: ${(e as Error).message}`)
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

    return { message: winner.message, finish: winner.finish_reason || 'tool_calls' }
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
      console.warn(`[magi] verify failed: ${(e as Error).message}`)
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

    return { message: winner.message, finish: winner.finish_reason || 'tool_calls' }
  }

  // Text turn: nothing here can be scored, so this is where debate earns its
  // keep — the models read each other before anything is synthesized.
  let finalDrafts = drafts
  const dcfg = config.debate
  if (dcfg?.enabled && drafts.length >= 2) {
    for (let round = 1; round <= dcfg.rounds; round++) {
      finalDrafts = await debate(base, finalDrafts, { signal: req.signal, turn, round })
      log({ route: 'fanout', debate: `round ${round}`, participants: finalDrafts.length })
    }
  }

  const agg = member(config.aggregator)
  const synth = synthesisRequest(base, finalDrafts)
  log({
    route: 'fanout',
    mode: 'synthesize',
    proposers: `${drafts.length}/${proposers().length}`,
    aggregator: agg.id,
    fanoutMs: Date.now() - started,
  })
  emit({ type: 'node', turn, id: agg.id, state: 'thinking' })

  const finish = () => {
    announce(turn, [...finalDrafts.map((d) => d.member.id), agg.id], agg.id, 'contributed')
    emit({
      type: 'decision',
      turn,
      mode: 'synthesize',
      winner: agg.id,
      ms: Date.now() - started,
    })
  }

  try {
    if (wantsStream) {
      return { pipe: await stream(agg, synth, { signal: req.signal }), onEnd: finish }
    }
    const { message, finish_reason } = await complete(agg, synth, {
      signal: req.signal,
      timeoutMs: turnTimeoutMs(synth),
    })
    finish()
    return { message, finish: finish_reason }
  } catch (e) {
    fail(agg.id, e as Error)
    throw e
  }
}

/**
 * HTTP wrapper. Streaming clients get the connection opened immediately and
 * held with heartbeats, because the pool can take minutes to answer.
 */
async function handleChat(req: Request): Promise<Response> {
  const body = (await req.json()) as ChatRequest
  if (process.env.MAGI_DUMP) await Bun.write(process.env.MAGI_DUMP, JSON.stringify(body, null, 2))

  const wantsStream = body.stream !== false
  if (wantsStream) return sseKeepAlive(body.model, () => runTurn(body, req, true))

  const turn = await runTurn(body, req, false)
  if ('pipe' in turn) throw new Error('unreachable: piped upstream for a non-streaming client')
  return jsonFromMessage(turn.message, turn.finish, body.model)
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
  // Never tear a connection down for being quiet — a fan-out with a debate
  // round legitimately sends nothing for minutes. The SSE heartbeats stay
  // anyway: they are what lets a console notice a dead link, and what keeps
  // client-side read timeouts from giving up on us.
  idleTimeout: 0,
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
          // A quiet gateway outlasts Bun's 255 s idle cap, and a feed with
          // nothing to say was being torn down as idle. Comment lines are
          // ignored by every SSE client and keep the connection warm.
          const beat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': hb\n\n'))
            } catch {
              unsubscribe()
            }
          }, 15000)
          const stop = subscribe((e) => {
            try {
              send(e)
            } catch {
              unsubscribe()
            }
          })
          unsubscribe = () => {
            clearInterval(beat)
            stop()
          }
        },
        cancel() {
          unsubscribe()
        },
      })
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS },
      })
    }

    if (pathname === '/api/models') {
      const entries = await catalog()
      return Response.json(
        {
          models: entries.map((e) => ({
            ...e,
            inPool: config.pool.some((m) => m.model === e.model && m.upstream === e.upstream),
          })),
          pool: config.pool.map((m) => ({
            id: m.id,
            label: m.label,
            model: m.model,
            upstream: m.upstream,
            roles: m.roles,
            available: !!m.available,
          })),
          primary: config.primary,
          aggregator: config.aggregator,
          contextLength: config.lmsContextLength ?? 65536,
        },
        { headers: CORS },
      )
    }

    if (pathname === '/api/pool' && req.method === 'POST') {
      try {
        const body = (await req.json()) as {
          members: { upstream: string; model: string; contextLength?: number }[]
          primary?: string
          aggregator?: string
          load?: boolean
        }

        // Anything picked but not resident has to be loaded first, or probe()
        // will simply drop it — and a member whose requested context differs
        // from the resident one has to be cycled, since LM Studio fixes the
        // context at load time.
        const warnings: string[] = []
        if (body.load !== false) {
          const resident = new Map(
            (await catalog()).filter((e) => e.state === 'loaded').map((e) => [e.model, e]),
          )
          for (const m of body.members) {
            const want = m.contextLength ?? config.lmsContextLength ?? 65536
            const have = resident.get(m.model)
            if (have && have.loadedContext === want) continue
            try {
              if (have) {
                log({ reloading: m.model, from: have.loadedContext ?? '?', to: want })
                await unload(m.model)
              } else {
                log({ loading: m.model, context: want })
              }
              await load(m.model, want)
            } catch (e) {
              warnings.push((e as Error).message)
            }
          }
        }

        await setPool(body.members, body.primary, body.aggregator)
        emit({ type: 'hello', nodes: nodes() })
        log({ pool: config.pool.map((m) => m.id).join(','), primary: config.primary })

        return Response.json(
          {
            ok: true,
            warnings,
            pool: config.pool.map((m) => ({ id: m.id, model: m.model, available: !!m.available })),
          },
          { headers: CORS },
        )
      } catch (e) {
        return Response.json(
          { ok: false, error: (e as Error).message },
          { status: 400, headers: CORS },
        )
      }
    }

    if (pathname === '/health') {
      return Response.json(
        {
          ok: true,
          version: pkg.version,
          pool: config.pool.map((m) => ({ id: m.id, model: m.model, available: !!m.available })),
        },
        { headers: CORS },
      )
    }

    if (pathname === '/v1/models') {
      return Response.json(
        {
          object: 'list',
          data: VIRTUAL_MODELS.map((id) => ({ id, object: 'model', owned_by: 'magi' })),
        },
        { headers: CORS },
      )
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      try {
        return await handleChat(req)
      } catch (e) {
        const msg = (e as Error).message
        console.error(`[magi] error: ${msg}`)
        return Response.json({ error: { message: msg, type: 'magi_error' } }, { status: 500 })
      }
    }

    return new Response('not found', { status: 404 })
  },
})

log({
  version: pkg.version,
  listening: `http://localhost:${server.port}/v1`,
  console: `http://localhost:${server.port}/`,
  pool: proposers()
    .map((m) => m.id)
    .join(','),
  primary: config.primary,
  aggregator: config.aggregator,
})
