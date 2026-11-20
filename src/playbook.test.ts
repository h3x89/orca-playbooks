import { assert, test } from 'orca/testing'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { depths, loopSteps, parsePlaybook, renderPrompt, topologicalOrder } from './playbook'

const WEATHER = `
title: Weather
inputs:
  activity: { default: running }
  lat: "52.23"
steps:
  - id: weather
    script: { run: weather.py }
  - id: air
    script: { run: air.py, timeout_sec: 30 }
  - id: plan
    needs: [weather, air]
    agent: claude
    model: claude-sonnet-5-5
    keep_open: true
    prompt: Plan for {{date}} for {{inputs.activity}}.
  - id: decision
    needs: [plan]
    gate: { question: Approve? }
    on:
      revise: { goto: plan, max_loops: 2 }
`

test('parses agents, scripts, gates, inputs and the revise loop', () => {
  const { playbook, errors } = parsePlaybook('weather', WEATHER)
  assert.deepEqual(errors, [])
  assert.ok(playbook)
  assert.deepEqual(playbook.inputs, { activity: 'running', lat: '52.23' })
  assert.deepEqual(playbook.steps.map((step) => step.kind), ['script', 'script', 'agent', 'gate'])
  const plan = playbook.steps[2]
  assert.ok(plan.kind === 'agent' && plan.keepOpen && plan.model === 'claude-sonnet-5-5')
  const gate = playbook.steps[3]
  assert.ok(gate.kind === 'gate')
  assert.deepEqual(gate.loop, { goto: 'plan', maxLoops: 2 })
  assert.deepEqual(depths(playbook.steps), { weather: 0, air: 0, plan: 1, decision: 2 })
})

test('on.popraw is still read as the legacy name of on.revise', () => {
  const legacy = parsePlaybook('weather', WEATHER.replace('revise:', 'popraw:'))
  assert.deepEqual(legacy.errors, [])
  const gate = legacy.playbook!.steps[3]
  assert.ok(gate.kind === 'gate')
  assert.deepEqual(gate.loop, { goto: 'plan', maxLoops: 2 })
  const both = parsePlaybook('weather', WEATHER.replace('revise: { goto: plan, max_loops: 2 }', 'revise: { goto: plan }\n      popraw: { goto: plan }'))
  assert.match(both.errors.join('\n'), /decision: `on` takes only `revise: \{ goto, max_loops \}`/)
  const other = parsePlaybook('weather', WEATHER.replace('revise:', 'retry:'))
  assert.match(other.errors.join('\n'), /decision: `on` takes only `revise/)
})

test('reports every problem instead of throwing', () => {
  const bad = parsePlaybook('x', `
steps:
  - id: A
    agent: claude
  - id: b
    agent: unknown
    prompt: x
    effort: high
  - id: c
    needs: [missing]
    script: { run: ../evil.sh }
  - id: d
    agent: claude
    prompt: x
    gate: { question: both? }
`)
  assert.equal(bad.playbook, undefined)
  const all = bad.errors.join('\n')
  assert.match(all, /steps\[0\]: `id`/)
  assert.match(all, /b: `agent` is one of/)
  assert.match(all, /b: `effort` needs `model`/)
  assert.match(all, /c: `script.run`/)
  assert.match(all, /c: `needs` names a step that does not exist: "missing"/)
  assert.match(all, /d: a step has exactly one of/)
  assert.match(parsePlaybook('x', 'a: [').errors[0], /^YAML:/)
  assert.deepEqual(parsePlaybook('x', 'title: t').errors, ['No `steps` list.'])
})

test('rejects cycles and a goto the gate does not depend on', () => {
  const cycle = parsePlaybook('x', `
steps:
  - { id: a, needs: [b], agent: claude, prompt: x }
  - { id: b, needs: [a], agent: claude, prompt: x }
`)
  assert.deepEqual(cycle.errors, ['The `needs` dependencies form a cycle.'])
  const loose = parsePlaybook('x', `
steps:
  - { id: a, agent: claude, prompt: x }
  - { id: side, agent: claude, prompt: x }
  - id: g
    needs: [a]
    gate: { question: q }
    on: { revise: { goto: side } }
`)
  assert.match(loose.errors.join('\n'), /g: `goto` must name a step this gate depends on/)
})

test('a revise loop reruns goto, the steps between it and the gate, the gate and what follows', () => {
  const steps = [
    { id: 'data', needs: [] },
    { id: 'draft', needs: ['data'] },
    { id: 'check', needs: ['draft'] },
    { id: 'side', needs: ['draft'] },
    { id: 'gate', needs: ['check'] },
    { id: 'publish', needs: ['gate'] }
  ]
  assert.deepEqual(loopSteps(steps, 'gate', 'draft').map((step) => step.id), ['draft', 'check', 'gate', 'publish'])
  assert.deepEqual(topologicalOrder([...steps].reverse()).map((step) => step.id).indexOf('data'), 0)
})

test('the example playbooks are valid', () => {
  const dir = fileURLToPath(new URL('../examples/.orca/playbooks/', import.meta.url))
  const files = readdirSync(dir).filter((name) => name.endsWith('.yaml')).sort()
  assert.deepEqual(files, ['sequential-vs-parallel.yaml', 'weather-air.yaml'])
  for (const file of files) assert.deepEqual(parsePlaybook(file.replace('.yaml', ''), readFileSync(dir + file, 'utf8')).errors, [], file)
  const parallel = parsePlaybook('sequential-vs-parallel', readFileSync(dir + 'sequential-vs-parallel.yaml', 'utf8')).playbook!
  assert.deepEqual(depths(parallel.steps), { left: 0, right: 0, first: 1, second: 2, done: 3 })
})

test('fills known placeholders and leaves unknown ones', () => {
  assert.equal(renderPrompt('{{ date }} {{inputs.lat}} {{nope}}', { date: '2026-11-18', 'inputs.lat': '52.23' }), '2026-11-18 52.23 {{nope}}')
})
