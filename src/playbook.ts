// Playbook format: a YAML file in `<repo>/.orca/playbooks/<id>.yaml`.
// Kept free of Orca and Node APIs so the worker and the tests share it.
import YAML from '../vendor/yaml/index.js'

type Base = { id: string; title: string; needs: string[] }

export type AgentStep = Base & {
  kind: 'agent'
  agent: string
  model?: string
  effort?: string
  keepOpen: boolean
  prompt: string
}

/** Runs `<repo>/.orca/playbooks/scripts/<run>` in the plugin worker, without an agent. */
export type ScriptStep = Base & {
  kind: 'script'
  run: string
  timeoutSec: number
}

export type GateStep = Base & {
  kind: 'gate'
  question: string
  /** On Revise, run `goto` and every step between it and this gate again, at most `maxLoops` times. */
  loop?: { goto: string; maxLoops: number }
}

export type Step = AgentStep | ScriptStep | GateStep

export type InputField = {
  name: string
  label: string
  description: string
  required: boolean
  format?: 'ticket'
  default?: string
}

export type Playbook = {
  id: string
  title: string
  description: string
  /** Defaults of `{{inputs.<name>}}` in prompts and `PLAYBOOK_INPUT_<NAME>` in scripts. */
  inputs: Record<string, string>
  inputFields: InputField[]
  steps: Step[]
}

export type ParseResult = { playbook?: Playbook; errors: string[] }

const ID = /^[a-z][a-z0-9_-]{0,40}$/
const SCRIPT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/
export const AGENTS = ['claude', 'codex', 'opencode', 'opencode2', 'cursor', 'antigravity', 'grok', 'muse', 'zcode', 'pi', 'omp']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const TICKET = /^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,9}$/

function parseInputs(raw: unknown, errors: string[]): InputField[] {
  if (raw === undefined) return []
  if (!isRecord(raw)) {
    errors.push('`inputs` must be a map.')
    return []
  }
  const fields: InputField[] = []
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(name)) {
      errors.push(`inputs.${name}: use lowercase letters, digits and "_".`)
      continue
    }
    const data = isRecord(value) ? value : { default: value }
    const fallback = text(data.default)
    const required = data.required === true
    if (data.required !== undefined && typeof data.required !== 'boolean') errors.push(`inputs.${name}: required must be true or false.`)
    if (data.format !== undefined && data.format !== 'ticket') errors.push(`inputs.${name}: unknown format.`)
    if (fallback === undefined && !required) errors.push(`inputs.${name}: no default value.`)
    if (fallback !== undefined && data.format === 'ticket' && !TICKET.test(fallback)) errors.push(`inputs.${name}: invalid default ticket.`)
    fields.push({
      name,
      label: text(data.label) ?? name,
      description: text(data.description) ?? '',
      required,
      ...(data.format === 'ticket' ? { format: 'ticket' as const } : {}),
      ...(fallback !== undefined ? { default: fallback } : {})
    })
  }
  return fields
}

/** Both the panel and programmatic callers use the same validation before a run exists. */
export function resolveInputs(fields: InputField[], provided: unknown): Record<string, string> {
  if (provided !== undefined && !isRecord(provided)) throw new Error('Run inputs must be an object.')
  const values = provided ?? {}
  const known = new Set(fields.map((field) => field.name))
  for (const key of Object.keys(values)) if (!known.has(key)) throw new Error(`Unknown input: ${key}.`)
  return Object.fromEntries(fields.map((field) => {
    const raw = Object.hasOwn(values, field.name) ? values[field.name] : (field.default ?? '')
    if (typeof raw !== 'string') throw new Error(`${field.label} must be text.`)
    const value = raw.trim()
    if (field.required && !value) throw new Error(`${field.label} is required.`)
    if (value.length > 2000) throw new Error(`${field.label} is longer than 2000 characters.`)
    if (value && field.format === 'ticket' && !TICKET.test(value)) throw new Error(`${field.label} must look like DEMO-123.`)
    return [field.name, value]
  }))
}

