// Worker of the Playbooks plugin. It reads playbooks from the workspace, creates an Orca Run with one
// Task per step (dependencies from `needs`), starts an Orca worker for every ready agent step, runs
// script steps itself, opens a decision gate for every ready gate step and applies the decision,
// from the panel or from `orca orchestration gate-resolve`. It runs the `orca` CLI and the playbook's
// own scripts through execFile (no shell) and writes only inside `<workspace>/.orca/runs/`.
// Pattern of calling `orca orchestration` from a plugin worker after Agent Pipeline (MIT, Alexander-64).
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildRunGraph, launchOf, workerActive, workspacePath, type CliTask, type CliWorker } from './orcaRuns'
import { localFirstPrompts } from './firstPrompt'
import { buildTimeline, parseTime, type CliGate, type CliMessage, type DispatchTimes } from './timeline'
import { depths, loopSteps, parsePlaybook, renderPrompt, topologicalOrder, type GateStep, type Playbook, type ScriptStep, type Step } from './playbook'
import type { AgentLive, RunNode, OrcaRunSummary, PlaybookInfo, RunInfo, SessionAgent, SessionChild, SessionInfo, StepInfo, StepRun, TimelineEvent, WorkspaceInfo } from './protocol'

const RUNS_KEY = 'runs.v2'
const MAX_RUNS = 20
// PLAYBOOKS_POLL_MS and PLAYBOOKS_INDEX_MS only let the tests go faster; read when used, after the tests set them.
const pollMs = () => Number(process.env.PLAYBOOKS_POLL_MS) || 3000
const indexMs = () => Number(process.env.PLAYBOOKS_INDEX_MS) || 30_000
const SESSIONS_MS = 10_000
/** How long the first `state.get` waits for the first read of Orca Runs before it answers without it. */
const FIRST_INDEX_WAIT_MS = 1500
const TEXT_CHARS = 400

function short(value: unknown, max = TEXT_CHARS): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Agent sessions of one workspace row of `orca worktree ps --json`, with the work Orca observes inside each. */
export function sessionsOf(row: { agents?: Record<string, unknown>[] } | undefined): SessionInfo[] {
  return (row?.agents ?? []).map((agent) => {
    const main = (agent.mainAgent ?? {}) as Record<string, unknown>
    const children: SessionChild[] = (Array.isArray(agent.children) ? (agent.children as Record<string, unknown>[]) : []).map((child) => {
      const item: SessionChild = { kind: typeof child.kind === 'string' ? child.kind : 'unknown' }
      const description = short(child.description ?? child.title ?? child.name, 160)
      if (description) item.description = description
      if (typeof child.state === 'string') item.state = child.state
      const since = parseTime(child.firstObservedAt ?? child.startedAt)
      if (since !== undefined) item.since = since
      const observed = parseTime(child.observedAt)
      if (observed !== undefined) item.observedAt = observed
      return item
    })
    const session: SessionInfo = {
      id: String(agent.orcaSessionId ?? agent.paneKey ?? ''),
      paneKey: String(agent.paneKey ?? ''),
      title: short(agent.conversationName ?? agent.taskTitle ?? agent.displayName, 120) ?? 'Session',
      state: String(agent.state ?? main.state ?? 'unknown'),
      children
    }
    if (typeof agent.parentPaneKey === 'string' && agent.parentPaneKey) session.parentPaneKey = agent.parentPaneKey
    if (typeof agent.agentType === 'string') session.agent = agent.agentType
    const since = parseTime(agent.stateStartedAt ?? main.stateStartedAt)
    if (since !== undefined) session.since = since
    if (typeof main.outcome === 'string') session.outcome = main.outcome
    if (typeof main.state === 'string') session.mainState = main.state
    const mainSince = parseTime(main.stateStartedAt)
    if (mainSince !== undefined) session.mainSince = mainSince
    if (typeof agent.workingMode === 'string') session.workingMode = agent.workingMode
    const tool = short(agent.toolName, 60)
    if (tool) session.tool = tool
    const input = short(typeof agent.toolInput === 'string' ? agent.toolInput : agent.toolInput ? JSON.stringify(agent.toolInput) : undefined, 160)
    if (input) session.toolInput = input
    const last = short(agent.lastAssistantMessage)
    if (last) session.lastMessage = last
    if (typeof agent.subagentObservation === 'string') session.subagents = agent.subagentObservation
    const updated = parseTime(agent.updatedAt)
    if (updated !== undefined) session.updatedAt = updated
    return session
  })
}
const OUTPUT_CHARS = 4000
const PLAYBOOK_DIR = path.join('.orca', 'playbooks')
const RUNS_DIR = path.join('.orca', 'runs')
const INDEX_RUNS = 60
const ORCA_RUNS_SHOWN = 15
const LINES = 14
const COORDINATOR_SINK = "printf 'Playbooks plugin coordinator: this terminal only receives Orca notifications.\\n'; cat >/dev/null"

/** A run as the worker keeps it: the playbook it started from is needed again for revise loops. */
type StoredRun = RunInfo & { playbook: Playbook }

function orcaExecutable(): string {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND
  const bundled = '/Applications/Orca.app/Contents/Resources/bin/orca'
  return existsSync(bundled) ? bundled : 'orca'
}

type CliResult = Record<string, unknown>

function orcaCli(args: string[], timeoutMs = 120_000, maxBuffer = 4 * 1024 * 1024): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(orcaExecutable(), [...args, '--json'], { timeout: timeoutMs, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      let parsed: { ok?: boolean; result?: CliResult; error?: { code?: string; message?: string } } | undefined
      try {
        parsed = JSON.parse(stdout || stderr)
      } catch {
        reject(new Error(`orca ${args.slice(0, 2).join(' ')}: ${(stderr || stdout || String(error)).slice(0, 300)}`))
        return
      }
      if (!parsed || parsed.ok === false) {
        reject(new Error(`orca ${args.slice(0, 2).join(' ')}: ${parsed?.error?.message ?? 'error'}`))
        return
      }
      resolve(parsed.result ?? {})
    })
  })
}

function field(value: unknown, ...keys: string[]): string | undefined {
  let current: unknown = value
  for (const key of keys) current = current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
  return typeof current === 'string' ? current : undefined
}

