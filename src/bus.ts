/** Live event feed for the MAGI console. Fire-and-forget: no subscriber, no cost. */
export type Event =
  | { type: 'hello'; nodes: { id: string; label: string; model: string }[] }
  | { type: 'turn'; turn: string; route: string; reason: string; prompt: string; tools: number }
  | { type: 'node'; turn: string; id: string; state: NodeState; note?: string; ms?: number }
  | {
      type: 'verify'
      turn: string
      baseline: number
      best: number
      regression: boolean
      scores: { id: string; total: number; detail: string }[]
    }
  | { type: 'debate'; turn: string; round: number; participants: string[] }
  | { type: 'decision'; turn: string; mode: string; winner?: string; call?: string; ms: number }

export type NodeState =
  | 'idle'
  | 'thinking'
  /** reading the other models' answers and revising its own */
  | 'debating'
  | 'answered'
  | 'winner'
  /** its draft fed the synthesis rather than being returned outright */
  | 'contributed'
  | 'rejected'
  | 'error'

const subscribers = new Set<(e: Event) => void>()
const history: Event[] = []

export function subscribe(fn: (e: Event) => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function emit(e: Event): void {
  history.push(e)
  if (history.length > 200) history.shift()
  for (const fn of subscribers) {
    try {
      fn(e)
    } catch {
      // a dead console must never break a request
    }
  }
}

export const replay = (): Event[] => history.slice(-40)

export const newTurn = () => Math.random().toString(36).slice(2, 8)
