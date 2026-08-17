#!/usr/bin/env bun
/**
 * MAGI console for the terminal. Same event feed as the web console.
 *
 *   ./scripts/magi.ts            # follows http://localhost:4141
 *   MAGI_URL=... ./scripts/magi.ts
 */
const BASE = process.env.MAGI_URL ?? 'http://localhost:4141'

const rgb = (r: number, g: number, b: number, bg = false) => `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const ORANGE = rgb(224, 123, 31)
const ORANGE_HOT = rgb(255, 165, 58)
const TEAL = rgb(76, 143, 125)
const GREY = rgb(120, 120, 120)
const DIMTEXT = rgb(90, 90, 90)

type NodeState =
  | 'idle'
  | 'thinking'
  | 'debating'
  | 'answered'
  | 'winner'
  | 'rejected'
  | 'contributed'
  | 'error'

type Rgb = [number, number, number]
const SKIN: Record<NodeState, { bg: Rgb; fg: Rgb; verdict: string }> = {
  idle: { bg: [38, 50, 66], fg: [150, 168, 190], verdict: '' },
  thinking: { bg: [91, 127, 166], fg: [10, 10, 10], verdict: '審議中' },
  debating: { bg: [122, 152, 186], fg: [10, 10, 10], verdict: '討議中' },
  answered: { bg: [91, 127, 166], fg: [10, 10, 10], verdict: '回答' },
  winner: { bg: [217, 131, 36], fg: [16, 12, 5], verdict: '可決' },
  contributed: { bg: [60, 84, 110], fg: [200, 214, 230], verdict: '参考' },
  rejected: { bg: [38, 49, 65], fg: [111, 130, 150], verdict: '否決' },
  error: { bg: [201, 67, 47], fg: [21, 4, 4], verdict: 'ERROR' },
}

const paint = (c: Rgb, bg = false) => rgb(c[0], c[1], c[2], bg)

type Node = {
  id: string
  label: string
  model: string
  state: NodeState
  note: string
  /** context the model was loaded with, and what it just used */
  context?: number
  tokens?: number
}

const state = {
  nodes: [] as Node[],
  code: '----',
  route: '-',
  prompt: '',
  busy: false,
  since: 0,
  decision: '-',
  baseline: '-' as string | number,
  best: '-' as string | number,
  elapsed: '-',
  debating: null as string[] | null,
  log: [] as string[],
}

/** East Asian wide characters occupy two cells; padding has to know that. */
const width = (s: string) =>
  [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)

const clip = (s: string, max: number) => {
  let out = ''
  for (const ch of s) {
    if (width(out + ch) > max) break
    out += ch
  }
  return out
}

const center = (s: string, w: number) => {
  const text = clip(s, w)
  const pad = w - width(text)
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + text + ' '.repeat(pad - left)
}

const pad = (s: string, w: number) => {
  const text = clip(s, w)
  return text + ' '.repeat(Math.max(0, w - width(text)))
}

/**
 * One MAGI panel, chamfered only on the edges that face the hub — the top seat
 * narrows towards the bottom, the bottom seats are cut back at the top corner
 * nearest the centre.
 *
 * A terminal cell cannot be half-filled, so each step of the chamfer would read
 * as a staircase; the corner glyphs (◥◤◢◣) are drawn in the panel's own colour
 * to fill the diagonal half of the boundary cell and soften it.
 *
 * Text handed to center() must stay free of escape sequences — the width
 * calculation counts characters, so an embedded colour code gets measured as
 * content and the row is truncated mid-escape.
 */
function panel(node: Node | undefined, w: number, shape: 'top' | 'left' | 'right'): string[] {
  const skin = SKIN[node?.state ?? 'idle']
  const bg = paint(skin.bg, true)
  const fg = paint(skin.fg)
  const edge = paint(skin.bg) // panel colour as ink, for the corner glyphs
  const step = Math.max(2, Math.round(w * 0.07))

  // Content lives below the chamfer, so a label never lands in the cut corner.
  const content: { text: string; bold?: boolean }[] = [
    { text: node?.label ?? '—', bold: true },
    { text: node?.model ?? '' },
    { text: skin.verdict, bold: true },
    { text: node?.note ?? '' },
    { text: usage(node) },
  ]
  const rows =
    shape === 'top' ? [{ text: '' }, ...content, { text: '' }] : [{ text: '' }, { text: '' }, ...content]

  // [left inset, right inset] per row, mirroring the web console's clip-paths.
  const insets: [number, number][] =
    shape === 'top'
      ? [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
          [step, step],
          [step * 2, step * 2],
        ]
      : shape === 'left'
        ? [
            [0, step * 2],
            [0, step],
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
          ]
        : [
            [step * 2, 0],
            [step, 0],
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
          ]

  return rows.map((row, i) => {
    const [l, r] = insets[i]
    const body = bg + fg + (row.bold ? BOLD : '') + center(row.text, w - l - r) + RESET
    return ' '.repeat(l) + body + ' '.repeat(r)
  })
}

const short = (n: number) => (n >= 1024 ? `${+(n / 1024).toFixed(1)}k` : String(n))

const usage = (node?: Node): string => {
  if (!node?.tokens) return ''
  if (!node.context) return `${short(node.tokens)} tok`
  const pct = Math.round((node.tokens / node.context) * 100)
  const filled = Math.min(10, Math.round((node.tokens / node.context) * 10))
  return `${short(node.tokens)}/${short(node.context)} ${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${pct}%`
}

const PREFERRED: Record<string, number> = { BALTHASAR: 0, CASPER: 1, MELCHIOR: 2 }

function placed(): (Node | undefined)[] {
  const slots: (Node | undefined)[] = [undefined, undefined, undefined]
  const spill: Node[] = []
  for (const n of state.nodes) {
    const slot = PREFERRED[n.label.split('·')[0].toUpperCase()]
    if (slot !== undefined && !slots[slot]) slots[slot] = n
    else spill.push(n)
  }
  for (const n of spill) {
    const free = slots.indexOf(undefined)
    if (free === -1) break
    slots[free] = n
  }
  return slots
}

function render() {
  const cols = Math.max(64, Math.min(process.stdout.columns ?? 100, 120))
  const out: string[] = []
  const rule = (label: string) => ORANGE + BOLD + label + RESET + TEAL + '─'.repeat(Math.max(0, Math.floor(cols / 2) - width(label) - 2)) + RESET

  out.push(`${rgb(185, 185, 185, true)}${rgb(17, 17, 17)} FRONT ${RESET} ${DIMTEXT}OPENAI-COMPATIBLE ENDPOINT ${ORANGE}${BASE}/v1${RESET}`)
  out.push('')
  out.push(rule('提訴 ') + ' ' + rule('決議 '))
  out.push('')

  const status = state.busy ? `${ORANGE}┤ 審議中 ├${RESET}` : `${DIMTEXT}┤ 待機中 ├${RESET}`
  out.push(`${ORANGE}CODE : ${BOLD}${state.code}${RESET}${' '.repeat(Math.max(1, cols - 20 - width(state.code)))}${status}`)
  out.push(`${DIMTEXT}FILE:MAGI.SYS  ROUTE:${state.route}  PRIORITY:AAA${RESET}`)
  out.push('')
  out.push(`${GREY}${pad(state.prompt || '— 提訴なし —', cols)}${RESET}`)
  out.push('')

  const slots = placed()
  const topW = Math.floor(cols * 0.42)
  const sideW = Math.floor(cols * 0.44)
  const gap = cols - sideW * 2

  for (const line of panel(slots[0], topW, 'top')) {
    out.push(' '.repeat(Math.floor((cols - topW) / 2)) + line)
  }
  // Debate links sit in the gaps between frames, and only between the seats
  // that are actually talking — a proposer that dropped out is not linked.
  const talking = new Set(state.debating ?? [])
  const linked = (a: number, b: number) =>
    !!slots[a] && !!slots[b] && talking.has(slots[a]!.id) && talking.has(slots[b]!.id)

  const hub = Array.from({ length: cols }, () => ' ')
  const put = (text: string, at: number) => [...text].forEach((ch, i) => (hub[at + i] = ch))
  put('M A G I', Math.floor((cols - 7) / 2))
  if (linked(0, 1)) put('╱', Math.floor(cols / 2) - 13)
  if (linked(0, 2)) put('╲', Math.floor(cols / 2) + 13)
  out.push(ORANGE + BOLD + hub.join('').trimEnd() + RESET)

  const left = panel(slots[1], sideW, 'left')
  const right = panel(slots[2], sideW, 'right')
  const bridge = linked(1, 2) && gap >= 5
  for (let i = 0; i < left.length; i++) {
    const spacer =
      bridge && i === 4
        ? ORANGE + '─'.repeat(Math.floor((gap - 1) / 2)) + '⇄' + '─'.repeat(Math.ceil((gap - 1) / 2)) + RESET
        : ' '.repeat(Math.max(0, gap))
    out.push(left[i] + spacer + right[i])
  }

  out.push('')
  out.push(`${DIMTEXT}DECISION ${RESET}${state.decision}   ${DIMTEXT}BASELINE ${RESET}${state.baseline}   ${DIMTEXT}BEST ${RESET}${state.best}   ${DIMTEXT}ELAPSED ${RESET}${state.elapsed}`)
  out.push(TEAL + '─'.repeat(cols) + RESET)
  for (const line of state.log.slice(0, 6)) out.push(DIMTEXT + clip(line, cols) + RESET)

  process.stdout.write('\x1b[H' + out.map((l) => l + '\x1b[K').join('\n') + '\x1b[J')
}

const node = (id: string) => state.nodes.find((n) => n.id === id)

function handle(e: any) {
  if (e.type === 'hello') {
    state.nodes = e.nodes.map((n: any) => ({ ...n, state: 'idle' as NodeState, note: '' }))
  } else if (e.type === 'turn') {
    state.code = e.turn.toUpperCase()
    state.route = e.route.toUpperCase()
    state.prompt = e.prompt || '— 継続審議 —'
    state.busy = true
    state.since = Date.now()
    state.debating = null
    state.decision = '-'
    state.baseline = '-'
    state.best = '-'
    for (const n of state.nodes) {
      n.state = 'idle'
      n.note = ''
      n.tokens = undefined
    }
    state.log.unshift(`${e.turn} ${e.route} — ${e.reason}`)
  } else if (e.type === 'node') {
    const n = node(e.id)
    if (n) {
      n.state = e.state
      if (e.note) n.note = e.note + (e.ms ? ` · ${(e.ms / 1000).toFixed(1)}s` : '')
      if (e.tokens) n.tokens = e.tokens
    }
  } else if (e.type === 'debate') {
    state.debating = e.participants
    state.decision = `討議 round ${e.round}`
    state.log.unshift(`${e.turn} debate round ${e.round} — ${e.participants.join(' ⇄ ')}`)
  } else if (e.type === 'verify') {
    state.baseline = e.baseline
    state.best = `${e.best}${e.regression ? ' REGRESSION' : ''}`
    for (const s of e.scores) {
      const n = node(s.id)
      if (n) n.note = `${s.total} · ${s.detail}`
    }
    state.log.unshift(`verify baseline=${e.baseline} best=${e.best}`)
  } else if (e.type === 'decision') {
    state.busy = false
    state.debating = null
    // Anyone still lit when the verdict lands did not make it into the
    // decision — a slow proposer, or one whose draft carried no tool call.
    // When the turn itself died, the lit seats died with it: settle them red.
    const settleAs: NodeState = e.mode === 'error' ? 'error' : 'rejected'
    for (const n of state.nodes) {
      if (n.state === 'thinking' || n.state === 'answered' || n.state === 'debating') {
        n.state = settleAs
      }
    }
    state.decision = `${e.mode} → ${e.winner ?? '-'}${e.call ? ' / ' + e.call : ''}`
    state.elapsed = `${(e.ms / 1000).toFixed(1)}s`
    state.log.unshift(`${e.turn} ${e.mode} winner=${e.winner ?? '-'} ${(e.ms / 1000).toFixed(1)}s`)
  }
  state.log = state.log.slice(0, 20)
  render()
}

async function follow() {
  // `magi` starts the console before the gateway it hosts is listening, so the
  // first attempt is expected to fail — only report losing a feed we had.
  let everConnected = false

  for (;;) {
    try {
      const res = await fetch(`${BASE}/events`)
      everConnected = true
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '))
          if (line) handle(JSON.parse(line.slice(6)))
        }
      }
    } catch {
      if (everConnected) {
        state.log.unshift(`disconnected — retrying`)
        render()
      }
    }
    await new Promise((r) => setTimeout(r, everConnected ? 2000 : 400))
  }
}

process.stdout.write('\x1b[?25l\x1b[2J')
const ticker = setInterval(() => {
  if (state.busy) state.elapsed = `${((Date.now() - state.since) / 1000).toFixed(1)}s`
  render()
}, 200)

const bye = () => {
  clearInterval(ticker)
  process.stdout.write('\x1b[?25h\n')
  process.exit(0)
}
process.on('SIGINT', bye)
process.on('SIGTERM', bye)

/**
 * Somewhere for a co-hosted gateway to put its output. Writing to stdout would
 * land in the middle of a full-screen redraw and shred the frame, so its log
 * lines are folded into the console's own feed instead.
 */
export function pushLog(line: string): void {
  state.log.unshift(line.replace(/\s+/g, ' ').trim())
  state.log = state.log.slice(0, 20)
  render()
}

/** Put the terminal back the way it was found. */
export function restore(): void {
  clearInterval(ticker)
  process.stdout.write('\x1b[?25h\n')
}

render()
// Deliberately not awaited: `magi` imports this and then starts the gateway in
// the same process, so the module has to finish loading.
void follow()
