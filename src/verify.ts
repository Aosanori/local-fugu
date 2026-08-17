import { dirname, join, relative, resolve } from 'node:path'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { config } from './config.ts'
import type { ToolCall } from './upstream.ts'

export type Scorer = {
  name: string
  /** regex matched against the edited file path */
  match: string
  cmd: string[]
  /** added when the command exits 0 */
  weight: number
  /** counted per matching line of output, then multiplied by penaltyWeight */
  penaltyPattern?: string
  penaltyWeight?: number
  timeoutMs?: number
}

export type VerifyConfig = {
  enabled: boolean
  editTools: string[]
  workspaceMarkers: string[]
  maxCandidates: number
  scorers: Scorer[]
}

export type Edit = { filePath: string; content: string }
export type Score = { total: number; detail: string }

export const verifyConfig = (): VerifyConfig | undefined =>
  (config as unknown as { verify?: VerifyConfig }).verify

/** Turn an edit/write tool call into the full text the file would end up with. */
export async function materialize(call: ToolCall): Promise<Edit | null> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments || '{}')
  } catch {
    return null
  }

  const filePath = typeof args.filePath === 'string' ? args.filePath : null
  if (!filePath) return null

  if (call.function.name === 'write') {
    return typeof args.content === 'string' ? { filePath, content: args.content } : null
  }

  const { oldString, newString, replaceAll } = args as {
    oldString?: string
    newString?: string
    replaceAll?: boolean
  }
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null
  if (!existsSync(filePath)) return null

  const current = await Bun.file(filePath).text()
  if (!current.includes(oldString)) return null // candidate does not apply — reject it

  return {
    filePath,
    content: replaceAll
      ? current.replaceAll(oldString, newString)
      : current.replace(oldString, newString),
  }
}

/** Nearest ancestor holding a project marker (pubspec.yaml, package.json, ...). */
export function workspaceRoot(filePath: string, markers: string[]): string | null {
  let dir = dirname(resolve(filePath))
  for (;;) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const run = async (cmd: string[], cwd: string, timeoutMs: number) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)
  return { exitCode, output: stdout + stderr }
}

/**
 * Score a workspace. `edit` is applied to an APFS clone of the project, so the
 * user's working tree is never touched and the copy costs nothing on this
 * filesystem.
 */
export async function scoreWorkspace(
  root: string,
  scorers: Scorer[],
  edit: Edit | null,
): Promise<Score> {
  const sandbox = mkdtempSync(join(tmpdir(), 'magi-verify-'))
  const clone = join(sandbox, 'ws')

  try {
    // -c asks for a copy-on-write clone; fall back to a plain copy elsewhere.
    const cp = await run(['cp', '-Rc', root, clone], sandbox, 60000)
    if (cp.exitCode !== 0) await run(['cp', '-R', root, clone], sandbox, 120000)

    if (edit) {
      const rel = relative(root, resolve(edit.filePath))
      if (rel.startsWith('..')) return { total: -Infinity, detail: 'edit outside workspace' }
      await Bun.write(join(clone, rel), edit.content)
    }

    let total = 0
    const detail: string[] = []

    for (const s of scorers) {
      const { exitCode, output } = await run(s.cmd, clone, s.timeoutMs ?? 120000)
      let sub = exitCode === 0 ? s.weight : 0

      let hits = 0
      if (s.penaltyPattern) {
        const re = new RegExp(s.penaltyPattern, 'gm')
        hits = (output.match(re) ?? []).length
        sub += hits * (s.penaltyWeight ?? -1)
      }

      total += sub
      detail.push(`${s.name}=${sub}${hits ? `(${hits} hits)` : ''}${exitCode === 0 ? '' : ' exit!=0'}`)
    }

    return { total, detail: detail.join(' ') }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

export const scorersFor = (filePath: string, all: Scorer[]): Scorer[] =>
  all.filter((s) => new RegExp(s.match).test(filePath))
