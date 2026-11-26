import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

async function until(label, check, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const [, , portArg, demo, other, cli] = process.argv
assert(demo && other && cli, 'Expected two demo workspaces and the Orca CLI')
const port = Number(portArg)
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Expected a debugger port')
const guest = await until('the Playbooks webview', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
  const targets = await response.json()
  return targets.find(({ type, url }) => type === 'webview' && url.startsWith('orca-plugin-frame:') &&
    new URL(url).pathname === '/panel/index.html')
})
const debuggerUrl = new URL(guest.webSocketDebuggerUrl)
assert.equal(debuggerUrl.origin, `ws://127.0.0.1:${port}`)
const socket = new WebSocket(debuggerUrl)
let nextId = 0

async function evaluate(expression, starting = false) {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, userGesture: true } }))
  const signal = AbortSignal.timeout(5000)
  for (;;) {
    const [event] = await once(socket, 'message', { signal })
    const response = JSON.parse(event.data)
    if (response.id !== id) continue
    // Electron can advertise the webview before the page has an execution context.
    if (starting && response.error?.code === -32000 &&
        response.error.message === 'Cannot find default execution context') return false
    if (response.error || response.result.exceptionDetails) {
      throw new Error(JSON.stringify(response.error ?? response.result.exceptionDetails))
    }
    return response.result.result.value
  }
}

