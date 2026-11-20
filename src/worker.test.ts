// End to end through the worker with a fake `orca` CLI (test/fake-orca.mjs): scripts, an agent
// step, the gate, a revise loop from the panel and the final OK given from the CLI.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as worker from './worker'
import { localNow, parseResolution, scriptOutput } from './worker'
import type { RunInfo } from './protocol'

const PLAYBOOK = `
title: Test weather
inputs:
  activity: { default: cycling }
steps:
  - id: weather
    script: { run: weather.sh }
  - id: air
    script: { run: air.sh }
  - id: plan
    needs: [weather, air]
    agent: claude
    model: claude-sonnet-5-5
    keep_open: true
    prompt: Plan for {{inputs.activity}} from {{run_dir}}/weather.txt.
  - id: decision
    needs: [plan]
    gate: { question: Approve? }
    on:
      revise: { goto: plan, max_loops: 1 }
`

let dir = ''
afterEach(async () => {
  worker.deactivate()
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function setup() {
  dir = mkdtempSync(path.join(os.tmpdir(), 'playbooks-test-'))
  const workspace = path.join(dir, 'ws')
  const scripts = path.join(workspace, '.orca', 'playbooks', 'scripts')
  mkdirSync(scripts, { recursive: true })
  writeFileSync(path.join(workspace, '.orca', 'playbooks', 'weather.yaml'), PLAYBOOK)
  writeFileSync(path.join(scripts, 'weather.sh'), 'echo "log line"\necho "{\\"outputs\\": {\\"weather\\": \\"12°C, dry, wind, $PLAYBOOK_INPUT_ACTIVITY\\"}}"\n')
  writeFileSync(path.join(scripts, 'air.sh'), 'echo "EAQI 20"\n')
  const fake = fileURLToPath(new URL('../test/fake-orca.mjs', import.meta.url))
  const cli = path.join(dir, 'orca')
  writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
  chmodSync(cli, 0o755)
  Object.assign(process.env, {
    ORCA_CLI_COMMAND: cli,
    FAKE_ORCA_STATE: path.join(dir, 'state.json'),
    FAKE_ORCA_LOG: path.join(dir, 'calls.log'),
    PLAYBOOKS_POLL_MS: '100',
    PLAYBOOKS_INDEX_MS: '200',
    FAKE_ORCA_FAIL_WORKER: '',
    FAKE_ORCA_SLOW_RUN_LIST_MS: '',
    FAKE_ORCA_FAIL_RUN_LIST: ''
  })
  const other = path.join(dir, 'other')
  mkdirSync(other)
  const world = {
    focus: { workspaceId: 'repo1::' + workspace, branch: 'main', displayName: 'demo', terminals: [] } as Record<string, unknown> | null,
    agents: [] as { terminalId: string | null; title: string | null; agent: string | null; state: string; stateStartedAt: number; task?: { title: string } | null }[]
  }
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [
        { id: 'repo1::' + workspace, kind: 'worktree', name: 'demo', path: workspace, branch: 'main', hostId: 'local' },
        { id: 'repo2::' + other, kind: 'worktree', name: 'other', path: other, branch: 'feature', hostId: 'local' }
      ], truncated: false },
      'workspace.readContext': () => world.focus,
      'agents.list': () => ({ agents: world.agents }),
      'terminal.create': { terminalId: 'term_coord' },
      'terminal.focus': { focused: true },
      'workspace.open': { opened: true },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })
  return { workspace, other, host, world }
}

/** Orca refuses a worker answer that is not plain JSON (an `undefined` field included); the mock host does not. */
function assertPlainJson(value: unknown, where = 'answer'): void {
  if (value === undefined) assert.fail(`${where} is undefined`)
  if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) assertPlainJson(inner, `${where}.${key}`)
}

