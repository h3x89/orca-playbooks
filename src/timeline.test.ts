import { assert, test } from 'orca/testing'
import { buildTimeline, parseTime } from './timeline'
import { sessionsOf } from './worker'

test('times in the three formats Orca writes', () => {
  assert.equal(parseTime('2026-11-18 20:20:30'), Date.parse('2026-11-18T20:20:30Z'))
  assert.equal(parseTime('2026-11-18T20:21:41.143Z'), Date.parse('2026-11-18T20:21:41.143Z'))
  assert.equal(parseTime(1795004373580), 1795004373580)
  assert.equal(parseTime(''), undefined)
  assert.equal(parseTime('soon'), undefined)
})

test('only recorded work spans count, and revisions stay separate from errors', () => {
  const { events, lanes } = buildTimeline([
    { id: 'a', status: 'completed', dispatch_id: 'a1', task_title: 'Research · run_sample#1', completed_at: '2026-11-18T20:00:10Z' },
    { id: 'b', status: 'completed', display_name: 'Other research', dispatch_id: 'b1', completed_at: '2026-11-18T20:00:10Z' },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `old${index}`, status: 'failed', created_at: '2026-11-18T20:00:00Z', completed_at: '2026-11-18T20:00:10Z', result: '{"superseded":true}'
    })),
    { id: 'gate', status: 'failed', created_at: '2026-11-18T20:00:00Z', completed_at: '2026-11-18T20:00:10Z', result: { decision: 'popraw' } },
    { id: 'old-script', status: 'completed', created_at: '2026-11-18T20:00:00Z', completed_at: '2026-11-18T20:00:10Z', result: { file: 'check.txt' } },
    { id: 'script', status: 'failed', task_title: 'Check · run_sample#2', completed_at: '2026-11-18T20:00:12Z', result: {
      script: 'check.py', startedAt: '2026-11-18T20:00:11.430Z', completedAt: '2026-11-18T20:00:12.602Z', error: 'Probe failed'
    } }
  ], [{ task_id: 'gate', created_at: '2026-11-18T20:00:09Z', resolved_at: '2026-11-18T20:00:10Z', resolution: 'revise' }], [], {
    a1: { dispatchedAt: Date.parse('2026-11-18T20:00:03Z') },
    b1: { dispatchedAt: Date.parse('2026-11-18T20:00:04Z') }
  })

  assert.equal(lanes, 2)
  assert.equal(events.filter((event) => event.kind === 'superseded').length, 5)
  assert.equal(events.filter((event) => event.kind === 'sent-back').length, 1)
  assert.ok(events.filter((event) => event.kind === 'superseded' || event.taskId === 'gate' || event.taskId === 'old-script').every((event) => event.lane === undefined))
  const failed = events.filter((event) => event.kind === 'failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].attempt, 2)
  assert.equal(failed[0].duration, 1172)
  assert.equal(failed[0].detail, 'Probe failed')
})