/** Parses and validates one playbook. Never throws: problems come back in `errors`. */
export function parsePlaybook(id: string, source: string): ParseResult {
  const errors: string[] = []
  let raw: unknown
  try {
    raw = YAML.parse(source)
  } catch (error) {
    return { errors: [`YAML: ${(error as Error).message}`] }
  }
  if (!isRecord(raw)) return { errors: ['The file is not a YAML map.'] }
  const title = text(raw.title) ?? id
  const description = text(raw.description) ?? ''
  const inputFields = parseInputs(raw.inputs, errors)
  const inputs = Object.fromEntries(inputFields.filter((field) => field.default !== undefined).map((field) => [field.name, field.default!]))
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return { errors: ['No `steps` list.'] }
  if (raw.steps.length > 40) errors.push('At most 40 steps.')

  const steps: Step[] = []
  const seen = new Set<string>()
  raw.steps.forEach((value, index) => {
    const where = `steps[${index}]`
    if (!isRecord(value)) {
      errors.push(`${where}: a step must be a map.`)
      return
    }
    const stepId = text(value.id)
    if (!stepId || !ID.test(stepId)) {
      errors.push(`${where}: \`id\` of lowercase letters, digits, "-" or "_".`)
      return
    }
    if (seen.has(stepId)) errors.push(`${where}: duplicate id "${stepId}".`)
    seen.add(stepId)
    const needs = value.needs === undefined ? [] : value.needs
    if (!Array.isArray(needs) || needs.some((need) => typeof need !== 'string')) {
      errors.push(`${stepId}: \`needs\` must be a list of step ids.`)
      return
    }
    const base: Base = { id: stepId, title: text(value.title) ?? stepId, needs: needs as string[] }
    const kinds = ['gate', 'script', 'agent'].filter((key) => value[key] !== undefined)
    if (kinds.length !== 1) {
      errors.push(`${stepId}: a step has exactly one of \`agent\`, \`script\`, \`gate\`.`)
      return
    }

    if (value.gate !== undefined) {
      const gate = isRecord(value.gate) ? value.gate : {}
      const question = text(gate.question)
      if (!question) errors.push(`${stepId}: a gate needs \`gate.question\`.`)
      const step: GateStep = { ...base, kind: 'gate', question: question ?? '' }
      const on = isRecord(value.on) ? value.on : undefined
      // `popraw` is the legacy name of `revise`, still read so older playbooks keep working.
      const keys = on ? Object.keys(on) : []
      const revise = on ? (on.revise ?? on.popraw) : undefined
      if (value.on !== undefined && (!on || keys.length !== 1 || !['revise', 'popraw'].includes(keys[0]) || !isRecord(revise))) errors.push(`${stepId}: \`on\` takes only \`revise: { goto, max_loops }\`.`)
      else if (isRecord(revise)) {
        const goto = text(revise.goto)
        const maxLoops = revise.max_loops === undefined ? 2 : revise.max_loops
        if (!goto) errors.push(`${stepId}: \`on.revise.goto\` names the step to run again.`)
        if (typeof maxLoops !== 'number' || !Number.isInteger(maxLoops) || maxLoops < 1 || maxLoops > 5) errors.push(`${stepId}: \`max_loops\` from 1 to 5.`)
        if (goto) step.loop = { goto, maxLoops: typeof maxLoops === 'number' ? maxLoops : 2 }
      }
      steps.push(step)
      return
    }

    if (value.script !== undefined) {
      const script = isRecord(value.script) ? value.script : {}
      const run = text(script.run)
      if (!run || !SCRIPT.test(run)) errors.push(`${stepId}: \`script.run\` is a file name in .orca/playbooks/scripts/ (no "/").`)
      const timeout = script.timeout_sec === undefined ? 120 : script.timeout_sec
      if (typeof timeout !== 'number' || timeout < 1 || timeout > 1800) errors.push(`${stepId}: \`script.timeout_sec\` from 1 to 1800.`)
      steps.push({ ...base, kind: 'script', run: run ?? '', timeoutSec: typeof timeout === 'number' ? timeout : 120 })
      return
    }

    const agent = text(value.agent)
    const prompt = text(value.prompt)
    if (!agent || !AGENTS.includes(agent)) errors.push(`${stepId}: \`agent\` is one of: ${AGENTS.join(', ')}.`)
    if (!prompt) errors.push(`${stepId}: an agent step needs \`prompt\`.`)
    if (value.effort !== undefined && value.model === undefined) errors.push(`${stepId}: \`effort\` needs \`model\`.`)
    if (value.keep_open !== undefined && typeof value.keep_open !== 'boolean') errors.push(`${stepId}: \`keep_open\` is true or false.`)
    steps.push({
      ...base,
      kind: 'agent',
      agent: agent ?? '',
      model: text(value.model),
      effort: text(value.effort),
      keepOpen: value.keep_open === true,
      prompt: prompt ?? ''
    })
  })

  const byId = new Map(steps.map((step) => [step.id, step]))
  for (const step of steps) {
    for (const need of step.needs) if (!byId.has(need)) errors.push(`${step.id}: \`needs\` names a step that does not exist: "${need}".`)
  }
  if (errors.length === 0 && hasCycle(steps)) errors.push('The `needs` dependencies form a cycle.')
  if (errors.length === 0) {
    for (const step of steps) {
      if (step.kind !== 'gate' || !step.loop) continue
      const target = byId.get(step.loop.goto)
      if (!target) errors.push(`${step.id}: \`goto\` names a step that does not exist: "${step.loop.goto}".`)
      else if (target.kind === 'gate') errors.push(`${step.id}: \`goto\` cannot name a gate.`)
      else if (!ancestors(steps, step.id).has(target.id)) errors.push(`${step.id}: \`goto\` must name a step this gate depends on.`)
    }
  }
  return errors.length ? { errors } : { playbook: { id, title, description, inputs, inputFields, steps }, errors }
}

