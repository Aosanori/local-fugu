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
}

export type Config = {
  listen: number
  upstreams: Record<string, Upstream>
  pool: PoolMember[]
  primary: string
  aggregator: string
  router: {
    trivialChars: number
    fanoutOnContinuation: boolean
    speculativeEdit: boolean
    proposerMaxTokens: number
    /** extra tokens so a reasoning model can think and still answer */
    reasoningHeadroom: number
    proposerTimeoutMs: number
    minProposers: number
  }
}

const path = process.env.FUGU_CONFIG ?? new URL('../config.json', import.meta.url).pathname

export const config: Config = JSON.parse(await Bun.file(path).text())

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

  for (const [name, u] of Object.entries(config.upstreams)) {
    configure(name, u.maxConcurrency ?? 1)
    try {
      const res = await fetch(`${u.baseURL}/models`, {
        headers: u.apiKey ? { Authorization: `Bearer ${u.apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      })
      const body = (await res.json()) as { data?: { id: string }[] }
      loaded.set(name, new Set((body.data ?? []).map((d) => d.id)))
    } catch (e) {
      loaded.set(name, new Set())
      console.warn(`[fugu] upstream ${name} unreachable: ${(e as Error).message}`)
    }
  }

  for (const m of config.pool) {
    if (m.enabled === false) {
      m.available = false
      continue
    }
    m.available = loaded.get(m.upstream)?.has(m.model) ?? false
    if (!m.available && !m.optional) {
      throw new Error(`required pool member ${m.id} (${m.model}) is not loaded on ${m.upstream}`)
    }
  }
}
