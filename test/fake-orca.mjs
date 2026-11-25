// A stand-in for the `orca orchestration` CLI the worker calls, for tests only. It keeps tasks and
// gates in `$FAKE_ORCA_STATE`, logs every call to `$FAKE_ORCA_LOG` and answers with `--json` envelopes.
// A started worker finishes on the next `task-list`, writing `PLAN v<n>` to the file its spec names.
import { appendFileSync, existsSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const statePath = process.env.FAKE_ORCA_STATE
const logPath = process.env.FAKE_ORCA_LOG
const reports = JSON.parse(process.env.FAKE_ORCA_REPORTS || '{}')
const args = process.argv.slice(2).filter((arg) => arg !== '--json' && arg !== '--full')
appendFileSync(logPath, JSON.stringify(args) + '\n')
// Lets a test make the first read of Orca Runs slow (outside the state lock, like a slow real CLI).
if (args[0] === 'orchestration' && args[1] === 'run-list' && Number(process.env.FAKE_ORCA_SLOW_RUN_LIST_MS) > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_ORCA_SLOW_RUN_LIST_MS))
}

// The worker runs several CLI calls at once: serialise read-modify-write of the state file with a lock file.
const lockPath = `${statePath}.lock`
for (let tries = 0; ; tries += 1) {
  try {
    closeSync(openSync(lockPath, 'wx'))
    break
  } catch {
    if (tries > 2000) throw new Error('fake orca: lock timeout')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}
process.on('exit', () => {
  try {
    unlinkSync(lockPath)
  } catch {}
})

const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { n: 0, tasks: [], gates: [], plans: 0 }
state.runs ??= []
state.workers ??= []
state.messages ??= []
state.worktrees ??= []
// Orca writes some times as SQLite `YYYY-MM-DD HH:MM:SS` (UTC) and others as ISO; the fake does the same.
const sqliteNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const isoNow = () => new Date().toISOString()
const flag = (name) => {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  return args.find((argument) => argument.startsWith(name + '='))?.slice(name.length + 1)
}
const id = (prefix) => `${prefix}_${String(++state.n).padStart(4, '0')}`
const ok = (result) => {
  writeFileSync(statePath, JSON.stringify(state))
  process.stdout.write(JSON.stringify({ ok: true, result }))
}

const [group, command] = args
if (group === 'worktree' && command === 'ps') {
  ok({ worktrees: state.worktrees, totalCount: state.worktrees.length, truncated: false })
  process.exit(0)
}
if (group !== 'orchestration') {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: `unknown ${group}` } }))
  process.exit(1)
}
switch (command) {
  case 'run-create': {
    const run = { id: id('run'), objective: flag('--objective'), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    state.runs.push(run)
    ok({ run: { id: run.id } })
    break
  }
  case 'inbox':
    ok({ count: state.messages.length, messages: state.messages.filter((message) => message.runId === flag('--run')) })
    break
  case 'run-list':
    if (process.env.FAKE_ORCA_FAIL_RUN_LIST) {
      process.stdout.write(JSON.stringify({ ok: false, error: { message: 'run-list failed' } }))
      process.exit(1)
    }
    ok({ runs: state.runs })
    break
  case 'dispatch-show': {
    // Like Orca: the task's latest dispatch, with the conversation that created it.
    const task = state.tasks.find((t) => t.id === flag('--task'))
    const worker = state.workers.find((w) => w.taskId === flag('--task'))
    if (!task || !worker) {
      process.stdout.write(JSON.stringify({ ok: false, error: { message: 'no dispatch for task' } }))
      process.exit(1)
    }
    ok({ dispatch: { id: worker.dispatchId, task_id: task.id, creator_orca_session_id: task.creator ?? null, assignee_orca_session_id: worker.assignee ?? null, status: task.status } })
    break
  }
  case 'worker-show': {
    const worker = state.workers.find((w) => w.dispatchId === flag('--dispatch'))
    ok({ worker: { startOptions: { agent: worker?.launch?.agent, launch: { effective: worker?.launch ?? {} } } }, dispatch: { dispatchedAt: worker?.dispatchedAt ?? null, completedAt: worker?.completedAt ?? null, followUpOf: worker?.followUpOf ?? null, assigneePaneKey: worker?.assigneePaneKey ?? null } })
    break
  }
  case 'worker-list':
    ok({ workers: state.workers.filter((worker) => worker.runId === flag('--run')) })
    break
  case 'task-create': {
    const task = { id: id('task'), runId: flag('--run'), title: flag('--task-title'), displayName: flag('--display-name'), spec: flag('--spec'), deps: JSON.parse(flag('--deps') ?? '[]'), status: 'pending', created_at: sqliteNow() }
    state.tasks.push(task)
    ok({ task: { id: task.id } })
    break
  }
  case 'task-list': {
    for (const task of state.tasks) {
      // Only tasks the plugin created (they carry a spec) are finished by their fake worker; seeded Runs stay as written.
      if (task.status === 'dispatched' && task.spec !== undefined) {
        const file = /Write the result to (\S+\.md)\./.exec(task.spec)?.[1]
        state.plans += 1
        if (file) writeFileSync(file, reports[basename(file)] ?? `PLAN v${state.plans}`)
        task.status = 'completed'
        task.completed_at = isoNow()
        state.messages.push({ type: 'worker_done', subject: `${task.displayName ?? task.title}: done`, created_at: isoNow(), runId: task.runId, payload: JSON.stringify({ taskId: task.id, dispatchId: task.dispatchId }) })
        const worker = state.workers.find((w) => w.dispatchId === task.dispatchId)
        if (worker) worker.completedAt = isoNow()
      }
    }
    for (const task of state.tasks) {
      if (task.status === 'pending' && task.deps.every((dep) => state.tasks.find((t) => t.id === dep)?.status === 'completed')) task.status = 'ready'
    }
    // Like Orca 1.4.263: a finished task no longer names its dispatch (worker-list still does).
    ok({ tasks: state.tasks.filter((task) => task.runId === flag('--run')).map((task) => ({ id: task.id, status: task.status, title: task.title, task_title: task.title, display_name: task.displayName ?? task.title, deps: task.deps, result: task.result ?? null, created_at: task.created_at ?? null, completed_at: task.completed_at ?? null, dispatch_id: task.status === 'completed' || task.status === 'failed' ? null : task.dispatchId ?? null })) })
    break
  }
  case 'task-update': {
    const task = state.tasks.find((t) => t.id === flag('--id'))
    task.status = flag('--status')
    task.result = flag('--result')
    if (task.status === 'completed' || task.status === 'failed') task.completed_at = isoNow()
    ok({ task: { id: task.id, status: task.status } })
    break
  }
  case 'worker-start': {
    if (process.env.FAKE_ORCA_FAIL_WORKER) {
      process.stdout.write(JSON.stringify({ ok: false, error: { message: 'agent_readiness timeout' } }))
      process.exit(1)
    }
    const task = state.tasks.find((t) => t.id === flag('--task'))
    task.status = 'dispatched'
    const dispatchId = id('ctx')
    task.dispatchId = dispatchId
    state.workers.push({ dispatchedAt: sqliteNow(), dispatchId, taskId: task.id, runId: task.runId, state: 'ready', liveness: 'live', agent: `${flag('--agent')}/${flag('--model') ?? ''}`, workspace: (flag('--worktree') ?? '').replace(/^id:/, '') })
    ok({ dispatchId, taskId: task.id })
    break
  }
  case 'gate-create': {
    const gate = { id: id('gate'), task_id: flag('--task'), question: flag('--question'), status: 'pending', created_at: sqliteNow(), resolved_at: null }
    state.gates.push(gate)
    ok({ gateId: gate.id, taskId: gate.task_id, status: 'pending' })
    break
  }
  case 'gate-list':
    // Like Orca, without --run (or a caller handle) the listing is not scoped to this Run.
    if (!flag('--run')) {
      process.stdout.write(JSON.stringify({ ok: false, error: { message: 'run_required' } }))
      process.exit(1)
    }
    ok({ gates: state.gates.filter((gate) => !flag('--task') || gate.task_id === flag('--task')).filter((gate) => state.tasks.find((t) => t.id === gate.task_id)?.runId === flag('--run')) })
    break
  case 'gate-resolve': {
    const gate = state.gates.find((g) => g.id === flag('--id'))
    gate.status = 'resolved'
    gate.resolution = flag('--resolution')
    gate.resolved_at = sqliteNow()
    ok({ gateId: gate.id, status: 'resolved' })
    break
  }
  default:
    process.stdout.write(JSON.stringify({ ok: false, error: { message: `unknown ${command}` } }))
    process.exit(1)
}
