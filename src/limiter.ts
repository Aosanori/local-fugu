/**
 * Per-upstream concurrency gate.
 *
 * A single LM Studio instance cannot actually serve two loaded models at once
 * (the second request dies with "Engine protocol predict request failed"), so
 * fan-out has to be serialized within an upstream. Real parallelism comes from
 * having more than one upstream process — that is what the pool config is for.
 */
const queues = new Map<string, { active: number; limit: number; waiting: (() => void)[] }>()

export function configure(name: string, limit: number): void {
  queues.set(name, { active: 0, limit, waiting: [] })
}

export async function acquire(name: string): Promise<() => void> {
  const q = queues.get(name)
  if (!q) return () => {}

  if (q.active >= q.limit) await new Promise<void>((resolve) => q.waiting.push(resolve))
  q.active++

  let released = false
  return () => {
    if (released) return
    released = true
    q.active--
    q.waiting.shift()?.()
  }
}
