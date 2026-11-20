// The timeline of any Orca Run: what happened when, from the records Orca keeps (tasks, worker dispatches,
// mailbox messages and decision gates). Pure functions, shared by the worker and the tests.
import type { TimelineEvent } from './protocol'
import { taskDeps, type CliTask } from './orcaRuns'

export type CliGate = { id?: string; task_id?: string; question?: string; status?: string; resolution?: string | null; created_at?: string; resolved_at?: string | null }
export type CliMessage = { type?: string; subject?: string; created_at?: string; sequence?: number | string; payload?: unknown }
export type DispatchTimes = { dispatchedAt?: number; completedAt?: number; agent?: string; model?: string; effort?: string; followUpOf?: string }

/** Orca writes times as SQLite `YYYY-MM-DD HH:MM:SS` (UTC), ISO with `Z`, or epoch milliseconds. */
export function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return undefined
  const text = value.trim()
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text
  const parsed = Date.parse(sqlite)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Orca's escalation when a worker's session ends before worker_done (its subject for the "finished" case). */
const STOPPED_WITHOUT_REPORT = /^worker stopped without reporting$/i

function idsOf(message: CliMessage): { taskId?: string; dispatchId?: string } {
  const payload = payloadOf(message)
  return {
    taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined,
    dispatchId: typeof payload.dispatchId === 'string' ? payload.dispatchId : undefined
  }
}

function payloadOf(message: CliMessage): Record<string, unknown> {
  const raw = message.payload
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * Events of a Run in time order. Each task gets a lane (a column for drawing parallel work), reused once
 * the task before it in that lane has ended.
 */
export function buildTimeline(tasks: CliTask[], gates: CliGate[], messages: CliMessage[], dispatches: Record<string, DispatchTimes>): { events: TimelineEvent[]; lanes: number } {
  const events: TimelineEvent[] = []
  const titles = new Map(tasks.map((task) => [task.id, task.display_name || task.task_title || task.id]))
  const spans: { taskId: string; start: number; end?: number }[] = []
  let order = 0
  const push = (event: Omit<TimelineEvent, 'order'>) => events.push({ ...event, order: order++ })

  for (const task of tasks) {
    const title = titles.get(task.id)!
    const created = parseTime(task.created_at)
    const dispatch = task.dispatch_id ? dispatches[task.dispatch_id] : undefined
    const started = dispatch?.dispatchedAt
    const ended = parseTime(task.completed_at) ?? dispatch?.completedAt
    const who = [dispatch?.agent, dispatch?.model].filter(Boolean).join(' · ')
    if (created !== undefined) push({ at: created, kind: 'created', taskId: task.id, title, detail: taskDeps(task.deps).length ? `waits for: ${taskDeps(task.deps).map((dep) => titles.get(dep) ?? dep).join(', ')}` : undefined })
    if (started !== undefined) push({ at: started, kind: 'started', taskId: task.id, title, detail: who || undefined })
    if (ended !== undefined && (task.status === 'completed' || task.status === 'failed')) {
      const from = started ?? created
      push({ at: ended, kind: task.status === 'failed' ? 'failed' : 'done', taskId: task.id, title, duration: from !== undefined ? Math.max(0, ended - from) : undefined })
    }
    const start = started ?? created
    // A task still open (pending, ready, dispatched, blocked) holds its lane; any other status ends where Orca last saw it.
    // An open task no worker took (a gate waiting for a person, a step waiting for its needs) is nobody working: no lane.
    const open = ['pending', 'ready', 'dispatched', 'blocked'].includes(task.status ?? 'pending')
    if (start !== undefined && !(open && started === undefined)) spans.push({ taskId: task.id, start, end: open ? undefined : ended ?? start })
  }

  // Reports per worker: Orca's "stopped without reporting" escalation is false when the same dispatch reported later.
  const reports = messages.filter((message) => message.type === 'worker_done').map((message) => ({ at: parseTime(message.created_at), ...idsOf(message) }))
  for (const message of messages) {
    const at = parseTime(message.created_at)
    if (at === undefined) continue
    const taskId = idsOf(message).taskId
    if (message.type === 'escalation' && STOPPED_WITHOUT_REPORT.test(message.subject ?? '')) {
      const { dispatchId } = idsOf(message)
      if (reports.some((report) => report.taskId === taskId && report.at !== undefined && report.at >= at && (!dispatchId || !report.dispatchId || report.dispatchId === dispatchId))) continue
    }
    const kind = message.type === 'worker_done' ? 'report' : message.type === 'question' ? 'question' : message.type === 'escalation' ? 'escalation' : 'message'
    push({ at, kind, taskId, title: (taskId && titles.get(taskId)) || message.subject || message.type || 'message', detail: message.subject && taskId ? message.subject : undefined })
  }

  for (const gate of gates) {
    const title = (gate.task_id && titles.get(gate.task_id)) || 'Gate'
    const created = parseTime(gate.created_at)
    if (created !== undefined) push({ at: created, kind: 'gate', taskId: gate.task_id, title, detail: gate.question })
    const resolved = parseTime(gate.resolved_at)
    if (resolved !== undefined) push({ at: resolved, kind: 'decision', taskId: gate.task_id, title, detail: gate.resolution ?? undefined, duration: created !== undefined ? resolved - created : undefined })
  }

  // Lanes: earliest-starting task first, into the lowest lane free at its start.
  const laneEnds: number[] = []
  const laneOf = new Map<string, number>()
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    let lane = laneEnds.findIndex((end) => end <= span.start)
    if (lane < 0) lane = laneEnds.length
    laneEnds[lane] = span.end ?? Number.POSITIVE_INFINITY
    laneOf.set(span.taskId, lane)
  }
  for (const event of events) if (event.taskId && laneOf.has(event.taskId)) event.lane = laneOf.get(event.taskId)
  for (const span of spans) {
    const lane = laneOf.get(span.taskId)
    if (lane === undefined) continue
    for (const event of events) if (event.taskId === span.taskId) Object.assign(event, { spanStart: span.start, ...(span.end !== undefined ? { spanEnd: span.end } : {}) })
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order)
  return { events: merged(events), lanes: laneEnds.length }
}

const NEAR = 3000

/** One row where Orca records two things at once: a start right after creation, a report right at the end. */
function merged(events: TimelineEvent[]): TimelineEvent[] {
  const drop = new Set<TimelineEvent>()
  for (const event of events) {
    if (!event.taskId) continue
    if (event.kind === 'created') {
      const start = events.find((other) => other.kind === 'started' && other.taskId === event.taskId && Math.abs(other.at - event.at) <= NEAR)
      if (start) {
        if (event.detail && !start.detail?.includes(event.detail)) start.detail = [start.detail, event.detail].filter(Boolean).join(' · ')
        drop.add(event)
      }
    }
    if (event.kind === 'report') {
      const end = events.find((other) => (other.kind === 'done' || other.kind === 'failed') && other.taskId === event.taskId && Math.abs(other.at - event.at) <= NEAR)
      if (end) {
        end.detail = event.detail ?? end.detail
        drop.add(event)
      }
    }
  }
  return events.filter((event) => !drop.has(event))
}
