import { configure } from './limiter.ts'

export type Upstream = { baseURL: string; apiKey?: string; maxConcurrency?: number }

export type PoolMember = {
  id: string
  upstream: string
  model: string
  roles: string[]
  /** name shown on the MAGI console */
  label?: string
  optional?: boolean
  /** set false to keep a member in the config but out of the pool */
  enabled?: boolean
  /** filled in at boot by probe() */
  available?: boolean
  /** context the runtime actually loaded this model with, for usage display */
  contextLength?: number
}

export type Config = {
  listen: number
  upstreams: Record<string, Upstream>
  pool: PoolMember[]
  primary: string
  aggregator: string
  /** context length used when the gateway loads a model into LM Studio */
  lmsContextLength?: number
  debate?: {
    /** auto: the conversation's owner decides per turn; always / off */
    mode?: 'auto' | 'always' | 'off'
    /** legacy switch, honoured when mode is absent */
    enabled?: boolean
    maxRounds?: number
    /** legacy name for maxRounds */
    rounds?: number
    maxPeerChars: number
    /** stop early once every debater's revision is at least this similar (0-1) */
    convergence?: number
  }
  router: {
    trivialChars: number
    fanoutOnContinuation: boolean
    speculativeEdit: boolean
    proposerMaxTokens: number
    /** extra tokens so a reasoning model can think and still answer */
    reasoningHeadroom: number
    proposerTimeoutMs: number
    /** extra timeout per prompt character, so long contexts get longer ceilings */
    timeoutPerCharMs?: number
    /** 'sticky' spreads conversations across the pool; 'off' pins config.primary */
    balance?: 'sticky' | 'off'
    minProposers: number
  }
}

export const configPath = process.env.MAGI_CONFIG ?? new URL('../config.json', import.meta.url).pathname

export const config: Config = JSON.parse(await Bun.file(configPath).text())

/** MAGI seats, in the order members are added. */
const SEATS = ['MELCHIOR·1', 'BALTHASAR·2', 'CASPER·3']

const slug = (model: string) =>
  (model.split('/').pop() ?? model).replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase()

/**
 * Replace the pool with an explicit selection and persist it. Ids and MAGI
 * seats are derived here so a caller only has to name models.
 */
export async function setPool(
  selection: { upstream: string; model: string; contextLength?: number }[],
  primaryModel?: string,
  aggregatorModel?: string,
): Promise<void> {
  if (selection.length === 0) throw new Error('pool cannot be empty')

  const used = new Set<string>()
  const pool: PoolMember[] = selection.map((s, i) => {
    let id = slug(s.model)
    while (used.has(id)) id += `-${i}`
    used.add(id)
    return {
      id,
      upstream: s.upstream,
      model: s.model,
      roles: ['proposer'],
      label: SEATS[i] ?? `NODE·${i + 1}`,
      ...(s.contextLength ? { contextLength: s.contextLength } : {}),
    }
  })

  const pick = (model: string | undefined) =>
    pool.find((m) => m.model === model) ?? pool[0]

  const primary = pick(primaryModel)
  const aggregator = pick(aggregatorModel)
  primary.roles.push('primary')
  if (!aggregator.roles.includes('aggregator')) aggregator.roles.push('aggregator')

  config.pool = pool
  config.primary = primary.id
  config.aggregator = aggregator.id

  await save()
  await probe()
}

/** Write the config back out without the fields probe() fills in at runtime. */
async function save(): Promise<void> {
  const clean = {
    ...config,
    pool: config.pool.map(({ available, ...rest }) => rest),
  }
  await Bun.write(configPath, JSON.stringify(clean, null, 2) + '\n')
}

export const member = (id: string): PoolMember => {
  const m = config.pool.find((p) => p.id === id)
  if (!m) throw new Error(`pool member not found: ${id}`)
  return m
}

export const upstreamOf = (m: PoolMember): Upstream => {
  const u = config.upstreams[m.upstream]
  if (!u) throw new Error(`upstream not found: ${m.upstream}`)
  return u
}

export const proposers = (): PoolMember[] =>
  config.pool.filter((m) => m.available && m.roles.includes('proposer'))

/**
 * Ask each upstream which models it actually has loaded, and mark pool members
 * accordingly. Optional members that are missing are dropped silently; required
 * members that are missing abort the boot, because a 3-model pool that has
 * quietly become a 1-model pool is worse than a hard error.
 */
export async function probe(): Promise<void> {
  const loaded = new Map<string, Set<string>>()
  const contexts = new Map<string, number>()

  for (const [name, u] of Object.entries(config.upstreams)) {
    configure(name, u.maxConcurrency ?? 1)

    // LM Studio also reports the context each model was loaded with, which is
    // what a usage read-out has to be measured against.
    try {
      const res = await fetch(u.baseURL.replace(/\/v1\/?$/, '/api/v0/models'), {
        headers: u.apiKey ? { Authorization: `Bearer ${u.apiKey}` } : {},
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) {
        const body = (await res.json()) as {
          data?: { id: string; loaded_context_length?: number; max_context_length?: number }[]
        }
        for (const m of body.data ?? []) {
          const ctx = m.loaded_context_length ?? m.max_context_length
          if (ctx) contexts.set(`${name}/${m.id}`, ctx)
        }
      }
    } catch {
      // upstream has no native catalog; usage is then shown without a ceiling
    }

    try {
      const res = await fetch(`${u.baseURL}/models`, {
        headers: u.apiKey ? { Authorization: `Bearer ${u.apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      })
      const body = (await res.json()) as { data?: { id: string }[] }
      loaded.set(name, new Set((body.data ?? []).map((d) => d.id)))
    } catch (e) {
      loaded.set(name, new Set())
      console.warn(`[magi] upstream ${name} unreachable: ${(e as Error).message}`)
    }
  }

  for (const m of config.pool) {
    if (m.enabled === false) {
      m.available = false
      continue
    }
    m.available = loaded.get(m.upstream)?.has(m.model) ?? false
    m.contextLength = contexts.get(`${m.upstream}/${m.model}`)
    if (!m.available && !m.optional) {
      throw new Error(`required pool member ${m.id} (${m.model}) is not loaded on ${m.upstream}`)
    }
  }
}
