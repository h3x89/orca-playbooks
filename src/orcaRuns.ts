// Any Orca orchestration Run as a graph: tasks with `deps` from `task-list --full`, the workers that ran
// them from `worker-list`. Pure functions, shared by the worker and the tests.
import type { RunNode } from './protocol'

export type CliTask = {
  id: string
  status?: string
  deps?: unknown
  display_name?: string | null
  task_title?: string | null
  dispatch_id?: string | null
  result?: unknown
  created_at?: string
  completed_at?: string | null
}

export type CliWorker = {
  dispatchId?: string
  taskId?: string
  state?: string
  liveness?: string
  agent?: string
  outcome?: string | null
  workspace?: string
  terminal?: string
}

const RESULT_CHARS = 4000

/** `<repo id>::<path>` (how `worker-list` names a workspace) → the path; a bare path stays. */
export function workspacePath(workspace: string | undefined): string | undefined {
  if (!workspace) return undefined
  const index = workspace.indexOf('::')
  return index >= 0 ? workspace.slice(index + 2) : workspace
}

/** Task ids a task depends on; Orca keeps them as an array or a JSON string. */
export function taskDeps(deps: unknown): string[] {
  let value = deps
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** The readable part of a task result: a worker report's `body`, else the JSON itself. */
export function resultText(result: unknown): string | undefined {
  let value = result
  if (typeof result === 'string') {
    try {
      value = JSON.parse(result)
    } catch {
      return result.trim() ? cut(result) : undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const body = typeof record.body === 'string' ? record.body : undefined
  const subject = typeof record.subject === 'string' ? record.subject : undefined
  if (body || subject) return cut([subject, body].filter(Boolean).join('\n\n'))
  return cut(JSON.stringify(value, null, 2))
}

function cut(text: string): string {
  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n…` : text
}

/** `claude/claude-opus-5-5` → agent and model. */
export function splitAgent(agent: string | undefined): { agent?: string; model?: string } {
  if (!agent) return {}
  const [kind, ...rest] = agent.split('/')
  return { agent: kind, model: rest.join('/') || undefined }
}

/** Nodes of a Run graph, one per task, with its latest worker and a depth for drawing. */
export function buildRunGraph(tasks: CliTask[], workers: CliWorker[]): RunNode[] {
  const ids = new Set(tasks.map((task) => task.id))
  const nodes: RunNode[] = tasks.map((task) => {
    const mine = workers.filter((worker) => worker.taskId === task.id || (task.dispatch_id && worker.dispatchId === task.dispatch_id))
    const worker = mine.find((candidate) => candidate.dispatchId === task.dispatch_id) ?? mine[mine.length - 1]
    const node: RunNode = {
      id: task.id,
      title: task.display_name || task.task_title || task.id,
      taskTitle: task.task_title || task.display_name || task.id,
      status: task.status ?? 'pending',
      needs: taskDeps(task.deps).filter((dep) => ids.has(dep)),
      depth: 0,
      ...splitAgent(worker?.agent)
    }
    const dispatchId = worker?.dispatchId ?? task.dispatch_id ?? undefined
    if (dispatchId) node.dispatchId = dispatchId
    if (worker?.state) node.workerState = worker.state
    if (worker?.liveness) node.liveness = worker.liveness
    if (worker?.outcome) node.outcome = worker.outcome
    const path = workspacePath(worker?.workspace)
    if (path) node.workspacePath = path
    const result = resultText(task.result)
    if (result) node.result = result
    if (task.created_at) node.createdAt = Date.parse(task.created_at.endsWith('Z') ? task.created_at : `${task.created_at.replace(' ', 'T')}Z`) || undefined
    return node
  })
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const memo = new Map<string, number>()
  const depth = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const needs = byId.get(id)?.needs ?? []
    const value = needs.length ? 1 + Math.max(...needs.map((need) => depth(need, seen))) : 0
    memo.set(id, value)
    return value
  }
  for (const node of nodes) node.depth = depth(node.id, new Set())
  return nodes
}

/** Worker states Orca reports once a worker has finished (`worker-list`: ready | succeeded | failed | stopped). */
const FINAL = new Set(['succeeded', 'failed', 'stopped', 'completed', 'released', 'abandoned'])

/** Whether a worker is still working: live and not in a final state. A finished worker whose terminal is kept open stays `live`. */
export function workerActive(worker: CliWorker): boolean {
  return worker.liveness === 'live' && !FINAL.has(worker.state ?? '')
}

/** Agent, model and effort a worker was started with, from `worker-show --full` (kept after its terminal is released). */
export function launchOf(shown: unknown): { agent?: string; model?: string; effort?: string } {
  const worker = (shown as { worker?: { startOptions?: { agent?: string; launch?: { effective?: Record<string, unknown>; requested?: Record<string, unknown> } } } })?.worker
  const launch = worker?.startOptions?.launch
  const pick = (key: string) => {
    const value = launch?.effective?.[key] ?? launch?.requested?.[key]
    return typeof value === 'string' && value ? value : undefined
  }
  const result: { agent?: string; model?: string; effort?: string } = {}
  const agent = pick('agent') ?? (typeof worker?.startOptions?.agent === 'string' ? worker.startOptions.agent : undefined)
  if (agent) result.agent = agent
  const model = pick('model')
  if (model) result.model = model
  const effort = pick('effort')
  if (effort) result.effort = effort
  return result
}
