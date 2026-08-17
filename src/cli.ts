#!/usr/bin/env bun
/**
 * One entry point for both halves: the gateway and the console that watches it.
 *
 *   magi          # console, starting the gateway too if nothing answers yet
 *   magi serve    # gateway only, no console
 *   magi console  # console only, never starts anything
 */
const HELP = `magi — multi-model orchestrator for coding agents

  magi              open the console, starting the gateway if it is not running
  magi serve        run the gateway alone (for a service or another terminal)
  magi console      attach to a running gateway, start nothing
  magi --help       this

env:
  MAGI_CONFIG       path to config.json
  MAGI_URL          gateway to follow (default http://localhost:4141)
`

const url = process.env.MAGI_URL ?? 'http://localhost:4141'

const alreadyServing = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

const cmd = process.argv[2]

if (cmd === 'serve') {
  await import('./server.ts')
} else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP)
} else if (cmd && cmd !== 'console') {
  console.error(`magi: unknown command "${cmd}"\n`)
  console.error(HELP)
  process.exit(1)
} else {
  const running = await alreadyServing()
  const view = await import('./console.ts')

  if (!running && cmd !== 'console') {
    // The gateway shares this process, so its logging has to go to the
    // console's feed rather than to a stdout the console is redrawing.
    const relay = (...parts: unknown[]) => view.pushLog(parts.map(String).join(' '))
    console.log = relay
    console.warn = relay
    console.error = relay

    try {
      await import('./server.ts')
    } catch (e) {
      view.restore()
      process.stdout.write(`magi: could not start the gateway — ${(e as Error).message}\n`)
      process.exit(1)
    }
  }
}
