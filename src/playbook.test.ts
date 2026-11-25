import { assert, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
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
  assert.deepEqual(files, ['sequential-vs-parallel.yaml', 'weather-air.yaml', 'weather-research.yaml'])
  for (const file of files) assert.deepEqual(parsePlaybook(file.replace('.yaml', ''), readFileSync(dir + file, 'utf8')).errors, [], file)
  const parallel = parsePlaybook('sequential-vs-parallel', readFileSync(dir + 'sequential-vs-parallel.yaml', 'utf8')).playbook!
  assert.deepEqual(depths(parallel.steps), { left: 0, right: 0, first: 1, second: 2, done: 3 })
  const research = parsePlaybook('weather-research', readFileSync(dir + 'weather-research.yaml', 'utf8')).playbook!
  assert.deepEqual(research.steps.map((step) => step.kind), ['agent', 'agent', 'script', 'agent', 'script', 'agent', 'gate', 'script'])
  assert.deepEqual(depths(research.steps), { forecast: 0, air: 0, summary: 1, plan: 2, 'prepare-review': 3, review: 4, decision: 5, finish: 6 })
  assert.deepEqual(loopSteps(research.steps, 'decision', 'plan').map((step) => step.id), ['plan', 'prepare-review', 'review', 'decision', 'finish'])
})

test('the ASDLC example and BPMN agree on steps, dependencies, and Revise', () => {
  const root = new URL('../examples/asdlc/', import.meta.url)
  const yaml = readFileSync(new URL('.orca/playbooks/review-gated-fix.yaml', root), 'utf8')
  const { playbook, errors } = parsePlaybook('review-gated-fix', yaml)
  assert.deepEqual(errors, [])
  assert.ok(playbook)

  const readModel = [
    'import json, sys, xml.etree.ElementTree as ET',
    'process = ET.parse(sys.argv[1]).find("{*}process")',
    'nodes = [[e.get("id"), e.tag.split("}")[-1]] for e in process if e.tag.endswith("Task")]',
    'flows = [dict(e.attrib) for e in process.findall("{*}sequenceFlow")]',
    'print(json.dumps({"nodes": nodes, "flows": flows}))'
  ].join('\n')
  const model: {
    nodes: [string, 'serviceTask' | 'scriptTask' | 'userTask'][]
    flows: { sourceRef: string; targetRef: string; name?: string }[]
  } = JSON.parse(execFileSync('python3', ['-c', readModel, fileURLToPath(new URL('process.bpmn', root))], { encoding: 'utf8' }))
  const kinds = { serviceTask: 'agent', scriptTask: 'script', userTask: 'gate' }
  assert.deepEqual(model.nodes.map(([id, kind]) => [id, kinds[kind]]), playbook.steps.map(({ id, kind }) => [id, kind]))

  const revision = model.flows.find((edge) => edge.name?.startsWith('Revise · max '))
  assert.ok(revision)
  const forward = model.flows.filter((edge) => edge !== revision)
  const stepIds = new Set(playbook.steps.map((step) => step.id))
  function parentsOf(node: string): string[] {
    return forward.filter((edge) => edge.targetRef === node)
      .flatMap(({ sourceRef }) => stepIds.has(sourceRef) ? [sourceRef] : parentsOf(sourceRef))
  }
  for (const step of playbook.steps) {
    assert.deepEqual([...new Set(parentsOf(step.id))].sort(), [...step.needs].sort(), step.id)
  }
  const gate = playbook.steps.find((step) => step.id === 'decide')
  assert.ok(gate?.kind === 'gate' && gate.loop)
  assert.deepEqual(parentsOf(revision.sourceRef), [gate.id])
  assert.deepEqual(forward.filter((edge) => edge.sourceRef === revision.targetRef).map((edge) => edge.targetRef), [gate.loop.goto])
  assert.equal(revision.name, `Revise · max ${gate.loop.maxLoops} loops`)
})

test('fills known placeholders and leaves unknown ones', () => {
  assert.equal(renderPrompt('{{ date }} {{inputs.lat}} {{nope}}', { date: '2026-11-18', 'inputs.lat': '52.23' }), '2026-11-18 52.23 {{nope}}')
})