test('a Run becomes events in time order, with durations, reports, gates and lanes for parallel work', () => {
  const { events, lanes } = buildTimeline(
    [
      { id: 't1', status: 'completed', display_name: 'Review A', created_at: '2026-11-18 20:00:00', completed_at: '2026-11-18T20:10:00Z', dispatch_id: 'c1' },
      { id: 't2', status: 'completed', display_name: 'Review B', created_at: '2026-11-18 20:00:00', completed_at: '2026-11-18T20:05:00Z', dispatch_id: 'c2' },
      { id: 't3', status: 'failed', display_name: 'Plan', created_at: '2026-11-18 20:06:00', completed_at: '2026-11-18T20:08:00Z', dispatch_id: 'c3', deps: '["t2"]' },
      { id: 't4', status: 'pending', display_name: 'Decision', created_at: '2026-11-18 20:09:00' }
    ],
    [{ task_id: 't4', question: 'OK?', created_at: '2026-11-18 20:09:30', resolved_at: '2026-11-18 20:12:30', resolution: 'revise: shorter' }],
    [{ type: 'worker_done', subject: 'R1: PASS', created_at: '2026-11-18T20:09:59Z', payload: '{"taskId":"t1"}' }, { type: 'question', subject: 'May I?', created_at: '2026-11-18T20:03:00Z', payload: { taskId: 't2' } }],
    { c1: { dispatchedAt: Date.parse('2026-11-18T20:01:00Z'), agent: 'claude', model: 'claude-opus-5-5' }, c2: { dispatchedAt: Date.parse('2026-11-18T20:01:00Z') }, c3: { dispatchedAt: Date.parse('2026-11-18T20:06:30Z') } }
  )
  const kinds = events.map((event) => `${event.kind}:${event.title}`)
  assert.deepEqual(kinds, [
    'created:Review A', 'created:Review B', 'started:Review A', 'started:Review B', 'question:Review B', 'done:Review B',
    'created:Plan', 'started:Plan', 'failed:Plan', 'created:Decision', 'gate:Decision', 'done:Review A', 'decision:Decision'
  ])
  assert.equal(events.find((event) => event.kind === 'done' && event.title === 'Review A')!.detail, 'R1: PASS', 'the report one second before the end is folded into the end row')
  const startA = events.find((event) => event.kind === 'started' && event.title === 'Review A')!
  assert.equal(startA.detail, 'claude · claude-opus-5-5')
  assert.equal(events.find((event) => event.kind === 'done' && event.title === 'Review A')!.duration, 9 * 60_000, 'from worker start, not task creation')
  assert.equal(events.find((event) => event.kind === 'decision')!.detail, 'revise: shorter')
  assert.equal(events.find((event) => event.kind === 'decision')!.duration, 3 * 60_000)
  assert.equal(events.find((event) => event.kind === 'created' && event.title === 'Plan')!.detail, 'waits for: Review B')
  assert.equal(lanes, 2, 'Plan reuses the lane Review B freed; the open Decision nobody took has no lane')
  assert.equal(events.find((event) => event.kind === 'gate')!.lane, undefined)
  const laneOf = (title: string) => events.find((event) => event.title === title && event.lane !== undefined)!.lane
  assert.notEqual(laneOf('Review A'), laneOf('Review B'))
  assert.equal(laneOf('Plan'), laneOf('Review B'))
})

test('uses final task completion after redispatch and ignores stale completion on an active task', () => {
  const { events, lanes } = buildTimeline([
    { id: 'retried', status: 'completed', dispatch_id: 'first', completed_at: '2026-11-18T20:00:10Z' },
    { id: 'active', status: 'dispatched', dispatch_id: 'live', completed_at: '2026-11-18T20:00:02Z' }
  ], [], [{
    type: 'worker_done', subject: 'Final report', created_at: '2026-11-18T20:00:10Z', payload: { taskId: 'retried' }
  }], {
    first: { dispatchedAt: Date.parse('2026-11-18T20:00:00Z'), completedAt: Date.parse('2026-11-18T20:00:02Z') },
    live: { dispatchedAt: Date.parse('2026-11-18T20:00:04Z') }
  })
  assert.equal(lanes, 2)
  const completed = events.find((event) => event.taskId === 'retried' && event.kind === 'done')!
  assert.equal(completed.at, Date.parse('2026-11-18T20:00:10Z'))
  assert.equal(completed.detail, 'Final report')
  const active = events.find((event) => event.taskId === 'active' && event.kind === 'started')!
  assert.equal(active.spanEnd, undefined)
  assert.notEqual(active.lane, undefined)
})

test("Orca's 'stopped without reporting' escalation is dropped only when the same worker reported after it", () => {
  const task = (id: string, status: string) => ({ id, status, display_name: id, created_at: '2026-11-18 20:00:00', completed_at: '2026-11-18T20:05:00Z', dispatch_id: `d_${id}` })
  const stopped = (taskId: string, dispatchId: string, at: string) => ({ type: 'escalation', subject: 'Worker stopped without reporting', created_at: at, payload: { taskId, dispatchId } })
  const report = (taskId: string, dispatchId: string, at: string) => ({ type: 'worker_done', subject: 'done', created_at: at, payload: JSON.stringify({ taskId, dispatchId }) })
  const { events } = buildTimeline(
    [task('reported', 'completed'), task('never', 'failed'), task('other', 'completed'), task('closed', 'completed'), task('before', 'completed'), task('real', 'completed')],
    [],
    [
      stopped('reported', 'd1', '2026-11-18T20:00:10Z'), report('reported', 'd1', '2026-11-18T20:04:59Z'),
      stopped('never', 'd2', '2026-11-18T20:00:10Z'),
      stopped('other', 'd3', '2026-11-18T20:00:10Z'), report('other', 'd3b', '2026-11-18T20:04:59Z'),
      stopped('closed', 'd4', '2026-11-18T20:00:10Z'),
      report('before', 'd5', '2026-11-18T20:00:05Z'), stopped('before', 'd5', '2026-11-18T20:00:10Z'),
      { type: 'escalation', subject: 'Blocked: no access to the repository', created_at: '2026-11-18T20:01:00Z', payload: { taskId: 'real', dispatchId: 'd6' } },
      report('real', 'd6', '2026-11-18T20:04:59Z')
    ],
    {}
  )
  const kept = events.filter((event) => event.kind === 'escalation').map((event) => event.title).sort()
  // dropped: 'reported' (same dispatch reported later); kept: no report, a report from another dispatch,
  // closed without a report, a report before the escalation, and any other escalation.
  assert.deepEqual(kept, ['before', 'closed', 'never', 'other', 'real'])
})

