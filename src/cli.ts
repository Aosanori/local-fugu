#!/usr/bin/env bun
/**
 * One entry point for both halves: the gateway and the console that watches it.
 *
 *   magi          # MAGI console
 *   magi serve    # OpenAI-compatible gateway
 */
const HELP = `magi — multi-model orchestrator for coding agents

  magi              open the MAGI console (follows MAGI_URL, default :4141)
  magi serve        run the gateway on the port in config.json
  magi --help       this

env:
  MAGI_CONFIG       path to config.json
  MAGI_URL          gateway the console should follow
`

const cmd = process.argv[2]

if (cmd === 'serve') {
  await import('./server.ts')
} else if (!cmd || cmd === 'console') {
  await import('./console.ts')
} else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP)
} else {
  console.error(`magi: unknown command "${cmd}"\n`)
  console.error(HELP)
  process.exit(1)
}
