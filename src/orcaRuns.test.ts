import { assert, test } from 'orca/testing'
import { buildRunGraph, launchOf, resultText, taskDeps, workerActive, workspacePath } from './orcaRuns'
import { redact, transcriptLines } from './worker'

test('workspace paths, deps and results are read the way Orca writes them', () => {
  assert.equal(workspacePath('repo-id::/Users/me/project/worktrees/x'), '/Users/me/project/worktrees/x')
  assert.equal(workspacePath('/plain/path'), '/plain/path')
  assert.deepEqual(taskDeps('["task_a","task_b"]'), ['task_a', 'task_b'])
  assert.deepEqual(taskDeps(['task_a', 3]), ['task_a'])
  assert.deepEqual(taskDeps('nonsense'), [])
  assert.equal(resultText('{"subject":"Review: READY","body":"All good"}'), 'Review: READY\n\nAll good')
  assert.equal(resultText('{"file":"weather.txt"}'), '{\n  "file": "weather.txt"\n}')
  assert.equal(resultText(null), undefined)
  // Real Orca values: state ready | succeeded | failed | stopped, liveness live | exited | unverifiable.
  assert.equal(workerActive({ liveness: 'live', state: 'ready' }), true)
  assert.equal(workerActive({ liveness: 'live', state: 'succeeded' }), false, 'finished, terminal kept open')
  assert.equal(workerActive({ liveness: 'exited', state: 'succeeded' }), false)
  assert.equal(workerActive({ liveness: 'unverifiable', state: 'ready' }), false)
  assert.deepEqual(launchOf({ worker: { startOptions: { agent: 'claude', launch: { effective: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' } } } } }), { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' })
  assert.deepEqual(launchOf(undefined), {})
})

test('a Run becomes nodes with depth, agent, model, workspace and the worker report', () => {
  const nodes = buildRunGraph(
    [
      { id: 'task_plan', status: 'completed', display_name: 'Plan', task_title: 'Plan · run_x#1', deps: '[]', dispatch_id: 'ctx_1', result: '{"body":"Plan ready"}' },
      { id: 'task_review', status: 'dispatched', display_name: 'Review', deps: ['task_plan', 'task_elsewhere'] }
    ],
    [
      { dispatchId: 'ctx_1', taskId: 'task_plan', state: 'succeeded', liveness: 'exited', agent: 'claude/claude-opus-5-5', outcome: 'succeeded', workspace: 'repo::/w/a' },
      { dispatchId: 'ctx_2', taskId: 'task_review', state: 'ready', liveness: 'live', agent: 'codex/gpt-6.2-sol', workspace: 'repo::/w/a' }
    ]
  )
  assert.deepEqual(nodes.map((node) => [node.id, node.depth, node.needs]), [['task_plan', 0, []], ['task_review', 1, ['task_plan']]])
  assert.equal(nodes[0].taskTitle, 'Plan · run_x#1')
  assert.equal(nodes[0].agent, 'claude')
  assert.equal(nodes[0].model, 'claude-opus-5-5')
  assert.equal(nodes[0].result, 'Plan ready')
  assert.equal(nodes[0].outcome, 'succeeded')
  assert.equal(nodes[1].dispatchId, 'ctx_2')
  assert.equal(nodes[1].workspacePath, '/w/a')
  assert.equal(nodes[1].model, 'gpt-6.2-sol')
})

test('transcript lines keep the agent text and the tools it called, not the prompt or tool output', () => {
  const lines = transcriptLines([
    { role: 'user', blocks: [{ type: 'text', text: 'You are a dispatched worker' }] },
    { role: 'assistant', blocks: [{ type: 'tool-call', name: 'Bash', input: "{'command': 'ls', 'description': 'List files'}" }, { type: 'tool-result', text: 'a\nb' }] },
    { role: 'reasoning', blocks: [{ type: 'text', text: 'thinking' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'Report ready.\n\nVerdict: PASS' }] }
  ])
  assert.deepEqual(lines, ['→ Bash: List files', 'Report ready.', 'Verdict: PASS'])
  assert.deepEqual(redact(['token ghp_abcdefghijklmnop123 and Bearer abcdefghijklmnopqrst']), ['token <hidden> and Bearer <hidden>'])
})
