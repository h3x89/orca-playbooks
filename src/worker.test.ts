// End to end through the worker with a fake `orca` CLI (test/fake-orca.mjs): scripts, an agent
// step, the gate, a revise loop from the panel and the final OK given from the CLI.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as worker from './worker'
import { localNow, parseResolution, scriptOutput } from './worker'
import YAML from '../vendor/yaml/index.js'
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
    FAKE_ORCA_REPORTS: '',
    FAKE_ORCA_SLOW_RUN_LIST_MS: '',
    FAKE_ORCA_FAIL_RUN_LIST: '',
    FAKE_ORCA_HOST_VERSION: ''
  })
  const other = path.join(dir, 'other')
  mkdirSync(other)
  const world = {
    focus: { workspaceId: 'repo1::' + workspace, branch: 'main', displayName: 'demo', terminals: [] } as Record<string, unknown> | null,
    localJournalPath: '',
    experimentalOpenChat: false,
    agents: [] as { terminalId: string | null; title: string | null; agent: string | null; state: string; stateStartedAt: number; task?: { title: string } | null }[]
  }
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [
        { id: 'repo1::' + workspace, kind: 'worktree', name: 'demo', projectId: 'project-a', project: 'Repository A', path: workspace, branch: 'main', hostId: 'local' },
        { id: 'repo2::' + other, kind: 'worktree', name: 'other', projectId: 'project-b', project: 'Repository B', path: other, branch: 'feature', hostId: 'local' }
      ], truncated: false },
      'workspace.readContext': () => world.focus,
      'agents.list': () => ({ agents: world.agents }),
      'settings.get': () => ({ settings: { localJournalPath: world.localJournalPath, experimentalOpenChat: world.experimentalOpenChat } }),
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

test('chat navigation is opt-in and refuses an untested Orca version', async () => {
  const { host, world } = setup()
  const mounted = await mountWorker(worker, { host })
  const input = { runId: 'run_fixture', taskId: 'task_fixture' }
  await assert.rejects(mounted.request('step.openChat', input), /experimental chat navigation is off/i)
  assert.ok(!existsSync(process.env.FAKE_ORCA_LOG!) || calls().every((call) => call[0] !== 'status'))

  world.experimentalOpenChat = true
  process.env.FAKE_ORCA_HOST_VERSION = '1.4.275'
  await assert.rejects(mounted.request('step.openChat', input), /requires desktop Orca 1.4.274 on Linux/)
  if (process.platform === 'linux') assert.ok(calls().some((call) => call[0] === 'status'))
})