try {
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) })
  await until('the demo playbook in the panel', () => evaluate(
    "document.querySelector('#playbook')?.value === 'revise-and-publish.yaml' && !document.querySelector('#start')?.disabled",
    true
  ))
  await waitForWorkspace(demo)
  const demoWorkspaceId = await evaluate("document.querySelector('#workspace').value")
  assert(demoWorkspaceId, 'Expected the demo workspace to have a host-provided ID')
  await evaluate("document.querySelector('#start').click()")
  const firstGate = await waitForGate('DRAFT 1')
  const runs = join(demo, '.orca', 'runs')
  const runDirectories = () => readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  const directories = runDirectories()
  assert.equal(directories.length, 1, 'Expected one run of the demo playbook')
  const run = join(runs, directories[0])
  const read = (file) => readFileSync(join(run, file), 'utf8')
  const publish = join(run, 'publish.txt')
  assert.equal(read('executions.log'), 'seed\ndraft\n')
  assert.equal(read('seed.txt'), 'DEMO SOURCE')
  assert.equal(read('draft.txt'), 'DRAFT 1')
  assert(!existsSync(publish), 'Publish ran before the first decision')

  await evaluate(`(() => {
    document.querySelector('#comment').value = 'Publish the revised draft.'
    document.querySelector('#gateRevise').click()
  })()`)
  await waitForGate('DRAFT 2', firstGate)
  assert.equal(read('executions.log'), 'seed\ndraft\ndraft\n')
  assert.equal(read('seed.txt'), 'DEMO SOURCE')
  assert.equal(read('draft.txt'), 'DRAFT 2')
  assert(!existsSync(publish), 'Publish ran before approval')

  const waitingRun = await evaluate("document.querySelector('#run').value")
  assert.equal(waitingRun, 'pb:' + directories[0])
  const preview = await evaluate(`(() => {
    const playbook = document.querySelector('#playbook')
    playbook.value = 'zz-preview.yaml'
    playbook.dispatchEvent(new Event('change'))
    return {
      view: document.querySelector('#run').value,
      heading: document.querySelector('#runSource').textContent,
      nodes: [...document.querySelectorAll('[data-node]')].map((node) => node.dataset.node),
    }
  })()`)
  assert.deepEqual(preview, {
    view: 'definition', heading: 'Plan preview · Preview check', nodes: ['preview-only'],
  }, 'Changing a playbook switches both the view selector and the rendered graph immediately')
  assert.deepEqual(runDirectories(), directories, 'Plan preview does not start a new run')
  const returned = await evaluate(`(() => {
    const run = document.querySelector('#run')
    run.value = ${JSON.stringify(waitingRun)}
    run.dispatchEvent(new Event('change'))
    return {
      view: run.value,
      heading: document.querySelector('#runSource').textContent,
    }
  })()`)
  assert.deepEqual(returned, {
    view: waitingRun, heading: 'Playbook run · Revise and publish',
  }, 'The previous run remains selectable')
  await waitForGate('DRAFT 2')
  console.log('Verified immediate plan preview, no automatic start, and return to the waiting run.')

  execFileSync(cli, ['worktree', 'activate', '--worktree', 'path:' + other, '--json'], { timeout: 25_000 })
  await waitForWorkspace(other)
  assert.equal(await evaluate("document.querySelector('#needs-count').textContent"), '1')
  assert.doesNotMatch(await evaluate("document.querySelector('#workspace-view').textContent"), /Revise and publish|waits for you in/i)
  await evaluate("document.querySelector('#needs-tab').click()")
  const decision = await until('the decision from the demo workspace', () => evaluate(`(() => {
    const actions = [...document.querySelectorAll('#needs-panel button[data-target]')]
    if (!actions.length) return null
    const row = actions[0].closest('article')
    return {
      count: actions.length,
      action: actions[0].textContent.trim(),
      detail: row.textContent,
      target: JSON.parse(actions[0].dataset.target),
    }
  })()`))
  assert.equal(decision.count, 1)
  assert.equal(decision.action, 'Open decision')
  assert(decision.detail.includes('Review the draft'))
  assert.deepEqual(decision.target, { workspaceId: demoWorkspaceId, runId: directories[0], stepId: 'review' })
  await evaluate("document.querySelector('#needs-panel button[data-target]').click()")
  await waitForWorkspace(demo)
  assert.equal(await evaluate("document.querySelector('#run').value"), waitingRun)
  await waitForGate('DRAFT 2')
  await evaluate("document.querySelector('#gateOk').click()")
  let approval
  try {
    await until('the pending decision count to reach zero', async () => {
      approval = await evaluate(`({
        count: document.querySelector('#needs-count').textContent,
        gateMessage: document.querySelector('#gate-message')?.textContent,
        overviewMessage: document.querySelector('#overview-message').textContent,
        message: document.querySelector('#msg').textContent,
      })`)
      if (approval.gateMessage?.startsWith('Could not send the decision')) throw new Error(approval.gateMessage)
      return approval.count === '0'
    }, 35_000)
  } catch (error) {
    console.error('Approval state:', approval)
    throw error
  }
  await evaluate("document.querySelector('#needs-tab').click()")
  assert.match(await evaluate("document.querySelector('#needs-panel').textContent"), /No decisions are waiting\./)
  await evaluate("document.querySelector('#workspace-tab').click()")
  await until('the finished run', () => evaluate(
    "document.querySelector('#runBadge').textContent.includes('finished')"
  ), 35_000)
  assert.equal(read('executions.log'), 'seed\ndraft\ndraft\npublish\n')
  const expected = 'PUBLISHED: DEMO SOURCE / DRAFT 2'
  assert.equal(read('publish.txt'), expected)
  await evaluate("document.querySelector('[data-node=publish]').dispatchEvent(new MouseEvent('click', { bubbles: true }))")
  await until('the result drawer', () => evaluate("Boolean(document.querySelector('#resultBox summary'))"))
  await evaluate("document.querySelector('#resultBox summary').click()")
  const result = await until('the visible final output', () => evaluate("document.querySelector('#resultBox[open] pre')?.textContent"))
  assert.equal(result, expected)
  await evaluate("document.querySelector('#resultBox').scrollIntoView({ block: 'nearest' })")
  console.log('Verified one seed, two drafts, and one publish after approval. Disk and panel results match.')
  console.log('Verified decision handoff between workspaces and Needs you returning to zero.')
} finally {
  socket.close()
}

function waitForWorkspace(path) {
  return until(`the selected demo workspace at ${path}`, () => evaluate(
    `!document.querySelector('#workspace-view').hidden &&
      document.querySelector('#workspace').selectedOptions[0]?.textContent.endsWith(${JSON.stringify(' — ' + path)})`
  ))
}

function waitForGate(draft, previous) {
  return until(`the decision for ${draft}`, async () => {
    const { message, gate, output } = await evaluate(`({
      message: document.querySelector('#msg').textContent,
      gate: document.querySelector('#gateOk:enabled') ? document.querySelector('#gate').dataset.key : '',
      output: document.querySelector('#gate pre')?.textContent
    })`)
    if (/^(Start failed|Failed):/.test(message)) throw new Error(message)
    return gate !== previous && output === draft && gate
  }, 55_000)
}
