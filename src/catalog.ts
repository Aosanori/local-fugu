import { config, type Upstream } from './config.ts'

export type CatalogEntry = {
  upstream: string
  model: string
  state: 'loaded' | 'not-loaded'
  type: string
  arch?: string
  maxContext?: number
}

const headers = (u: Upstream) => (u.apiKey ? { Authorization: `Bearer ${u.apiKey}` } : {})

/**
 * What each runtime has to offer. LM Studio's native API reports downloaded
 * models and whether they are resident; the OpenAI route only lists what is
 * already loaded, so that is the fallback.
 */
export async function catalog(): Promise<CatalogEntry[]> {
  const all: CatalogEntry[] = []

  for (const [name, u] of Object.entries(config.upstreams)) {
    const native = u.baseURL.replace(/\/v1\/?$/, '/api/v0/models')
    try {
      const res = await fetch(native, { headers: headers(u), signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const body = (await res.json()) as {
          data?: { id: string; type?: string; state?: string; arch?: string; max_context_length?: number }[]
        }
        for (const m of body.data ?? []) {
          all.push({
            upstream: name,
            model: m.id,
            state: m.state === 'loaded' ? 'loaded' : 'not-loaded',
            type: m.type ?? 'llm',
            arch: m.arch,
            maxContext: m.max_context_length,
          })
        }
        continue
      }
    } catch {
      // not an LM Studio upstream, or it is down — fall through
    }

    try {
      const res = await fetch(`${u.baseURL}/models`, {
        headers: headers(u),
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) continue
      const body = (await res.json()) as { data?: { id: string }[] }
      for (const m of body.data ?? []) {
        all.push({ upstream: name, model: m.id, state: 'loaded', type: 'llm' })
      }
    } catch {
      // upstream unreachable; it simply contributes nothing
    }
  }

  // Embedding models can never be pool members.
  return all.filter((m) => m.type !== 'embeddings')
}

/**
 * Ask LM Studio to make a model resident, with an explicit context and no TTL.
 * Leaving those to LM Studio's defaults is what caused reloads to be refused
 * mid-fan-out — see the gotchas in the README.
 */
export async function load(model: string, contextLength: number): Promise<void> {
  const lms = `${process.env.HOME}/.lmstudio/bin/lms`
  const proc = Bun.spawn(
    [lms, 'load', model, '--context-length', String(contextLength), '--gpu', 'max', '-y'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const timer = setTimeout(() => proc.kill(), 300000)
  const err = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  clearTimeout(timer)
  if (exitCode !== 0) throw new Error(`lms load ${model} failed: ${err.trim().slice(-200)}`)
}