test('runs scripts, the agent and the gate, loops on revise and finishes on an OK from the CLI', async () => {
  const { workspace, host } = setup()
  const weatherScript = path.join(workspace, '.orca', 'playbooks', 'scripts', 'weather.sh')
  writeFileSync(weatherScript, 'while [ ! -f proceed ]; do sleep 0.05; done\n' + readFileSync(weatherScript, 'utf8'))
  const mounted = await mountWorker(worker, { host })
  const state = await mounted.request('state.get', {})
  assertPlainJson(state)
  assert.equal(state.playbooks.length, 1)
  assert.deepEqual(state.playbooks[0].errors, [])

  const { run } = await mounted.request('run.start', { workspaceId: state.workspaceId!, file: 'weather.yaml' })
  assert.ok(existsSync(path.join(workspace, '.orca', 'runs', '.gitignore')))
  const read = async () => (await mounted.request('state.get', {})).runs.find((candidate) => candidate.id === run.id)!

  try {
    const active = await until(read, (current) => current.tasks.weather.status === 'dispatched')
    const { events } = await mounted.request('run.timeline', { runId: run.id })
    const running = events.find((event) => event.taskId === active.tasks.weather.taskId && event.kind === 'started')
    assert.ok(running, 'a running script has a start event before its report is written')
    assert.equal(running.spanStart, running.at)
    assert.equal(running.spanEnd, undefined)
  } finally {
    writeFileSync(path.join(run.runDir, 'proceed'), '')
  }

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
  assert.match(respec[respec.indexOf('--spec') + 1], /Operator comment from the decision gate \(address it\): consider the time of day/)

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
  assert.ok(events.some((event) => event.kind === 'sent-back' && event.attempt === 1), 'Revise is recorded separately from a failure')
  const titles = calls().filter((call) => call[1] === 'task-create').map((call) => call[call.indexOf('--task-title') + 1])
  assert.ok(titles.every((title) => / · run_\d+#[12]$/.test(title)), titles.join(', '))
})

test('a configured local journal supplies first-prompt metadata to the panel', async () => {
  const { workspace, host, world } = setup()
  const sessionId = '00000000-0000-0000-0000-000000000001'
  const timestamp = Date.parse('2026-11-22T21:44:51Z')
  writeFileSync(process.env.FAKE_ORCA_STATE!, JSON.stringify({
    n: 0, plans: 0, gates: [], runs: [], tasks: [], workers: [], messages: [],
    worktrees: [{ path: workspace, agents: [{ orcaSessionId: sessionId, paneKey: 'demo' }] }]
  }))
  const database = path.join(dir, 'agent-session-domain.db')
  execFileSync('sqlite3', ['-batch', '-init', os.devNull, database, `
    CREATE TABLE journal_chat_state (session_id TEXT, epoch TEXT, retained_sequence INT);
    CREATE TABLE journal_items (session_id TEXT, epoch TEXT, item_id TEXT, kind TEXT, message_role TEXT, root INT, command_entry INT, ordinal INT);
    CREATE TABLE journal_submission_attempts (session_id TEXT, epoch TEXT, item_id TEXT,
      submitted_at INT, admitted_personal INT, dispatch_state TEXT, current INT, request_failure INT, ordinal INT);
    INSERT INTO journal_chat_state VALUES ('${sessionId}', 'now', 0);
    INSERT INTO journal_items VALUES ('${sessionId}', 'now', 'prompt', 'message', 'user', 1, 0, 0);
    INSERT INTO journal_submission_attempts VALUES ('${sessionId}', 'now', 'prompt', ${timestamp}, 1, 'accepted', 1, 0, 0);
  `])
  const mounted = await mountWorker(worker, { host })
  const firstPrompt = async () => (await mounted.request('state.get', {})).sessions[0].firstPromptAt
  assert.equal(await firstPrompt(), undefined)
  world.localJournalPath = database
  assert.equal(await firstPrompt(), timestamp)
  world.localJournalPath = ''
  assert.equal(await firstPrompt(), undefined, 'disabling the setting drops the cached result')
})

test('follows the focused workspace and shows the other Orca Runs that worked there as a graph', async () => {
  const { workspace, other, host, world } = setup()
  const reviewer = '00000000-0000-0000-0000-000000000001'
  const retry = '00000000-0000-0000-0000-000000000002'
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
      { orcaSessionId: reviewer, paneKey: 'pane_worker', conversationName: 'Finished worker', agentType: 'claude', state: 'done' }
    ] }],
    workers: [
      { dispatchId: 'ctx_e1_retry', taskId: 'task_e1b', runId: 'run_ext1', state: 'succeeded', workspace: 'repo1::' + workspace,
        dispatchedAt: '2026-11-18 20:11:05', assignee: retry },
      { dispatchId: 'ctx_e1', taskId: 'task_e1', runId: 'run_ext1', state: 'ready', liveness: 'live', agent: 'claude/claude-opus-5-5', workspace: 'repo1::' + workspace, dispatchedAt: '2026-11-18 20:00:05', assignee: reviewer },
      { dispatchId: 'ctx_e1b', taskId: 'task_e1b', runId: 'run_ext1', state: 'succeeded', liveness: 'exited', agent: null, workspace: 'repo1::' + workspace, dispatchedAt: '2026-11-18 20:10:05', completedAt: '2026-11-18T20:10:45Z', followUpOf: 'ctx_e1', assignee: reviewer, assigneePaneKey: `structured-agent-session-${reviewer}:pane` },
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
    [['sess_main', null, 'working', 1, ['run_ext1'], 1, false], ['sess_child', 'pane_main', 'blocked', 0, null, 0, false], [reviewer, null, 'done', 0, null, 0, true]])
  const conversation = await mounted.request('session.view', { sessionId: 'sess_main', runIds: ['run_ext1'] })
  assertPlainJson(conversation)
  assert.deepEqual(conversation.agents.map((agent) => [agent.id, agent.model ?? null]), [['task_e1b', 'claude-opus-5-5'], ['task_e1', 'claude-opus-5-5']], 'the follow-up inherits the model; the gate is not an agent')
  assert.deepEqual(conversation.agents.map((agent) => agent.workerSessionId), [reviewer, reviewer], 'both displayed dispatches belong to the original reviewer, not its later retry')
  assert.ok(conversation.events.some((event) => event.kind === 'follow-up' && event.taskId === 'task_e1b'))
  assert.equal(conversation.agents[0].dispatchId, 'ctx_e1b', 'the session identity and displayed round both come from the same dispatch')
  assert.equal(conversation.agents[0].endedAt, Date.parse('2026-11-18T20:10:45Z'), 'the end time belongs to the same dispatch as its start')
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
  process.env.FAKE_ORCA_SLOW_RUN_LIST_MS = '2500'
  const mounted = await mountWorker(worker, { host })
  const first = await mounted.request('state.get', {})
  assertPlainJson(first)
  assert.equal(first.indexing, true, 'answered while run-list was still sleeping')
  const later = await settled(() => mounted.request('state.get', {}))
  assert.equal(later.indexing, false)
  // A second read of the index (older than 200 ms here, started by state.get) ends without posting it again.
  const reads = () => calls().filter((call) => call[1] === 'run-list').length
  await new Promise((resolve) => setTimeout(resolve, 300))
  await mounted.request('state.get', {})
  // The fake CLI logs a call once its process runs; give it a moment.
  for (let i = 0; i < 40 && reads() < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(reads() >= 2, 'a second read started')
  await new Promise((resolve) => setTimeout(resolve, 3000))
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

test('Weather research retains both reports across Revise and publishes after approval', async () => {
  const { workspace, host } = setup()
  const books = path.join(workspace, '.orca', 'playbooks')
  const example = new URL('../examples/.orca/playbooks/', import.meta.url)
  for (const file of ['weather-research.yaml', 'scripts/weather-summary.py']) {
    writeFileSync(path.join(books, file), readFileSync(new URL(file, example)))
  }
  const research = { 'forecast.md': '18°C, 10% chance of rain', 'air.md': 'EAQI 25' }
  process.env.FAKE_ORCA_REPORTS = JSON.stringify({
    ...research, 'plan.md': 'Plan for a walk', 'review.md': 'BLOCK\nName a duration.'
  })
  const mounted = await mountWorker(worker, { host })
  const state = await mounted.request('state.get', {})
  const { run } = await mounted.request('run.start', { workspaceId: state.workspaceId!, file: 'weather-research.yaml' })
  const read = async () => (await mounted.request('state.get', {})).runs.find((candidate) => candidate.id === run.id)!
  const first = await until(read, (current) => current.status === 'waiting')
  assert.match(first.tasks.summary.output ?? '', /18°C.*\n\nEAQI 25/)
  assert.match(first.tasks.review.output ?? '', /^BLOCK/)
  assert.equal(first.tasks.finish.status, 'pending')
  assert.equal(calls().filter((call) => call[1] === 'worker-start').length, 4)

  const comment = 'Make it a 20-minute walk.'
  process.env.FAKE_ORCA_REPORTS = JSON.stringify({
    ...research, 'plan.md': '20-minute walk at 18°C, 10% chance of rain and EAQI 25.', 'review.md': 'PASS\nAll sample values are cited.'
  })
  const revised = (await mounted.request('gate.resolve', { runId: run.id, stepId: 'decision', choice: 'revise', comment })).run
  assert.equal(revised.tasks.forecast.taskId, first.tasks.forecast.taskId)
  assert.equal(revised.tasks.air.taskId, first.tasks.air.taskId)
  assert.equal(revised.tasks.summary.taskId, first.tasks.summary.taskId)
  assert.equal(revised.tasks.review.attempt, 2)
  const second = await until(read, (current) => current.status === 'waiting' && current.tasks.decision.attempt === 2)
  assert.match(second.tasks.review.output ?? '', /^PASS/)
  const earlier = readdirSync(run.runDir).find((name) => name.startsWith('prior-plan-'))
  assert.ok(earlier)
  assert.match(readFileSync(path.join(run.runDir, earlier, 'plan-for-review.md'), 'utf8'), /Plan for a walk/)
  assert.match(readFileSync(path.join(run.runDir, earlier, 'review.md'), 'utf8'), /^BLOCK/)
  const planTasks = calls().filter((call) => call[1] === 'task-create' && call.includes('Draft a plan for a walk'))
  assert.equal(planTasks.length, 2)
  assert.ok(planTasks[1].some((argument) => argument.includes(comment)))
  assert.equal(calls().filter((call) => call[1] === 'worker-start').length, 6)

  await mounted.request('gate.resolve', { runId: run.id, stepId: 'decision', choice: 'ok' })
  const completed = await until(read, (current) => current.status === 'done')
  assert.match(completed.tasks.finish.output ?? '', /20-minute walk at 18°C/)
})

test('the ASDLC example stops on BLOCK and deploys the verified copy on PASS', async () => {
  const { workspace, host } = setup()
  const example = new URL('../examples/asdlc/', import.meta.url)
  const books = path.join(workspace, '.orca', 'playbooks')
  const scripts = path.join(books, 'scripts')
  for (const name of ['duration.py', 'test_duration.py', '.gitignore']) {
    writeFileSync(path.join(workspace, name), readFileSync(new URL(name, example)))
  }
  writeFileSync(path.join(scripts, 'check.py'), readFileSync(new URL('.orca/playbooks/scripts/check.py', example)))
  execFileSync('git', ['init', '-q'], { cwd: workspace })

  writeFileSync(path.join(scripts, 'review.py'), [
    'import hashlib, json, os',
    'from pathlib import Path',
    'root = Path(os.environ["PLAYBOOK_RUN_DIR"])',
    'is_plan = os.environ["PLAYBOOK_STEP"] == "review-plan"',
    'subject = root / ("plan.md" if is_plan else "candidate.json")',
    'if is_plan: subject.write_text("Change only duration.py")',
    'verdict = os.environ["PLAYBOOK_INPUT_VERDICT"] if is_plan else "PASS"',
    'review = {"verdict": verdict, "subject_sha256": hashlib.sha256(subject.read_bytes()).hexdigest(), "reason": "Test report"}',
    '(root / ("review-plan.md" if is_plan else "review-deploy.md")).write_text(json.dumps(review))'
  ].join('\n'))
  writeFileSync(path.join(scripts, 'fix.py'), [
    'from pathlib import Path',
    'code = Path(__file__).resolve().parents[3] / "duration.py"',
    'code.write_text(code.read_text().replace("* 100", "* 60"))'
  ].join('\n'))

  for (const verdict of ['BLOCK', 'PASS']) {
    writeFileSync(path.join(books, verdict.toLowerCase() + '.yaml'), [
      `title: ASDLC ${verdict}`,
      `inputs: {verdict: {default: ${verdict}}}`,
      'steps:',
      '  - {id: reproduce, script: {run: check.py}}',
      '  - {id: review-plan, needs: [reproduce], script: {run: review.py}}',
      '  - {id: verify-plan, needs: [review-plan], script: {run: check.py}}',
      '  - {id: fix, needs: [verify-plan], script: {run: fix.py}}',
      '  - {id: verify-candidate, needs: [fix], script: {run: check.py}}',
      '  - {id: review-deploy, needs: [verify-candidate], script: {run: review.py}}',
      '  - {id: deploy, needs: [review-deploy], script: {run: check.py}}'
    ].join('\n'))
  }
  execFileSync('git', ['add', '.'], { cwd: workspace })

  const mounted = await mountWorker(worker, { host })
  const state = await mounted.request('state.get', {})
  async function run(file: string) {
    const { run: started } = await mounted.request('run.start', { workspaceId: state.workspaceId!, file })
    const read = async () => (await mounted.request('state.get', {})).runs.find((item) => item.id === started.id)!
    return until(read, (item) => item.status === 'done' || item.status === 'failed')
  }

  const blocked = await run('block.yaml')
  assert.equal(blocked.status, 'failed')
  assert.equal(blocked.tasks['verify-plan'].status, 'failed')
  assert.equal(blocked.tasks.fix.status, 'pending')
  assert.equal(existsSync(path.join(blocked.runDir, 'deploy')), false)

  const passed = await run('pass.yaml')
  assert.equal(passed.status, 'done')
  assert.match(passed.tasks.deploy.output ?? '', /2 minutes = 120 seconds/)
  assert.match(readFileSync(path.join(passed.runDir, 'deploy', 'duration.py'), 'utf8'), /minutes \* 60/)
})

test('rejects an invalid ticket before creating a run and keeps two input sets separate', async () => {
  const { workspace, host } = setup()
  const books = path.join(workspace, '.orca', 'playbooks')
  const source = [
    'inputs:',
    '  ticket: { label: Ticket, required: true, format: ticket }',
    'steps:',
    '  - { id: report, script: { run: report.sh } }'
  ].join('\n')
  for (const file of ['first.yaml', 'second.yaml']) writeFileSync(path.join(books, file), source)
  writeFileSync(path.join(books, 'scripts', 'report.sh'), 'printf "%s\\n" "$PLAYBOOK_INPUT_TICKET"')
  const mounted = await mountWorker(worker, { host })
  const state = await mounted.request('state.get', {})
  const target = { workspaceId: state.workspaceId!, file: 'first.yaml' }
  await assert.rejects(mounted.request('run.start', { ...target, inputs: {} }), /Ticket is required/)
  await assert.rejects(mounted.request('run.start', { ...target, inputs: { ticket: 'bad' } }), /DEMO-123/)
  assert.equal(existsSync(path.join(workspace, '.orca', 'runs')), false)
  assert.equal(calls().some((call) => call[1] === 'run-create'), false)

  const first = (await mounted.request('run.start', { ...target, inputs: { ticket: 'DEMO-123' } })).run
  const second = (await mounted.request('run.start', { ...target, file: 'second.yaml', inputs: { ticket: 'DEMO-456' } })).run
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.runDir, second.runDir)
  for (const [run, ticket] of [[first, 'DEMO-123'], [second, 'DEMO-456']] as const) {
    const read = async () => (await mounted.request('state.get', {})).runs.find((entry) => entry.id === run.id)!
    const completed = await until(read, (entry) => entry.status === 'done')
    assert.equal(completed.inputs.ticket, ticket)
    assert.equal(completed.tasks.report.output, ticket)
  }
})

test('keeps free-form text in one CLI option when it begins with a hyphen', async () => {
  const { workspace, host } = setup()
  writeFileSync(path.join(workspace, '.orca', 'playbooks', 'labels.yaml'), YAML.stringify({
    steps: [
      { id: 'report', title: '--draft report', script: { run: 'air.sh' } },
      { id: 'decision', needs: ['report'], gate: { question: '--ready for approval?' } }
    ]
  }))
  const mounted = await mountWorker(worker, { host })
  const state = await mounted.request('state.get', {})
  const { run } = await mounted.request('run.start', { workspaceId: state.workspaceId!, file: 'labels.yaml' })
  const read = async () => (await mounted.request('state.get', {})).runs.find((entry) => entry.id === run.id)!
  await until(read, (entry) => entry.status === 'waiting')
  assert.ok(calls().some((call) => call[1] === 'task-create' && call.includes('--display-name=--draft report')))
  assert.ok(calls().some((call) => call[1] === 'gate-create' && call.includes('--question=--ready for approval?')))
})

test('lists saved playbooks by workspace and all open decisions across repositories', async () => {
  const { workspace, other, host } = setup()
  const file = 'decisions.yaml'
  const definitions = { title: 'Ticket choices', steps: [
    { id: 'approval', title: 'Approve the plan', gate: { question: 'Approve?' } },
    { id: 'review', title: 'Review the result', gate: { question: 'Accept?' } }
  ], inputs: { ticket: { required: true, format: 'ticket' } } }
  for (const root of [workspace, other]) {
    const books = path.join(root, '.orca', 'playbooks')
    mkdirSync(books, { recursive: true })
    writeFileSync(path.join(books, file), YAML.stringify(definitions))
  }
  writeFileSync(path.join(other, '.orca', 'playbooks', 'invalid.yaml'), 'title: Missing steps')
  const mounted = await mountWorker(worker, { host })
  const { entries } = await mounted.request('catalog.list', {})
  assertPlainJson(entries)
  assert.deepEqual(entries.map((entry) => [entry.workspace.projectId, entry.workspace.projectName]), [
    ['project-a', 'Repository A'], ['project-b', 'Repository B']
  ])
  assert.match(entries[1].playbooks.find((book) => book.file === 'invalid.yaml')?.errors[0] ?? '', /steps/)
  const primary = await mounted.request('state.get', {})
  assert.equal(calls().some((call) => call[1] === 'run-create'), false)
  const first = (await mounted.request('run.start', { workspaceId: primary.workspaceId!, file, inputs: { ticket: 'DEMO-123' } })).run
  const second = (await mounted.request('run.start', { workspaceId: primary.workspaces[1].id, file, inputs: { ticket: 'DEMO-456' } })).run
  const read = () => mounted.request('state.get', { workspaceId: primary.workspaceId! })
  await until(async () => (await read()).runs.find((run) => run.id === first.id)!,
    (run) => !!run.tasks.approval.gateId && !!run.tasks.review.gateId)
  await until(async () => (await mounted.request('state.get', { workspaceId: second.workspaceId })).runs.find((run) => run.id === second.id)!,
    (run) => !!run.tasks.approval.gateId && !!run.tasks.review.gateId)
  const open = (await read()).waitingDecisions
  assert.deepEqual(open.map(({ runId, stepId, ticket }) => [runId, stepId, ticket]), [
    [second.id, 'approval', 'DEMO-456'], [second.id, 'review', 'DEMO-456'],
    [first.id, 'approval', 'DEMO-123'], [first.id, 'review', 'DEMO-123']
  ])
  await mounted.request('gate.resolve', { runId: second.id, stepId: 'review', choice: 'ok' })
  assert.equal((await read()).waitingDecisions.length, 3)
  assert.equal((await read()).waitingDecisions.some((entry) => entry.runId === second.id && entry.stepId === 'review'), false)
})

test('the generated BPMN graph keeps the revision loop and fails closed on BLOCK', async () => {
  const { workspace, host } = setup()
  const example = new URL('../examples/asdlc/', import.meta.url)
  const compiler = fileURLToPath(new URL('../tools/bpmn-to-orca.py', import.meta.url))
  const diagram = fileURLToPath(new URL('process.bpmn', example))
  const bindings = fileURLToPath(new URL('orca-bindings.json', example))
  const generated = execFileSync('python3', [compiler, diagram, bindings], { encoding: 'utf8' })
  const compiled = YAML.parse(generated)
  const reference = YAML.parse(readFileSync(new URL('.orca/playbooks/review-gated-fix.yaml', example), 'utf8'))
  assert.deepEqual(compiled, reference, 'all definitions, graph dependencies and bindings come through')
  const invalid = path.join(workspace, 'unsupported.bpmn')
  const model = readFileSync(diagram, 'utf8')
  const rejects = (source: string, reason: RegExp) => {
    assert.notEqual(source, model, 'negative fixture must actually change the model')
    writeFileSync(invalid, source)
    assert.throws(() => execFileSync('python3', [compiler, invalid, bindings], { stdio: 'pipe' }), reason)
  }
  rejects(model.replace('<bpmn:documentation>', '<bpmn:receiveTask id="unsupported-lab-node"/><bpmn:documentation>'),
    /Unsupported element unsupported-lab-node/)
  rejects(model.replace('<bpmn:incoming>flow-2</bpmn:incoming>',
    '<bpmn:multiInstanceLoopCharacteristics/><bpmn:incoming>flow-2</bpmn:incoming>'),
    /unsupported multiInstanceLoopCharacteristics/)
  rejects(model.replace(/<bpmn:parallelGateway id="join"[^>]*>[\s\S]*?<\/bpmn:parallelGateway>/,
    (join) => join.replaceAll('parallelGateway', 'exclusiveGateway')), /merging multiple exclusive paths is unsupported/)

  const books = path.join(workspace, '.orca', 'playbooks')
  const scripts = path.join(books, 'scripts')
  for (const name of ['duration.py', 'test_duration.py', '.gitignore']) {
    writeFileSync(path.join(workspace, name), readFileSync(new URL(name, example)))
  }
  writeFileSync(path.join(scripts, 'check.py'), readFileSync(new URL('.orca/playbooks/scripts/check.py', example)))
  writeFileSync(path.join(scripts, 'fixture.py'), [
    'import hashlib, json, os',
    'from pathlib import Path',
    'root = Path(os.environ["PLAYBOOK_RUN_DIR"])',
    'step = os.environ["PLAYBOOK_STEP"]',
    'if step == "plan":',
    '    (root / "plan.md").write_text("Change only duration.py")',
    'elif step in ("review-plan", "review-deploy"):',
    '    subject = root / ("plan.md" if step == "review-plan" else "candidate.json")',
    '    verdict = os.environ["PLAYBOOK_INPUT_VERDICT"] if step == "review-plan" else "PASS"',
    '    report = {"verdict": verdict, "subject_sha256": hashlib.sha256(subject.read_bytes()).hexdigest(), "reason": "Lab fixture"}',
    '    (root / f"{step}.md").write_text(json.dumps(report))',
    'elif step == "fix":',
    '    code = root.parents[2] / "duration.py"',
    '    code.write_text(code.read_text().replace("* 100", "* 60"))',
    'else:',
    '    (root / f"{step}.md").write_text("Research fixture")'
  ].join('\n'))
  const steps = compiled.steps.map((step: Record<string, unknown>) => {
    if (!step.agent) return step
    const { agent, prompt, keep_open, model, effort, ...node } = step
    return { ...node, script: { run: 'fixture.py' } }
  })
  writeFileSync(path.join(books, 'generated.yaml'), YAML.stringify({
    ...compiled, inputs: { verdict: { default: 'PASS' } }, steps
  }))
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  execFileSync('git', ['add', '.'], { cwd: workspace })
  const mounted = await mountWorker(worker, { host })
  const state = await mounted.request('state.get', {})
  const start = async (verdict: string) => {
    const { run } = await mounted.request('run.start', { workspaceId: state.workspaceId!, file: 'generated.yaml', inputs: { verdict } })
    const read = async () => (await mounted.request('state.get', {})).runs.find((entry) => entry.id === run.id)!
    await until(read, (entry) => entry.status === 'waiting')
    return { run, read }
  }
  const blocked = await start('BLOCK')
  await mounted.request('gate.resolve', { runId: blocked.run.id, stepId: 'decide', choice: 'ok' })
  const stopped = await until(blocked.read, (entry) => entry.status === 'failed')
  assert.equal(stopped.tasks['verify-plan'].status, 'failed')
  assert.equal(stopped.tasks.fix.status, 'pending')
  assert.equal(existsSync(path.join(stopped.runDir, 'deploy')), false)

  const passing = await start('PASS')
  const initial = await passing.read()
  const revised = (await mounted.request('gate.resolve', { runId: passing.run.id, stepId: 'decide', choice: 'revise', comment: 'Clarify fixture scope' })).run
  assert.equal(revised.tasks['research-code'].taskId, initial.tasks['research-code'].taskId)
  assert.equal(revised.tasks['research-rules'].taskId, initial.tasks['research-rules'].taskId)
  assert.equal(revised.tasks.plan.attempt, 2)
  await until(passing.read, (entry) => entry.status === 'waiting' && entry.tasks.decide.attempt === 2)
  await mounted.request('gate.resolve', { runId: passing.run.id, stepId: 'decide', choice: 'ok' })
  const done = await until(passing.read, (entry) => entry.status === 'done')
  assert.match(done.tasks.deploy.output ?? '', /2 minutes = 120 seconds/)
})