function hasCycle(steps: Step[]): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false
    if (state.get(id) === 'visiting') return true
    state.set(id, 'visiting')
    for (const need of byId.get(id)?.needs ?? []) if (visit(need)) return true
    state.set(id, 'done')
    return false
  }
  return steps.some((step) => visit(step.id))
}

/** Ids of every step that `id` needs, directly or through other steps. */
export function ancestors(steps: Pick<Step, 'id' | 'needs'>[], id: string): Set<string> {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const found = new Set<string>()
  const walk = (current: string) => {
    for (const need of byId.get(current)?.needs ?? []) {
      if (found.has(need)) continue
      found.add(need)
      walk(need)
    }
  }
  walk(id)
  return found
}

/** Ids of every step that needs `id`, directly or through other steps. */
export function descendants(steps: Pick<Step, 'id' | 'needs'>[], id: string): Set<string> {
  const found = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const step of steps) {
      if (found.has(step.id)) continue
      if (step.needs.some((need) => need === id || found.has(need))) {
        found.add(step.id)
        grew = true
      }
    }
  }
  return found
}

/**
 * Steps a Revise on `gateId` runs again: `goto`, every step between it and the gate, the gate,
 * and everything after the gate. Returned in an order where needs come first.
 */
export function loopSteps<T extends Pick<Step, 'id' | 'needs'>>(steps: T[], gateId: string, goto: string): T[] {
  const between = descendants(steps, goto)
  const before = ancestors(steps, gateId)
  const after = descendants(steps, gateId)
  const ids = new Set([goto, gateId, ...[...between].filter((id) => before.has(id)), ...after])
  return topologicalOrder(steps).filter((step) => ids.has(step.id))
}

/** Steps in an order where every step comes after the steps it needs. */
export function topologicalOrder<T extends Pick<Step, 'id' | 'needs'>>(steps: T[]): T[] {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const done = new Set<string>()
  const order: T[] = []
  const visit = (step: T) => {
    if (done.has(step.id)) return
    done.add(step.id)
    for (const need of step.needs) visit(byId.get(need)!)
    order.push(step)
  }
  steps.forEach(visit)
  return order
}

/** Column of each step in the graph: 0 for steps without `needs`, else one past its deepest need. */
export function depths(steps: Pick<Step, 'id' | 'needs'>[]): Record<string, number> {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const memo: Record<string, number> = {}
  const depth = (id: string): number => {
    if (memo[id] !== undefined) return memo[id]
    const needs = byId.get(id)?.needs ?? []
    memo[id] = needs.length === 0 ? 0 : 1 + Math.max(...needs.map(depth))
    return memo[id]
  }
  steps.forEach((step) => depth(step.id))
  return memo
}

/** Fills `{{run_dir}}`, `{{now}}`, `{{date}}`, `{{step}}`, `{{comment}}` and `{{inputs.<name>}}`. Unknown names stay as written. */
export function renderPrompt(prompt: string, values: Record<string, string>): string {
  return prompt.replace(/\{\{\s*([a-z_]+(?:\.[a-z0-9_]+)?)\s*\}\}/g, (match, key: string) => values[key] ?? match)
}
