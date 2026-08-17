/**
 * Proves the scorer separates candidates that a language model cannot tell
 * apart by reading. Run it after changing scorers in config.json.
 *
 *   ./scripts/serve.sh is not needed; this talks to no models.
 *   bun run scripts/verify-selftest.ts
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { scorersFor, scoreWorkspace, verifyConfig, workspaceRoot } from '../src/verify.ts'

const root = join(import.meta.dir, '..', 'fixtures', 'demo_pkg')
const file = join(root, 'lib', 'stats.dart')

if (!existsSync(join(root, '.dart_tool'))) {
  console.log('==> dart pub get')
  const proc = Bun.spawn(['dart', 'pub', 'get'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  if ((await proc.exited) !== 0) throw new Error('dart pub get failed')
}

const cfg = verifyConfig()
if (!cfg) throw new Error('config.json has no "verify" block')

const scorers = scorersFor(file, cfg.scorers)
console.log(`workspace ${workspaceRoot(file, cfg.workspaceMarkers)}`)
console.log(`scorers   ${scorers.map((s) => s.name).join(', ')}\n`)

const candidates: [string, string | null, 'baseline' | 'better' | 'no better' | 'worse'][] = [
  ['baseline (bug present)', null, 'baseline'],
  [
    'guard the empty list',
    `double average(List<int> values) {
  if (values.isEmpty) return 0;
  return values.reduce((a, b) => a + b) / values.length;
}
`,
    'better',
  ],
  [
    'fold instead of reduce (0/0 = NaN)',
    `double average(List<int> values) {
  return values.fold<int>(0, (a, b) => a + b) / values.length;
}
`,
    'no better',
  ],
  [
    'does not compile',
    `double average(List<int> values) {
  return values.reduce((a, b) => a + b) / lenght;
}
`,
    'worse',
  ],
]

let baseline = 0
let failures = 0

for (const [name, content, expect] of candidates) {
  const { total, detail } = await scoreWorkspace(root, scorers, content ? { filePath: file, content } : null)
  if (expect === 'baseline') baseline = total

  const ok =
    expect === 'baseline' ||
    (expect === 'better' && total > baseline) ||
    (expect === 'no better' && total <= baseline) ||
    (expect === 'worse' && total < baseline)
  if (!ok) failures++

  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(36)} ${String(total).padStart(4)}  ${detail}`)
}

console.log(failures === 0 ? '\nscorer separates all candidates' : `\n${failures} expectation(s) missed`)
process.exit(failures === 0 ? 0 : 1)