test('sessions come from a worktree ps row: helpers by parent, children by kind, no crash on missing fields', () => {
  const sessions = sessionsOf({
    agents: [
      { orcaSessionId: 's1', paneKey: 'p1', parentPaneKey: null, conversationName: 'Release notes', agentType: 'claude', state: 'working', stateStartedAt: 1000,
        toolName: 'Bash', toolInput: { command: 'orca worktree ps' }, lastAssistantMessage: 'Waiting for  helpers.', subagentObservation: 'live',
        children: [{ kind: 'command', description: 'Wait for workers', state: 'working', firstObservedAt: 2000 }, { kind: 'agent', description: 'Explore repo' }] },
      { orcaSessionId: 's2', paneKey: 'p2', parentPaneKey: 'p1', taskTitle: 'Review', state: 'done', mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 3000 } },
      {}
    ]
  })
  assert.equal(sessions.length, 3)
  assert.deepEqual([sessions[0].title, sessions[0].agent, sessions[0].tool, sessions[0].lastMessage, sessions[0].subagents], ['Release notes', 'claude', 'Bash', 'Waiting for helpers.', 'live'])
  assert.equal(sessions[0].toolInput, '{"command":"orca worktree ps"}')
  assert.deepEqual(sessions[0].children.map((child) => [child.kind, child.description, child.state ?? null, child.since ?? null]), [['command', 'Wait for workers', 'working', 2000], ['agent', 'Explore repo', null, null]])
  assert.equal(sessions[1].parentPaneKey, 'p1')
  assert.equal(sessions[1].outcome, 'success')
  assert.equal(sessions[1].since, 3000)
  assert.equal(sessions[2].title, 'Session')
  assert.equal(sessions[0].parentPaneKey, undefined)
})

test('orders a whole-second successor after its known subsecond dependency', () => {
  const second = Date.parse('2026-11-25T00:51:16Z')
  const script = { id: 'retest', status: 'completed', result: {
    script: 'check.py', startedAt: second + 162, completedAt: second + 582
  } }
  const review = { id: 'review', status: 'completed', dispatch_id: 'd', deps: ['retest'] }
  const dispatches = { d: { dispatchedAt: second, completedAt: second + 2200 } }
  const dependent = buildTimeline([review, script], [], [], dispatches)
  assert.equal(dependent.lanes, 1)
  assert.equal(dependent.events.find((event) => event.taskId === 'review' && event.kind === 'started')?.at, second + 582)

  const independent = buildTimeline([{ ...review, deps: [] }, script], [], [], dispatches)
  assert.equal(independent.lanes, 2)
  assert.equal(independent.events.find((event) => event.taskId === 'review' && event.kind === 'started')?.at, second)

  const distant = buildTimeline([review, { ...script, result: { ...script.result, completedAt: second + 1582 } }], [], [], dispatches)
  assert.equal(distant.lanes, 2, 'a larger recorded overlap is kept as evidence')
})

test('orders a rounded gate and decision after the review in the same second', () => {
  const second = Date.parse('2026-11-25T04:03:35Z')
  const review = { id: 'review', status: 'completed', result: {
    script: 'review.py', startedAt: second + 315, completedAt: second + 422
  } }
  const decision = { id: 'decide', status: 'completed', deps: ['review'], completed_at: '2026-11-25T04:03:35.790Z' }
  const gate = { task_id: 'decide', status: 'resolved', created_at: '2026-11-25 04:03:35', resolved_at: '2026-11-25 04:03:35', resolution: 'ok' }
  const { events, lanes } = buildTimeline([decision, review], [gate], [], {})
  assert.equal(lanes, 1)
  assert.deepEqual(events.map(({ kind, at }) => [kind, at - second]), [
    ['started', 315], ['done', 422], ['gate', 422], ['decision', 422], ['done', 790]
  ])
  assert.equal(events.find((event) => event.kind === 'decision')?.duration, 0)
  const later = { ...review, result: { ...review.result, completedAt: second + 1422 } }
  const inconsistent = buildTimeline([decision, later], [gate], [], {})
  assert.equal(inconsistent.events.find((event) => event.kind === 'gate')?.at, second)
})