/** `{{now}}` (HH:MM) and `{{date}}` (YYYY-MM-DD) in the system time zone of the machine Orca runs on. */
export function localNow(at = new Date()): { now: string; date: string } {
  const pad = (value: number) => String(value).padStart(2, '0')
  return { now: `${pad(at.getHours())}:${pad(at.getMinutes())}`, date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` }
}

function selector(workspaceId: string): string {
  return workspaceId.startsWith('identity:') || workspaceId.startsWith('folder:') ? workspaceId : `id:${workspaceId}`
}

function stepInfo(playbook: Playbook): StepInfo[] {
  const depth = depths(playbook.steps)
  return playbook.steps.map((step) => {
    const info: StepInfo = { id: step.id, title: step.title, kind: step.kind, needs: step.needs, depth: depth[step.id] }
    if (step.kind === 'agent') Object.assign(info, { agent: step.agent, model: step.model, effort: step.effort, keepOpen: step.keepOpen })
    if (step.kind === 'script') info.run = step.run
    if (step.kind === 'gate') Object.assign(info, { question: step.question, loop: step.loop })
    return info
  })
}

/** Orca stores and sends JSON only: fields left `undefined` are dropped here. */
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function publicRun(run: StoredRun): RunInfo {
  const { playbook: _playbook, ...info } = run
  return json(info)
}

/** A gate answer: `ok[: comment]` or `revise[: comment]` (`popraw` is a legacy alias of `revise`); anything else is not acted on. */
export function parseResolution(resolution: string): { choice: 'ok' | 'revise'; comment: string } | undefined {
  const match = /^\s*(ok|revise|popraw)\s*(?::([\s\S]*))?$/i.exec(resolution)
  return match ? { choice: match[1].toLowerCase() === 'ok' ? 'ok' : 'revise', comment: (match[2] ?? '').trim() } : undefined
}

/** The text a script step leaves: its `{"outputs": {...}}` last line, else all of stdout. */
export function scriptOutput(stdout: string): string {
  const lines = stdout.trim().split('\n')
  try {
    const last = JSON.parse(lines[lines.length - 1] ?? '') as { outputs?: Record<string, unknown> }
    if (last && typeof last.outputs === 'object' && last.outputs) return Object.values(last.outputs).map(String).join('\n\n')
  } catch {
    // Plain text output.
  }
  return stdout.trim()
}

function runScript(file: string, cwd: string, env: Record<string, string>, timeoutSec: number): Promise<string> {
  const [command, args] = file.endsWith('.py') ? ['python3', [file]] : file.endsWith('.sh') ? ['/bin/sh', [file]] : [file, []]
  return new Promise((resolve, reject) => {
    const base: Record<string, string> = {}
    for (const name of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR']) if (process.env[name]) base[name] = process.env[name]!
    execFile(command, args as string[], { cwd, env: { ...base, ...env }, timeout: timeoutSec * 1000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const reason = stderr.trim().split('\n').pop() || error.message
        reject(new Error(reason.slice(0, 300)))
        return
      }
      resolve(scriptOutput(stdout))
    })
  })
}

/** Readable last lines of a worker transcript page set: the agent's text and the tools it called. */
export function transcriptLines(messages: { role?: string; blocks?: { type?: string; text?: string; name?: string; input?: unknown }[] }[], max = LINES): string[] {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.blocks ?? []) {
      if (block.type === 'text' && block.text) lines.push(...block.text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim()))
      if (block.type === 'tool-call' && block.name) {
        const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? '')
        const detail = /'description':\s*'([^']{1,120})'/.exec(input)?.[1] ?? /"description":\s*"([^"]{1,120})"/.exec(input)?.[1] ?? input.replace(/\s+/g, ' ').slice(0, 100)
        lines.push(`→ ${block.name}: ${detail}`)
      }
    }
  }
  return lines.slice(-max).map((line) => (line.length > 220 ? `${line.slice(0, 219)}…` : line))
}

/** Hides strings that look like tokens or keys before transcript lines reach the panel. */
export function redact(lines: string[]): string[] {
  return lines.map((line) => line
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '<hidden>')
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 <hidden>'))
}

let stopTimer: (() => void) | undefined

export function deactivate(): void {
  stopTimer?.()
}

export default function activate(orca: OrcaWorkerApi): void {
  let runs: StoredRun[] = []
  let loaded: Promise<void> | undefined
  let ticking = false
  const scripts = new Set<string>()
  /** Gates the panel is answering right now; the tick leaves them alone. */
  const answering = new Set<string>()
  /** The last run status a notification was shown for, so each change notifies once. */
  const notified = new Map<string, string>()
  /** Orca Runs and the workspace paths their workers ran in, refreshed while a panel asks for state. */
  const index = new Map<string, OrcaRunSummary & { paths: string[]; bySession: Map<string, Set<string>> }>()
  let indexing: Promise<void> | undefined
  let indexedAt = 0
  /** The first read of Orca Runs failed: say so by ending "indexing" instead of promising agents that never come. */
  let firstReadFailed = false
  /** Launch options per dispatch: they never change, so `worker-show` is asked once. */
  const launches = new Map<string, ReturnType<typeof launchOf>>()
  /** Which conversation dispatched a task (`dispatch-show` → `creator_orca_session_id`); fixed once known. */
  const creators = new Map<string, string | null>()
  /** Sessions that are workers of some dispatch (`assignee_orca_session_id`): not conversations of their own. */
  const assignees = new Set<string>()
  const workerSessionsByDispatch = new Map<string, string>()
  const latestDispatchByTask = new Map<string, string>()

  async function creatorOf(task: { id: string; status?: string }): Promise<string | null> {
    if (creators.has(task.id)) return creators.get(task.id)!
    let failed = false
    const shown = await orcaCli(['orchestration', 'dispatch-show', '--task', task.id, '--full'], 30_000).catch((error: Error) => {
      // "no dispatch" is a real answer for a task never dispatched (a gate); anything else is a passing failure, asked again later.
      failed = !/no dispatch|not found|has no/i.test(error.message)
      return undefined
    })
    const creator = field(shown, 'dispatch', 'creator_orca_session_id') ?? null
    const dispatchId = field(shown, 'dispatch', 'id')
    const assignee = field(shown, 'dispatch', 'assignee_orca_session_id')
    if (dispatchId) {
      latestDispatchByTask.set(task.id, dispatchId)
      rememberWorkerSession(dispatchId, assignee)
    }
    // A dispatch can get its worker session id after its creator is already known.
    if (!failed && ['completed', 'failed'].includes(task.status ?? '')) creators.set(task.id, creator)
    return creator
  }

  async function creatorsOf(tasks: { id: string; status?: string }[]): Promise<(string | null)[]> {
    const result: (string | null)[] = []
    for (let i = 0; i < tasks.length; i += 6) result.push(...(await Promise.all(tasks.slice(i, i + 6).map(creatorOf))))
    return result
  }

  /** Launch of a dispatch another one follows up (model for follow-ups), when that dispatch is not in the Run being read. */
  const origins = new Map<string, DispatchTimes>()
  /** Dispatch times per finished dispatch (they no longer change). */
  const dispatchTimes = new Map<string, DispatchTimes>()
  function rememberWorkerSession(dispatchId: string, sessionId: string | undefined): void {
    if (!sessionId) return
    assignees.add(sessionId)
    workerSessionsByDispatch.set(dispatchId, sessionId)
  }

  /** Released structured workers may only identify their session through worker-show's pane key. */
  async function readWorkerDispatch(id: string): Promise<DispatchTimes> {
    const known = dispatchTimes.get(id)
    if (known) return known
    const shown = await orcaCli(['orchestration', 'worker-show', '--dispatch', id, '--full'], 30_000).catch(() => undefined)
    const dispatch = ((shown ?? {}) as { dispatch?: Record<string, unknown> }).dispatch ?? {}
    const pane = field(shown, 'dispatch', 'assigneePaneKey') ?? field(shown, 'dispatch', 'assignee_pane_key')
    const paneSession = pane?.match(/^structured-agent-session-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):/i)?.[1]
    rememberWorkerSession(id, field(shown, 'dispatch', 'assigneeOrcaSessionId') ?? field(shown, 'dispatch', 'assignee_orca_session_id') ?? paneSession)
    const times: DispatchTimes = { ...launchOf(shown) }
    const dispatched = parseTime(dispatch.dispatchedAt ?? dispatch.dispatched_at)
    if (dispatched !== undefined) times.dispatchedAt = dispatched
    const completed = parseTime(dispatch.completedAt ?? dispatch.completed_at)
    if (completed !== undefined) times.completedAt = completed
    const followUpOf = field(shown, 'dispatch', 'followUpOf') ?? field(shown, 'dispatch', 'follow_up_of_dispatch_id')
    if (followUpOf) times.followUpOf = followUpOf
    if (shown !== undefined && times.completedAt !== undefined) dispatchTimes.set(id, times)
    return times
  }

  /** worker-list is newest first. A finished task can have cleared its current dispatch id. */
  function firstDispatches(workers: CliWorker[]): Map<string, string> {
    const byTask = new Map<string, string>()
    for (const worker of workers) if (worker.taskId && worker.dispatchId) byTask.set(worker.taskId, worker.dispatchId)
    return byTask
  }

  let promptCache: { path: unknown; ids: string; at: number; times: Promise<Map<string, number>> } | undefined
  function firstPromptsFor(config: unknown, sessions: SessionInfo[]): Promise<Map<string, number>> {
    const ids = sessions.filter((session) => !assignees.has(session.id)).map((session) => session.id).sort()
    const key = ids.join(',')
    if (promptCache && promptCache.path === config && promptCache.ids === key && Date.now() - promptCache.at < SESSIONS_MS) return promptCache.times
    const times = localFirstPrompts(config, ids)
    promptCache = { path: config, ids: key, at: Date.now(), times }
    return times
  }

  let psCache: { at: number; rows: { path?: string; agents?: Record<string, unknown>[] }[] } | undefined

  async function worktreeRows(): Promise<{ path?: string; agents?: Record<string, unknown>[] }[]> {
    if (psCache && Date.now() - psCache.at < SESSIONS_MS) return psCache.rows
    const result = await orcaCli(['worktree', 'ps', '--limit', '500'], 60_000, 16 * 1024 * 1024).catch(() => ({} as CliResult))
    const rows = Array.isArray(result.worktrees) ? result.worktrees : Array.isArray(result) ? result : Array.isArray((result as { rows?: unknown }).rows) ? (result as { rows: unknown[] }).rows : []
    psCache = { at: Date.now(), rows: rows as { path?: string; agents?: Record<string, unknown>[] }[] }
    return psCache.rows
  }

  function load(): Promise<void> {
    loaded ??= orca.storage.get(RUNS_KEY).then((stored) => {
      runs = Array.isArray(stored) ? (stored as StoredRun[]) : []
      for (const run of runs) notified.set(run.id, run.status)
    })
    return loaded
  }

  async function save(): Promise<void> {
    runs = runs.slice(0, MAX_RUNS)
    await orca.storage.set(RUNS_KEY, json(runs) as never)
    for (const run of runs) {
      if (notified.get(run.id) === run.status) continue
      notified.set(run.id, run.status)
      const text = { waiting: 'waits for your decision', failed: 'stopped with an error', rejected: 'sent back, run ended', done: 'finished' }[run.status as string]
      if (text) await orca.host.call('notifications.show', { title: `Playbooks: ${run.title}`, body: `${text} (${run.workspaceName})` }).catch(() => undefined)
    }
    orca.panels.post('runs.changed', { runs: runs.map(publicRun) })
    const active = runs.filter((run) => run.status === 'running' || run.status === 'waiting')
    const waiting = runs.filter((run) => run.status === 'waiting').length
    await orca.host.call('statusBar.update', {
      id: 'runs',
      text: active.length ? `Playbooks: ${active.length} running${waiting ? ` · ${waiting} waiting for you` : ''}` : 'Playbooks',
      tone: waiting ? 'warning' : 'neutral',
      tooltip: waiting ? 'A run waits for your decision in the Playbooks panel' : 'Playbooks panel'
    }).catch(() => undefined)
  }

  async function workspaces(): Promise<WorkspaceInfo[]> {
    const result = await orca.host.call('workspace.list', {})
    return result.workspaces
      .filter((workspace) => workspace.path && (workspace.hostId === 'local' || workspace.hostId === null))
      .map((workspace) => ({ id: workspace.id, name: workspace.name, path: workspace.path, branch: workspace.branch }))
  }

  async function playbooksIn(workspace: WorkspaceInfo): Promise<PlaybookInfo[]> {
    const dir = path.join(workspace.path, PLAYBOOK_DIR)
    let names: string[] = []
    try {
      names = (await readdir(dir)).filter((name) => /^[a-z0-9][a-z0-9_-]*\.ya?ml$/i.test(name)).sort()
    } catch {
      return []
    }
    const result: PlaybookInfo[] = []
    for (const file of names.slice(0, 50)) {
      const full = path.join(dir, file)
      const info = await stat(full)
      if (!info.isFile() || info.size > 256 * 1024) continue
      const id = file.replace(/\.ya?ml$/i, '')
      const parsed = parsePlaybook(id, await readFile(full, 'utf8'))
      result.push(parsed.playbook
        ? { file, id, title: parsed.playbook.title, description: parsed.playbook.description, errors: [], steps: stepInfo(parsed.playbook) }
        : { file, id, title: id, description: '', errors: parsed.errors, steps: [] })
    }
    return result
  }

  function promptValues(run: StoredRun, step: Step, comment: string): Record<string, string> {
    const time = localNow()
    const values: Record<string, string> = { run_dir: run.runDir, now: time.now, date: time.date, step: step.id, comment }
    for (const [name, value] of Object.entries(run.inputs)) values[`inputs.${name}`] = value
    return values
  }

  function specFor(run: StoredRun, step: Step, comment: string): string {
    if (step.kind === 'gate') return `Human decision gate: ${step.question} A person answers it in the Playbooks panel; do not start a worker for it.`
    if (step.kind === 'script') return `Script step ${step.run}: the Playbooks plugin runs it itself and writes the result to ${path.join(run.runDir, `${step.id}.txt`)}. Do not start a worker for it.`
    const remark = comment ? `\n\nReviewer comments on the previous version (address them): ${comment}` : ''
    return renderPrompt(step.prompt, promptValues(run, step, comment)) + remark +
      `\n\nPlaybook "${run.title}", step "${step.title}". You work in ${run.workspacePath}. Write the result to ${path.join(run.runDir, `${step.id}.md`)}. Do not commit or push. Do not send \`ask\` or \`escalation\`: nobody will answer them; if something blocks you, finish with \`worker_done --outcome failed\` and the reason. At the end, send worker_done with a short summary.`
  }

  /** The Orca task title of a step attempt: unique, so the agent Orca lists for it can be matched back to the step. */
  function taskTitle(run: StoredRun | RunInfo, step: Pick<Step, 'title'>, attempt: number): string {
    return `${step.title} · ${run.id}#${attempt}`
  }

  async function createTask(run: StoredRun, step: Step, comment: string, attempt: number): Promise<string> {
    const deps = step.needs.map((need) => run.tasks[need].taskId)
    const created = await orcaCli(['orchestration', 'task-create', '--run', run.id, '--from', run.handle, '--task-title', taskTitle(run, step, attempt), '--display-name', step.title, '--spec', specFor(run, step, comment), '--deps', JSON.stringify(deps)])
    const taskId = field(created, 'task', 'id') ?? field(created, 'taskId')
    if (!taskId) throw new Error(`Orca returned no task id for step ${step.id}.`)
    return taskId
  }

  async function readOutput(run: StoredRun, stepId: string): Promise<string | undefined> {
    for (const name of [`${stepId}.md`, `${stepId}.txt`]) {
      try {
        const content = await readFile(path.join(run.runDir, name), 'utf8')
        return content.length > OUTPUT_CHARS ? `${content.slice(0, OUTPUT_CHARS)}\n…` : content
      } catch {
        // Try the next name.
      }
    }
    return undefined
  }

  function refreshStatus(run: StoredRun): void {
    if (run.status === 'rejected') return
    const states = Object.values(run.tasks)
    if (states.some((task) => task.status === 'failed')) run.status = 'failed'
    else if (states.every((task) => task.status === 'completed')) run.status = 'done'
    else if (states.some((task) => task.gateId && !task.decision)) run.status = 'waiting'
    else run.status = 'running'
  }

  async function startScript(run: StoredRun, step: ScriptStep, state: StepRun): Promise<void> {
    const taskId = state.taskId
    scripts.add(taskId)
    state.status = 'dispatched'
    state.startedAt = Date.now()
    let result: { status: 'completed' | 'failed'; output?: string; error?: string }
    try {
      const file = path.join(run.workspacePath, PLAYBOOK_DIR, 'scripts', step.run)
      if (!(await stat(file)).isFile()) throw new Error(`No file ${file}.`)
      const env: Record<string, string> = { PLAYBOOK_RUN_DIR: run.runDir, PLAYBOOK_STEP: step.id }
      for (const [name, value] of Object.entries(run.inputs)) env[`PLAYBOOK_INPUT_${name.toUpperCase()}`] = value
      const output = await runScript(file, run.runDir, env, step.timeoutSec)
      await writeFile(path.join(run.runDir, `${step.id}.txt`), output)
      result = { status: 'completed', output }
    } catch (error) {
      result = { status: 'failed', error: (error as Error).message }
    }
    try {
      await orcaCli(['orchestration', 'task-update', '--id', taskId, '--status', result.status, '--result', JSON.stringify(result.error ? { error: result.error } : { file: `${step.id}.txt` }), '--from', run.handle])
    } catch (error) {
      result = { status: 'failed', error: (error as Error).message }
    }
    scripts.delete(taskId)
    if (run.tasks[step.id]?.taskId !== taskId) return
    Object.assign(state, { status: result.status, endedAt: Date.now(), error: result.error })
    if (result.output !== undefined) state.output = result.output.length > OUTPUT_CHARS ? `${result.output.slice(0, OUTPUT_CHARS)}\n…` : result.output
    refreshStatus(run)
    run.updatedAt = Date.now()
    await save()
    void tick()
  }

  /** Applies a gate decision: `ok` completes the gate; `revise` loops back while loops remain, else stops the run. */
  async function decide(run: StoredRun, step: GateStep, choice: 'ok' | 'revise', comment: string, via: 'panel' | 'cli'): Promise<void> {
    const state = run.tasks[step.id]
    const note = { decision: choice, comment: comment || undefined, via }
    // The decision is recorded only after Orca took it, so a failed call is retried by the next tick.
    await orcaCli(['orchestration', 'task-update', '--id', state.taskId, '--status', choice === 'ok' ? 'completed' : 'failed', '--result', JSON.stringify(note), '--from', run.handle])
    Object.assign(state, { decision: choice, comment: comment || undefined, endedAt: Date.now(), status: choice === 'ok' ? 'completed' : 'failed', error: undefined })
    if (choice === 'ok') {
      refreshStatus(run)
      return
    }
    if (!step.loop || run.loops >= step.loop.maxLoops) {
      run.status = 'rejected'
      return
    }
    run.loops += 1
    for (const again of loopSteps(run.playbook.steps, step.id, step.loop.goto)) {
      const previous = run.tasks[again.id]
      if (previous.status === 'pending' && again.id !== step.id) {
        await orcaCli(['orchestration', 'task-update', '--id', previous.taskId, '--status', 'failed', '--result', JSON.stringify({ superseded: true }), '--from', run.handle]).catch(() => undefined)
      }
      const taskId = await createTask(run, again, again.id === step.loop.goto ? comment : '', previous.attempt + 1)
      run.tasks[again.id] = { taskId, status: 'pending', attempt: previous.attempt + 1 }
    }
    refreshStatus(run)
  }

  async function tickRun(run: StoredRun): Promise<boolean> {
    const result = await orcaCli(['orchestration', 'task-list', '--run', run.id])
    const tasks = Array.isArray(result.tasks) ? (result.tasks as { id: string; status: string }[]) : []
    let changed = false
    for (const step of run.playbook.steps) {
      const state = run.tasks[step.id]
      const task = tasks.find((candidate) => candidate.id === state.taskId)
      if (task && task.status !== state.status && !scripts.has(state.taskId) && state.dispatchId !== 'failed') {
        state.status = task.status
        if (task.status === 'completed' || task.status === 'failed') state.endedAt = Date.now()
        changed = true
      }
      if (step.kind === 'agent' && state.status === 'completed' && state.output === undefined) {
        const output = await readOutput(run, step.id)
        if (output !== undefined) {
          state.output = output
          changed = true
        }
      }
      if (step.kind === 'gate' && state.gateId && !state.decision && !answering.has(state.gateId)) {
        const gates = await orcaCli(['orchestration', 'gate-list', '--run', run.id, '--task', state.taskId, '--full'])
        const gate = (Array.isArray(gates.gates) ? (gates.gates as Record<string, unknown>[]) : []).find((candidate) => candidate.id === state.gateId)
        const resolution = field(gate, 'resolution')
        if (state.decision || answering.has(state.gateId) || run.tasks[step.id] !== state) continue
        if (field(gate, 'status') === 'resolved' && resolution) {
          const answer = parseResolution(resolution)
          if (answer) {
            state.error = undefined
            await decide(run, step, answer.choice, answer.comment, 'cli')
          } else {
            // A resolved gate cannot be reopened in Orca: ask again with a new gate on the same task.
            const again = await orcaCli(['orchestration', 'gate-create', '--task', state.taskId, '--question', step.question, '--options', JSON.stringify(['ok', 'revise']), '--from', run.handle])
            state.gateId = field(again, 'gateId') ?? field(again, 'gate', 'id') ?? field(again, 'id')
            state.error = `The answer "${resolution.slice(0, 200)}" is neither "ok" nor "revise: comment"; the gate asks again.`
          }
          changed = true
          continue
        }
      }
      if (state.status !== 'ready') continue
      if (step.kind === 'gate') {
        if (state.gateId) continue
        const gate = await orcaCli(['orchestration', 'gate-create', '--task', state.taskId, '--question', step.question, '--options', JSON.stringify(['ok', 'revise']), '--from', run.handle])
        state.gateId = field(gate, 'gateId') ?? field(gate, 'gate', 'id') ?? field(gate, 'id')
        state.status = 'blocked'
        changed = true
      } else if (step.kind === 'script') {
        if (scripts.has(state.taskId)) continue
        void startScript(run, step, state)
        changed = true
      } else if (!state.dispatchId) {
        const args = ['orchestration', 'worker-start', '--run', run.id, '--from', run.handle, '--task', state.taskId, '--agent', step.agent, '--worktree', selector(run.workspaceId)]
        if (step.model) args.push('--model', step.model)
        if (step.model && step.effort) args.push('--effort', step.effort)
        if (step.keepOpen) args.push('--keep-open')
        let started: CliResult
        try {
          started = await orcaCli(args, 180_000)
        } catch (error) {
          // Orca: a failed worker-start is not rerun (it may still own a terminal); the step fails instead.
          Object.assign(state, { dispatchId: 'failed', status: 'failed', endedAt: Date.now(), error: `Worker start failed: ${(error as Error).message}` })
          await orcaCli(['orchestration', 'task-update', '--id', state.taskId, '--status', 'failed', '--result', JSON.stringify({ error: state.error }), '--from', run.handle]).catch(() => undefined)
          changed = true
          continue
        }
        state.dispatchId = field(started, 'dispatchId') ?? field(started, 'dispatch', 'id') ?? 'started'
        state.status = 'dispatched'
        state.startedAt = Date.now()
        changed = true
      }
    }
    const before = run.status
    refreshStatus(run)
    if (changed || before !== run.status) run.updatedAt = Date.now()
    if (run.error && changed) run.error = undefined
    return changed || before !== run.status
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      await load()
      let changed = false
      for (const run of runs.filter((candidate) => candidate.status === 'running' || candidate.status === 'waiting')) {
        try {
          changed = (await tickRun(run)) || changed
        } catch (error) {
          const message = (error as Error).message
          if (run.error !== message) {
            run.error = message
            changed = true
          }
        }
      }
      if (changed) await save()
    } finally {
      ticking = false
    }
  }

  /** The workspace in focus, matched to `workspace.list` by id, then by the path inside a raw `<repo>::<path>` id, then by name and branch. */
  async function focusedWorkspace(list: WorkspaceInfo[]): Promise<WorkspaceInfo | undefined> {
    const context = await orca.host.call('workspace.readContext', {}).catch(() => null)
    if (!context) return undefined
    const id = context.workspaceId
    return (id ? list.find((workspace) => workspace.id === id) : undefined)
      ?? (id && id.includes('::') ? list.find((workspace) => workspace.path === workspacePath(id)) : undefined)
      ?? list.find((workspace) => workspace.name === context.displayName && workspace.branch === context.branch)
  }

  /** Refreshes which workspaces each recent Orca Run worked in (`worker-list` per Run, only for new or still active Runs). */
  function refreshIndex(): Promise<void> {
    indexing ??= (async () => {
      // A retry after a failed first read is "indexing" again until it ends.
      firstReadFailed = false
      const listed = await orcaCli(['orchestration', 'run-list', '--full'])
      const rows = (Array.isArray(listed.runs) ? (listed.runs as Record<string, unknown>[]) : [])
        .map((row) => ({ id: String(row.id), objective: String(row.objective ?? ''), createdAt: Date.parse(String(row.created_at)) || 0, updatedAt: Date.parse(String(row.updated_at)) || 0 }))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, INDEX_RUNS)
      // Orca keeps updated_at equal to created_at, so a Run that gets new workers looks unchanged: read every listed Run again (~0.1 s each).
      for (let i = 0; i < rows.length; i += 6) {
        await Promise.all(rows.slice(i, i + 6).map(async (row) => {
          const [workers, tasks] = await Promise.all([
            orcaCli(['orchestration', 'worker-list', '--run', row.id]).then((result) => (Array.isArray(result.workers) ? (result.workers as CliWorker[]) : [])).catch(() => [] as CliWorker[]),
            orcaCli(['orchestration', 'task-list', '--run', row.id]).then((result) => (Array.isArray(result.tasks) ? (result.tasks as { id: string; title?: string; status?: string }[]) : [])).catch(() => [] as { id: string; title?: string; status?: string }[])
          ])
          const bySession = new Map<string, Set<string>>()
          const owners = await creatorsOf(tasks)
          const first = firstDispatches(workers)
          const members = tasks.map((task, i) => {
            const latest = latestDispatchByTask.get(task.id)
            const shown = task.status === 'dispatched' ? latest ?? first.get(task.id) : first.get(task.id)
            return { owner: owners[i], shown, latest, taskId: task.id }
          })
          for (let i = 0; i < members.length; i += 6) {
            await Promise.all(members.slice(i, i + 6).map(async ({ owner, shown, latest, taskId }) => {
              if (!owner) return
              if (shown && shown !== latest && !workerSessionsByDispatch.has(shown)) await readWorkerDispatch(shown)
              const workersOfOwner = bySession.get(owner) ?? new Set<string>()
              workersOfOwner.add((shown && workerSessionsByDispatch.get(shown)) || taskId)
              bySession.set(owner, workersOfOwner)
            }))
          }
          const paths = [...new Set(workers.map((worker) => workspacePath(worker.workspace)).filter((value): value is string => !!value))]
          // One coordinator often keeps a single Run for a whole session: then its objective names only the first task.
          const last = tasks[tasks.length - 1]?.title
          const title = tasks.length > 1 ? `${tasks.length} tasks · last: ${last ?? '?'}` : row.objective || last || row.id
          index.set(row.id, { ...row, title, paths, bySession, workers: workers.length, tasks: tasks.length, active: workers.some(workerActive) })
        }))
      }
      for (const id of [...index.keys()]) if (!rows.some((row) => row.id === id)) index.delete(id)
      const first = !indexedAt
      indexedAt = Date.now()
      // A panel that got an answer while this first read was running shows "reading"; tell it to ask again.
      if (first) orca.panels.post('index.ready', {})
    })().catch((error) => {
      if (!indexedAt) firstReadFailed = true
      throw error
    }).finally(() => {
      indexing = undefined
    })
    return indexing
  }

  /** Agents Orca lists in a workspace, by their dispatched task title (`agent:read`). */
  async function agentsByTask(workspaceId: string): Promise<Map<string, AgentLive>> {
    const result = await orca.host.call('agents.list', { workspaceId }).catch(() => ({ agents: [] as { terminalId: string | null; state: AgentLive['state']; stateStartedAt: number; task?: { title: string } | null }[] }))
    const byTask = new Map<string, AgentLive>()
    for (const agent of result.agents) {
      const title = agent.task?.title
      if (!title) continue
      const live: AgentLive = { state: agent.state, since: agent.stateStartedAt }
      if (agent.terminalId) live.terminalId = agent.terminalId
      byTask.set(title, live)
    }
    return byTask
  }

  const timer = setInterval(() => void tick(), pollMs())
  ;(timer as { unref?: () => void }).unref?.()
  stopTimer = () => clearInterval(timer)
  void load().then(save).catch(() => undefined)
  // The first read of Orca Runs takes seconds after a start; begin it now instead of on the first panel request.
  void refreshIndex().catch(() => undefined)

  orca.panels.handle('state.get', async ({ workspaceId }) => {
    await load()
    const list = await workspaces()
    let chosen = workspaceId ? list.find((workspace) => workspace.id === workspaceId) : undefined
    let following = false
    if (!chosen) {
      chosen = await focusedWorkspace(list)
      following = !!chosen
    }
    chosen ??= list.find((workspace) => existsSync(path.join(workspace.path, PLAYBOOK_DIR))) ?? list[0]
    // Wait briefly for the first read of Orca Runs, then answer without it: the panel shows that agents are still
    // being read and asks again on `index.ready`, instead of staying blank for the whole read.
    if (!indexedAt) await Promise.race([refreshIndex().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, FIRST_INDEX_WAIT_MS))])
    else if (Date.now() - indexedAt > indexMs()) void refreshIndex().catch(() => undefined)
    const stillIndexing = !indexedAt && !firstReadFailed
    const mine = chosen ? runs.filter((run) => run.workspaceId === chosen!.id || run.workspacePath === chosen!.path) : []
    const live = chosen && mine.some((run) => run.status === 'running' || run.status === 'waiting') ? await agentsByTask(chosen.id) : new Map<string, AgentLive>()
    const shown = mine.map((run) => {
      const info = publicRun(run)
      for (const step of run.playbook.steps) {
        const state = info.tasks[step.id]
        const agent = state && (live.get(taskTitle(run, step, state.attempt)) ?? (state.attempt === 1 ? live.get(step.title) : undefined))
        if (agent && state.status === 'dispatched') state.live = agent
      }
      return info
    })
    const own = new Set(runs.map((run) => run.id))
    const sessions = chosen ? sessionsOf((await worktreeRows()).find((row) => row.path === chosen!.path)) : []
    // A Run a conversation of this workspace dispatched belongs to that conversation, not to the list on its own.
    const attached = new Set<string>()
    const settings = sessions.length ? await orca.host.call('settings.get', {}).catch(() => undefined) : undefined
    const firstPrompts = await firstPromptsFor(settings?.settings?.localJournalPath, sessions)
    for (const session of sessions) {
      if (assignees.has(session.id)) session.isWorker = true
      else {
        const firstPromptAt = firstPrompts.get(session.id)
        if (firstPromptAt !== undefined) session.firstPromptAt = firstPromptAt
      }
      const mine = [...index.values()].filter((entry) => entry.bySession.has(session.id)).sort((a, b) => a.createdAt - b.createdAt)
      if (!mine.length) continue
      session.runIds = mine.map((entry) => entry.id)
      session.agents = new Set(mine.flatMap((entry) => [...(entry.bySession.get(session.id) ?? [])])).size
      for (const entry of mine) attached.add(entry.id)
    }
    const orcaRuns = chosen
      ? [...index.values()].filter((entry) => !own.has(entry.id) && !attached.has(entry.id) && entry.paths.includes(chosen!.path)).sort((a, b) => b.createdAt - a.createdAt).slice(0, ORCA_RUNS_SHOWN)
          .map(({ paths: _paths, bySession: _bySession, ...summary }) => summary)
      : []
    const waitingElsewhere = runs.filter((run) => run.status === 'waiting' && run.workspaceId !== chosen?.id)
      .map((run) => ({ runId: run.id, title: run.title, workspaceId: run.workspaceId, workspaceName: run.workspaceName }))
    return json({ workspaces: list, workspaceId: chosen?.id ?? null, following, indexing: stillIndexing, playbooks: chosen ? await playbooksIn(chosen) : [], runs: shown, orcaRuns, sessions, waitingElsewhere })
  })

  orca.panels.handle('orca.run', async ({ runId }) => {
    if (!/^run_[A-Za-z0-9]+$/.test(runId)) throw new Error('Invalid run id.')
    const [listed, workers] = await Promise.all([
      orcaCli(['orchestration', 'task-list', '--run', runId, '--full'], 120_000, 32 * 1024 * 1024),
      orcaCli(['orchestration', 'worker-list', '--run', runId])
    ])
    const nodes: RunNode[] = buildRunGraph(Array.isArray(listed.tasks) ? (listed.tasks as CliTask[]) : [], Array.isArray(workers.workers) ? (workers.workers as CliWorker[]) : [])
    // worker-list drops the agent once a worker's terminal is released; the launch options keep agent, model and effort.
    const missing = nodes.filter((node) => node.dispatchId && !node.model)
    for (let i = 0; i < missing.length; i += 4) {
      await Promise.all(missing.slice(i, i + 4).map(async (node) => {
        let launch = launches.get(node.dispatchId!)
        if (!launch) {
          const shown = await orcaCli(['orchestration', 'worker-show', '--dispatch', node.dispatchId!, '--full'], 30_000).catch(() => undefined)
          launch = launchOf(shown)
          if (shown !== undefined) launches.set(node.dispatchId!, launch)
        }
        Object.assign(node, launch)
      }))
    }
    const list = await workspaces()
    for (const workspacePathValue of new Set(nodes.map((node) => node.workspacePath).filter((value): value is string => !!value))) {
      const workspace = list.find((candidate) => candidate.path === workspacePathValue)
      if (!workspace) continue
      const live = await agentsByTask(workspace.id)
      for (const node of nodes) {
        // Only a step still being worked on can be the agent Orca lists under its title (titles may repeat across Runs).
        if (node.workspacePath !== workspacePathValue || !['dispatched', 'ready'].includes(node.status)) continue
        const agent = live.get(node.taskTitle) ?? live.get(node.title)
        if (agent) node.live = agent
      }
    }
    return json({ nodes })
  })

  /** Everything Orca keeps about one Run, joined: tasks (with their first dispatch), gates, mailbox, workers and dispatch times. */
  async function runData(runId: string): Promise<{ tasks: CliTask[]; gates: CliGate[]; messages: CliMessage[]; workers: CliWorker[]; dispatches: Record<string, DispatchTimes> }> {
    const [listed, gates, inbox, workers] = await Promise.all([
      orcaCli(['orchestration', 'task-list', '--run', runId, '--full'], 120_000, 32 * 1024 * 1024),
      orcaCli(['orchestration', 'gate-list', '--run', runId, '--full']).catch(() => ({} as CliResult)),
      orcaCli(['orchestration', 'inbox', '--run', runId, '--limit', '500', '--full'], 60_000, 16 * 1024 * 1024).catch(() => ({} as CliResult)),
      orcaCli(['orchestration', 'worker-list', '--run', runId]).catch(() => ({} as CliResult))
    ])
    const tasks = Array.isArray(listed.tasks) ? (listed.tasks as CliTask[]) : []
    // Orca clears dispatch_id on a finished task; worker-list keeps which dispatch worked on which task. It lists the newest
    // dispatch first, so the last match is the first dispatch of the task, i.e. its start.
    const workerRows = Array.isArray(workers.workers) ? (workers.workers as CliWorker[]) : []
    const first = firstDispatches(workerRows)
    for (const task of tasks) {
      const fallback = first.get(task.id)
      if (!task.dispatch_id && fallback) task.dispatch_id = fallback
    }
    const dispatches: Record<string, DispatchTimes> = {}
    const ids = [...new Set(tasks.map((task) => task.dispatch_id).filter((id): id is string => !!id))]
    for (let i = 0; i < ids.length; i += 6) {
      await Promise.all(ids.slice(i, i + 6).map(async (id) => {
        dispatches[id] = await readWorkerDispatch(id)
      }))
    }
    // worker-list knows the agent of a live worker even when worker-show does not.
    for (const worker of workerRows) {
      if (!worker.dispatchId || !worker.agent || !dispatches[worker.dispatchId] || dispatches[worker.dispatchId].agent) continue
      const [agent, ...model] = worker.agent.split('/')
      Object.assign(dispatches[worker.dispatchId], { agent, ...(model.join('/') ? { model: model.join('/') } : {}) })
    }
    // A follow-up (more work sent to the same worker) keeps the model of the dispatch it follows; Orca records it only on the first.
    for (const times of Object.values(dispatches)) {
      let from = times.followUpOf
      for (let hop = 0; hop < 5 && from && !times.model; hop += 1) {
        let origin = dispatches[from] ?? dispatchTimes.get(from) ?? origins.get(from)
        if (!origin) {
          const shown = await orcaCli(['orchestration', 'worker-show', '--dispatch', from, '--full'], 30_000).catch(() => undefined)
          const dispatch = ((shown ?? {}) as { dispatch?: Record<string, unknown> }).dispatch ?? {}
          origin = { ...launchOf(shown), ...(typeof dispatch.followUpOf === 'string' ? { followUpOf: dispatch.followUpOf } : {}) }
          // Kept apart from dispatchTimes: it has the launch of the origin, not its times.
          if (shown !== undefined) origins.set(from, origin)
        }
        if (origin.model) Object.assign(times, { agent: times.agent ?? origin.agent, model: origin.model, ...(origin.effort && !times.effort ? { effort: origin.effort } : {}) })
        from = origin.followUpOf
      }
    }
    return { tasks, gates: Array.isArray(gates.gates) ? (gates.gates as CliGate[]) : [], messages: Array.isArray(inbox.messages) ? (inbox.messages as CliMessage[]) : [], workers: workerRows, dispatches }
  }

  orca.panels.handle('run.timeline', async ({ runId }) => {
    if (!/^run_[A-Za-z0-9]+$/.test(runId)) throw new Error('Invalid run id.')
    const data = await runData(runId)
    // Script steps run inside this plugin, not in an Orca worker: their start and end come from the run the plugin keeps.
    await load()
    const own = runs.find((run) => run.id === runId)
    for (const step of own?.playbook.steps ?? []) {
      const state = own!.tasks[step.id]
      const task = state && data.tasks.find((candidate) => candidate.id === state.taskId)
      if (step.kind !== 'script' || !state.startedAt || !task || task.dispatch_id) continue
      task.dispatch_id = `script_${task.id}`
      data.dispatches[task.dispatch_id] = { dispatchedAt: state.startedAt, agent: `script ${step.run}`, ...(state.endedAt !== undefined ? { completedAt: state.endedAt } : {}) }
    }
    return json(buildTimeline(data.tasks, data.gates, data.messages, data.dispatches))
  })

  orca.panels.handle('session.view', async ({ sessionId, runIds }) => {
    if (!Array.isArray(runIds) || runIds.length > 60 || runIds.some((id) => !/^run_[A-Za-z0-9]+$/.test(id))) throw new Error('Invalid run ids.')
    const tasks: CliTask[] = []
    const gates: CliGate[] = []
    const messages: CliMessage[] = []
    const dispatches: Record<string, DispatchTimes> = {}
    const agents: SessionAgent[] = []
    for (const runId of runIds) {
      const data = await runData(runId)
      const owners = await creatorsOf(data.tasks)
      // Tasks nobody dispatched (decision gates) belong to the conversation when it is the only one dispatching in this Run.
      const sole = owners.some((owner) => owner === sessionId) && owners.every((owner) => owner === null || owner === sessionId)
      const mine = data.tasks.filter((_task, i) => owners[i] === sessionId || (owners[i] === null && sole))
      const ids = new Set(mine.map((task) => task.id))
      tasks.push(...mine)
      gates.push(...data.gates.filter((gate) => gate.task_id && ids.has(gate.task_id)))
      messages.push(...data.messages.filter((message) => {
        const payload = typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload ?? {})
        return [...ids].some((id) => payload.includes(id))
      }))
      Object.assign(dispatches, data.dispatches)
      for (const node of buildRunGraph(mine, data.workers.filter((worker) => worker.taskId && ids.has(worker.taskId)))) {
        const task = mine.find((candidate) => candidate.id === node.id)!
        // Agents are tasks a worker took; gates and never-dispatched steps stay on the timeline only.
        if (!task.dispatch_id) continue
        const times = task.dispatch_id ? data.dispatches[task.dispatch_id] : undefined
        const agent: SessionAgent = { ...node, runId, ...(times?.agent && !node.agent ? { agent: times.agent } : {}), ...(times?.model && !node.model ? { model: times.model } : {}) }
        if (times?.effort && !node.effort) agent.effort = times.effort
        if (times?.dispatchedAt !== undefined) agent.startedAt = times.dispatchedAt
        const workerSessionId = workerSessionsByDispatch.get(task.dispatch_id)
        if (workerSessionId) agent.workerSessionId = workerSessionId
        const ended = times?.completedAt ?? parseTime(task.completed_at)
        if (ended !== undefined && ['completed', 'failed'].includes(task.status ?? '')) agent.endedAt = ended
        agents.push(agent)
      }
    }
    const timeline = buildTimeline(tasks, gates, messages, dispatches, true)
    agents.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    return json({ agents, events: timeline.events as TimelineEvent[], lanes: timeline.lanes })
  })

  orca.panels.handle('step.lines', async ({ dispatchId }) => {
    if (!/^ctx_[A-Za-z0-9]+$/.test(dispatchId)) throw new Error('Invalid worker id.')
    const messages: Parameters<typeof transcriptLines>[0] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page += 1) {
      const args = ['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'auto', '--limit', '2000']
      if (cursor) args.push('--cursor', cursor)
      const read = await orcaCli(args, 60_000, 32 * 1024 * 1024)
      const transcript = (read.transcript ?? {}) as { messages?: Parameters<typeof transcriptLines>[0]; nextCursor?: string }
      if (!transcript.messages && read.terminal) {
        // `--source auto` fell back to the worker's terminal output.
        const terminal = read.terminal as { lines?: string[]; text?: string }
        const text = (terminal.lines ?? []).join('\n') || terminal.text || ''
        return json({ lines: redact(text.split('\n').filter((line) => line.trim())).slice(-LINES) })
      }
      messages.push(...(transcript.messages ?? []))
      if (messages.length > 400) messages.splice(0, messages.length - 400)
      if (!transcript.nextCursor || transcript.nextCursor === cursor) break
      cursor = transcript.nextCursor
    }
    return json({ lines: redact(transcriptLines(messages)) })
  })

  orca.panels.handle('agent.show', async ({ terminalId, workspacePath: wanted, workspaceId }) => {
    if (terminalId) {
      const focused = await orca.host.call('terminal.focus', { terminalId }).catch(() => ({ focused: false }))
      if (focused.focused) return { shown: 'terminal' as const }
    }
    const list = await workspaces()
    const workspace = list.find((candidate) => candidate.id === workspaceId) ?? list.find((candidate) => candidate.path === wanted)
    if (!workspace) return { shown: 'none' as const }
    await orca.host.call('workspace.open', { workspaceId: workspace.id })
    return { shown: 'workspace' as const }
  })

  orca.panels.handle('workspace.goto', async ({ workspaceId }) => {
    if (!(await workspaces()).some((workspace) => workspace.id === workspaceId)) throw new Error('No such workspace on this host.')
    await orca.host.call('workspace.open', { workspaceId })
    return { opened: true }
  })

  orca.panels.handle('run.start', async ({ workspaceId, file }) => {
    await load()
    const workspace = (await workspaces()).find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('No such workspace on this host.')
    if (!/^[a-z0-9][a-z0-9_-]*\.ya?ml$/i.test(file)) throw new Error('Invalid playbook file name.')
    const source = path.join(workspace.path, PLAYBOOK_DIR, file)
    if ((await stat(source)).size > 256 * 1024) throw new Error('The playbook file is larger than 256 KiB.')
    const parsed = parsePlaybook(file.replace(/\.ya?ml$/i, ''), await readFile(source, 'utf8'))
    if (!parsed.playbook) throw new Error(parsed.errors.join(' '))
    const playbook = parsed.playbook
    // The coordinator terminal only gives the Run an Orca identity (`--from`). It runs an inert sink, so a
    // wake-up line Orca may type into it is swallowed instead of being run by the shell.
    const { terminalId: handle } = await orca.host.call('terminal.create', { workspaceId: workspace.id, title: `Playbook: ${playbook.title}`, command: COORDINATOR_SINK })
    const created = await orcaCli(['orchestration', 'run-create', '--objective', `Playbook: ${playbook.title}`, '--from', handle])
    const runId = field(created, 'run', 'id') ?? field(created, 'runId')
    if (!runId) throw new Error('Orca returned no run id.')
    const runsRoot = path.join(workspace.path, RUNS_DIR)
    const runDir = path.join(runsRoot, runId)
    await mkdir(runDir, { recursive: true })
    if (!existsSync(path.join(runsRoot, '.gitignore'))) await writeFile(path.join(runsRoot, '.gitignore'), '# Results of Playbooks runs: kept out of Git.\n*\n')

    const run: StoredRun = {
      id: runId,
      title: playbook.title,
      playbookFile: file,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runDir,
      handle,
      inputs: playbook.inputs,
      loops: 0,
      steps: stepInfo(playbook),
      tasks: {},
      playbook
    }
    for (const step of topologicalOrder(playbook.steps)) run.tasks[step.id] = { taskId: await createTask(run, step, '', 1), status: 'pending', attempt: 1 }
    runs.unshift(run)
    await save()
    void tick()
    return { run: publicRun(run) }
  })

  orca.panels.handle('gate.resolve', async ({ runId, stepId, choice, comment }) => {
    await load()
    const run = runs.find((candidate) => candidate.id === runId)
    const step = run?.playbook.steps.find((candidate) => candidate.id === stepId)
    const state = run?.tasks[stepId]
    if (!run || !step || step.kind !== 'gate' || !state?.gateId) throw new Error('This gate is not waiting for a decision.')
    if (state.decision) throw new Error('This gate is already decided.')
    // `popraw` is the legacy name of `revise`, still accepted from older panels.
    if (choice !== 'ok' && choice !== 'revise' && choice !== 'popraw') throw new Error('Choice: ok or revise.')
    const decision = choice === 'ok' ? 'ok' : 'revise'
    const note = typeof comment === 'string' ? comment.trim().slice(0, 2000) : ''
    if (decision === 'revise' && !note) throw new Error('Add a comment to Revise.')
    const gateId = state.gateId
    answering.add(gateId)
    try {
      await orcaCli(['orchestration', 'gate-resolve', '--id', gateId, '--resolution', note ? `${decision}: ${note}` : decision, '--from', run.handle])
      await decide(run, step, decision, note, 'panel')
    } catch (error) {
      run.error = (error as Error).message
      run.updatedAt = Date.now()
      await save()
      throw error
    } finally {
      answering.delete(gateId)
    }
    run.updatedAt = Date.now()
    await save()
    void tick()
    return { run: publicRun(run) }
  })
}