function calls(): string[][] {
  return readFileSync(process.env.FAKE_ORCA_LOG!, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

async function until(read: () => Promise<RunInfo>, done: (run: RunInfo) => boolean): Promise<RunInfo> {
  for (let i = 0; i < 300; i += 1) {
    const run = await read()
    if (done(run)) return run
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return assert.fail(`timed out; last state: ${JSON.stringify(await read())}`)
}

/** state.get once the first read of Orca Runs is done (on a busy machine it can outlast the first answer). */
async function settled<T extends { indexing: boolean }>(read: () => Promise<T>): Promise<T> {
  let answer = await read()
  for (let i = 0; i < 100 && answer.indexing; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    answer = await read()
  }
  return answer
}

test('{{now}} and {{date}} are in the system time zone', () => {
  assert.deepEqual(localNow(new Date(2026, 0, 2, 7, 5)), { now: '07:05', date: '2026-01-02' })
  const at = new Date()
  assert.equal(localNow(at).now, `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`)
})

test('scriptOutput takes the outputs line, else plain stdout', () => {
  assert.equal(scriptOutput('noise\n{"outputs": {"a": "x", "b": "y"}}\n'), 'x\n\ny')
  assert.equal(scriptOutput('just text\n'), 'just text')
})

test('runs scripts, the agent and the gate, loops on revise and finishes on an OK from the CLI', async () => {
  const { workspace, host } = setup()
  const mounted = await mountWorker(worker, { host })
  const state = await mounted.request('state.get', {})
  assertPlainJson(state)
  assert.equal(state.playbooks.length, 1)
  assert.deepEqual(state.playbooks[0].errors, [])

  const { run } = await mounted.request('run.start', { workspaceId: state.workspaceId!, file: 'weather.yaml' })
  assert.ok(existsSync(path.join(workspace, '.orca', 'runs', '.gitignore')))
  const read = async () => (await mounted.request('state.get', {})).runs.find((candidate) => candidate.id === run.id)!

  const waiting = await until(read, (current) => current.status === 'waiting')
  assertPlainJson(await mounted.request('state.get', {}))
  assert.equal(waiting.tasks.weather.output, '12°C, dry, wind, cycling')
  assert.equal(waiting.tasks.air.output, 'EAQI 20')
  assert.equal(waiting.tasks.plan.output, 'PLAN v1')

  const start = calls().find((call) => call[1] === 'worker-start')!
  for (const expected of ['--from', 'term_coord', '--agent', 'claude', '--model', 'claude-sonnet-5-5', '--keep-open', '--worktree', `id:repo1::${workspace}`]) {
    assert.ok(start.includes(expected), `worker-start lacks ${expected}: ${start.join(' ')}`)
  }
  const planSpec = calls().find((call) => call[1] === 'task-create' && call.includes('plan'))!
  assert.match(planSpec[planSpec.indexOf('--spec') + 1], /Plan for cycling from .*\/\.orca\/runs\/run_\d+\/weather\.txt\./)

  await assert.rejects(mounted.request('gate.resolve', { runId: run.id, stepId: 'decision', choice: 'revise' }), /comment/)
  const looped = (await mounted.request('gate.resolve', { runId: run.id, stepId: 'decision', choice: 'revise', comment: 'consider the time of day' })).run
  assert.equal(looped.loops, 1)
  assert.equal(looped.tasks.plan.attempt, 2)
  assert.equal(looped.tasks.decision.attempt, 2)
  const respec = calls().filter((call) => call[1] === 'task-create' && call.includes('plan')).pop()!
  assert.match(respec[respec.indexOf('--spec') + 1], /Reviewer comments on the previous version \(address them\): consider the time of day/)

  const again = await until(read, (current) => current.status === 'waiting' && current.tasks.decision.attempt === 2)
  assert.equal(again.tasks.plan.output, 'PLAN v2')
  execFileSync(process.env.ORCA_CLI_COMMAND!, ['orchestration', 'gate-resolve', '--id', again.tasks.decision.gateId!, '--resolution', 'ok', '--json'])
  const done = await until(read, (current) => current.status === 'done')
  assert.equal(done.tasks.decision.decision, 'ok')
  assert.equal(calls().filter((call) => call[1] === 'worker-start').length, 2)
  assert.deepEqual(mounted.refusals, [])
  assert.ok(mounted.posts.some((post) => post.event === 'runs.changed'))
  const notes = host.callsOf('notifications.show') as { title: string; body: string }[]
  assert.ok(notes.some((note) => note.title === 'Playbooks: Test weather' && /waits for your decision/.test(note.body)), JSON.stringify(notes))
  assert.ok(notes.some((note) => /finished/.test(note.body)), JSON.stringify(notes))
  const { events } = await mounted.request('run.timeline', { runId: run.id })
  assertPlainJson(events)
  const kinds = new Set(events.map((event) => event.kind))
  for (const kind of ['started', 'done', 'gate', 'decision']) assert.ok(kinds.has(kind as never), `timeline lacks ${kind}: ${[...kinds].join(',')}`)
  assert.ok(events.some((event) => event.kind === 'started' && event.title === 'weather' && event.detail === 'script weather.sh'), 'a script step starts when the plugin ran it, not when its task was created')
  const planStarts = events.filter((event) => event.kind === 'started' && event.title === 'plan')
  assert.equal(planStarts.length, 2, 'both plan attempts have a worker start although Orca clears dispatch_id on finished tasks')
  assert.ok(planStarts.every((event) => /claude/.test(event.detail ?? '')), JSON.stringify(planStarts))
  assert.ok(events.some((event) => event.kind === 'done' && event.title === 'plan' && /done/.test(event.detail ?? '')), 'the worker report is folded into the end row')
  assert.ok(events.every((event, index) => index === 0 || events[index - 1].at <= event.at), 'events in time order')
  assert.ok(events.some((event) => event.kind === 'decision' && /revise: consider the time of day/.test(event.detail ?? '')), 'the revise decision is on the timeline')
  const titles = calls().filter((call) => call[1] === 'task-create').map((call) => call[call.indexOf('--task-title') + 1])
  assert.ok(titles.every((title) => / · run_\d+#[12]$/.test(title)), titles.join(', '))
})

test('follows the focused workspace and shows the other Orca Runs that worked there as a graph', async () => {
  const { workspace, other, host, world } = setup()
  writeFileSync(process.env.FAKE_ORCA_STATE!, JSON.stringify({
    n: 100, plans: 0,
    gates: [{ id: 'gate_x', task_id: 'task_gate', question: 'OK?', status: 'pending', created_at: '2026-11-18 20:13:10', resolved_at: null }],
    runs: [
      { id: 'run_ext1', objective: 'Review X', created_at: '2026-11-18T20:00:00Z', updated_at: '2026-11-18T20:00:00Z' },
      { id: 'run_ext2', objective: 'Research Y', created_at: '2026-11-18T20:05:00Z', updated_at: '2026-11-18T20:05:00Z' }
    ],
    tasks: [
      { id: 'task_e1', runId: 'run_ext1', title: 'Review X', status: 'dispatched', deps: [], result: null, creator: 'sess_main', created_at: '2026-11-18 20:00:00' },
      { id: 'task_e1b', runId: 'run_ext1', title: 'Review X, round 2', status: 'completed', deps: [], result: null, creator: 'sess_main', created_at: '2026-11-18 20:10:00', completed_at: '2026-11-18T20:12:00Z' },
      { id: 'task_gate', runId: 'run_ext1', title: 'Decision', status: 'blocked', deps: [], result: null, created_at: '2026-11-18 20:13:00' },
      { id: 'task_e2', runId: 'run_ext2', title: 'Research Y', status: 'completed', deps: [], result: '{"body":"Done"}' }
    ],
    worktrees: [{ path: workspace, agents: [
      { orcaSessionId: 'sess_main', paneKey: 'pane_main', conversationName: 'Coordinator', agentType: 'claude', state: 'working', subagentObservation: 'live', children: [{ kind: 'command', description: 'Wait for workers', state: 'working' }] },
      { orcaSessionId: 'sess_child', paneKey: 'pane_child', parentPaneKey: 'pane_main', conversationName: 'Review X', agentType: 'claude', state: 'blocked' },
      { orcaSessionId: 'sess_worker', paneKey: 'pane_worker', conversationName: 'Finished worker', agentType: 'claude', state: 'done' }
    ] }],
    workers: [
      { dispatchId: 'ctx_e1', taskId: 'task_e1', runId: 'run_ext1', state: 'ready', liveness: 'live', agent: 'claude/claude-opus-5-5', workspace: 'repo1::' + workspace, dispatchedAt: '2026-11-18 20:00:05', assignee: 'sess_worker' },
      { dispatchId: 'ctx_e1b', taskId: 'task_e1b', runId: 'run_ext1', state: 'succeeded', liveness: 'exited', agent: null, workspace: 'repo1::' + workspace, dispatchedAt: '2026-11-18 20:10:05', followUpOf: 'ctx_e1' },
      { dispatchId: 'ctx_e2', taskId: 'task_e2', runId: 'run_ext2', state: 'succeeded', liveness: 'exited', agent: null, workspace: 'repo2::' + other, launch: { agent: 'codex', model: 'gpt-6.2-sol', effort: 'high' } }
    ]
  }))
  world.agents = [{ terminalId: 'term_rev', title: 'reviewer', agent: 'claude', state: 'blocked', stateStartedAt: 1, task: { title: 'Review X' } }]
  const mounted = await mountWorker(worker, { host })

  const here = await settled(() => mounted.request('state.get', {}))
  assertPlainJson(here)
  assert.equal(here.following, true)
  assert.equal(here.workspaceId, 'repo1::' + workspace)
  // run_ext1 was dispatched by the conversation sess_main of this workspace: it belongs to it and is not listed on its own.
  assert.deepEqual(here.orcaRuns.map((run) => run.id), [])
  assert.deepEqual(here.sessions.map((session) => [session.id, session.parentPaneKey ?? null, session.state, session.children.length, session.runIds ?? null, session.agents ?? 0, session.isWorker ?? false]),
    [['sess_main', null, 'working', 1, ['run_ext1'], 2, false], ['sess_child', 'pane_main', 'blocked', 0, null, 0, false], ['sess_worker', null, 'done', 0, null, 0, true]])
  const conversation = await mounted.request('session.view', { sessionId: 'sess_main', runIds: ['run_ext1'] })
  assertPlainJson(conversation)
  assert.deepEqual(conversation.agents.map((agent) => [agent.id, agent.model ?? null]), [['task_e1b', 'claude-opus-5-5'], ['task_e1', 'claude-opus-5-5']], 'the follow-up inherits the model; the gate is not an agent')
  assert.equal(conversation.agents.length, here.sessions[0].agents, 'the Agents tab and the list entry count the same agents')
  assert.equal(conversation.agents.find((agent) => agent.id === 'task_e1')!.startedAt, Date.parse('2026-11-18T20:00:05Z'))
  assert.ok(conversation.events.some((event) => event.kind === 'gate' && event.title === 'Decision'), 'the pending gate is on the conversation timeline')
  assert.ok(conversation.events.some((event) => event.kind === 'started' && event.title === 'Review X' && /claude-opus-5-5/.test(event.detail ?? '')), JSON.stringify(conversation.events))
  const nobody = await mounted.request('session.view', { sessionId: 'sess_other', runIds: ['run_ext1'] })
  assert.deepEqual(nobody.agents, [], 'agents of another conversation are not shown')

  const { nodes } = await mounted.request('orca.run', { runId: 'run_ext1' })
  assertPlainJson(nodes)
  assert.equal(nodes[0].model, 'claude-opus-5-5')
  assert.equal(nodes[0].live?.state, 'blocked')
  assert.equal(nodes[0].live?.terminalId, 'term_rev')

  assert.deepEqual(await mounted.request('agent.show', { terminalId: 'term_rev' }), { shown: 'terminal' })
  assert.deepEqual(host.callsOf('terminal.focus'), [{ terminalId: 'term_rev' }])
  assert.deepEqual(await mounted.request('agent.show', { workspacePath: other }), { shown: 'workspace' })
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'repo2::' + other }])

  world.focus = { workspaceId: 'repo2::' + other, branch: 'feature', displayName: 'other', terminals: [] }
  const there = await mounted.request('state.get', {})
  assert.equal(there.workspaceId, 'repo2::' + other)
  assert.deepEqual(there.orcaRuns.map((run) => [run.id, run.active]), [['run_ext2', false]])
  assert.deepEqual(there.playbooks, [])
  assert.deepEqual(there.sessions, [], 'sessions belong to their own workspace')
  const finished = (await mounted.request('orca.run', { runId: 'run_ext2' })).nodes[0]
  assert.equal(finished.model, 'gpt-6.2-sol', 'model comes from worker-show once worker-list dropped the agent')
  assert.equal(finished.effort, 'high')
  assert.equal(finished.live, undefined, 'a finished task never takes a live agent')

  // A Run whose first worker starts after the index was read still shows up (Orca never moves updated_at).
  const seeded = JSON.parse(readFileSync(process.env.FAKE_ORCA_STATE!, 'utf8'))
  seeded.workers.push({ dispatchId: 'ctx_e3', taskId: 'task_e2', runId: 'run_ext2', state: 'ready', liveness: 'live', agent: 'claude/claude-opus-5-5', workspace: 'repo1::' + workspace })
  writeFileSync(process.env.FAKE_ORCA_STATE!, JSON.stringify(seeded))
  await new Promise((resolve) => setTimeout(resolve, 50))
  world.focus = { workspaceId: 'repo1::' + workspace, branch: 'main', displayName: 'demo', terminals: [] }
  let later = await mounted.request('state.get', {})
  for (let i = 0; i < 100 && !later.orcaRuns.some((run) => run.id === 'run_ext2'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    later = await mounted.request('state.get', {})
  }
  assert.ok(later.orcaRuns.some((run) => run.id === 'run_ext2' && run.active), JSON.stringify(later.orcaRuns))

  const pinned = await mounted.request('state.get', { workspaceId: 'repo1::' + workspace })
  assert.equal(pinned.following, false)
  assert.equal(pinned.workspaceId, 'repo1::' + workspace)

  world.focus = null
  const unknown = await mounted.request('state.get', {})
  assert.equal(unknown.following, false)
  assert.equal(unknown.workspaceId, 'repo1::' + workspace, 'falls back to the first workspace with playbooks')
  assert.deepEqual(mounted.refusals, [])
})

test('the first state.get does not wait for a slow first read of Orca Runs; index.ready follows once', async () => {
  const { host } = setup()
  process.env.FAKE_ORCA_SLOW_RUN_LIST_MS = '3000'
  const mounted = await mountWorker(worker, { host })
  const first = await mounted.request('state.get', {})
  assertPlainJson(first)
  assert.equal(first.indexing, true, 'answered while run-list was still sleeping')
  const later = await settled(() => mounted.request('state.get', {}))
  assert.equal(later.indexing, false)
  // Later reads of the index (every 200 ms here) do not post it again.
  await new Promise((resolve) => setTimeout(resolve, 3500))
  await mounted.request('state.get', {})
  assert.equal(mounted.posts.filter((post) => post.event === 'index.ready').length, 1, JSON.stringify(mounted.posts))
})

test('a failed first read of Orca Runs ends indexing instead of promising agents', async () => {
  const { host } = setup()
  process.env.FAKE_ORCA_FAIL_RUN_LIST = '1'
  const mounted = await mountWorker(worker, { host })
  const answer = await settled(() => mounted.request('state.get', {}))
  assert.equal(answer.indexing, false)
  assert.deepEqual(answer.orcaRuns, [])
})

test('gate answers: only ok or revise[: comment] count, popraw as the legacy name of revise', () => {
  assert.deepEqual(parseResolution('OK'), { choice: 'ok', comment: '' })
  assert.deepEqual(parseResolution('revise: consider: the hour'), { choice: 'revise', comment: 'consider: the hour' })
  assert.deepEqual(parseResolution('popraw: shorter'), { choice: 'revise', comment: 'shorter' })
  assert.equal(parseResolution('okay'), undefined)
  assert.equal(parseResolution('approve'), undefined)
})

test('a failed worker-start fails the step once and is not retried', async () => {
  const { host } = setup()
  process.env.FAKE_ORCA_FAIL_WORKER = '1'
  const mounted = await mountWorker(worker, { host })
  const state = await mounted.request('state.get', {})
  const { run } = await mounted.request('run.start', { workspaceId: state.workspaceId!, file: 'weather.yaml' })
  const read = async () => (await mounted.request('state.get', {})).runs.find((candidate) => candidate.id === run.id)!
  const failed = await until(read, (current) => current.status === 'failed')
  assert.match(failed.tasks.plan.error ?? '', /Worker start failed: .*agent_readiness/)
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(calls().filter((call) => call[1] === 'worker-start').length, 1)
  assert.equal((await read()).status, 'failed')
})

test('an answer other than ok/revise from the CLI opens a new gate instead of rejecting', async () => {
  const { host } = setup()
  const mounted = await mountWorker(worker, { host })
  const state = await mounted.request('state.get', {})
  const { run } = await mounted.request('run.start', { workspaceId: state.workspaceId!, file: 'weather.yaml' })
  const read = async () => (await mounted.request('state.get', {})).runs.find((candidate) => candidate.id === run.id)!
  const waiting = await until(read, (current) => current.status === 'waiting')
  const first = waiting.tasks.decision.gateId!
  execFileSync(process.env.ORCA_CLI_COMMAND!, ['orchestration', 'gate-resolve', '--id', first, '--resolution', 'okay', '--json'])
  const asked = await until(read, (current) => current.tasks.decision.gateId !== first)
  assert.equal(asked.status, 'waiting')
  assert.equal(asked.loops, 0)
  assert.match(asked.tasks.decision.error ?? '', /"okay" is neither "ok"/)
  const ok = (await mounted.request('gate.resolve', { runId: run.id, stepId: 'decision', choice: 'ok' })).run
  assert.equal(ok.status, 'done')
  assert.equal(ok.tasks.decision.error, undefined)
})

test('a revise with no loops left stops the run (also under the legacy name popraw)', async () => {
  const { host } = setup()
  const mounted = await mountWorker(worker, { host })
  const state = await mounted.request('state.get', {})
  const { run } = await mounted.request('run.start', { workspaceId: state.workspaceId!, file: 'weather.yaml' })
  const read = async () => (await mounted.request('state.get', {})).runs.find((candidate) => candidate.id === run.id)!
  await until(read, (current) => current.status === 'waiting')
  await mounted.request('gate.resolve', { runId: run.id, stepId: 'decision', choice: 'revise', comment: 'once' })
  await until(read, (current) => current.status === 'waiting' && current.tasks.decision.attempt === 2)
  const stopped = (await mounted.request('gate.resolve', { runId: run.id, stepId: 'decision', choice: 'popraw', comment: 'twice' })).run
  assert.equal(stopped.status, 'rejected')
  assert.equal(stopped.loops, 1)
})
