import assert from 'node:assert/strict'
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

const port = Number(process.argv[2])
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
  await evaluate("document.querySelector('#start').click()")
  const firstGate = await waitForGate('DRAFT 1')
  const runs = join(process.argv[3], '.orca', 'runs')
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

  await evaluate("document.querySelector('#gateOk').click()")
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
  const finishedRun = await evaluate("document.querySelector('#run').value")
  assert.match(finishedRun, /^pb:/)
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
    run.value = ${JSON.stringify(finishedRun)}
    run.dispatchEvent(new Event('change'))
    return document.querySelector('#runBadge').textContent.trim()
  })()`)
  assert.equal(returned, 'finished', 'The previous run remains selectable')
  console.log('Verified immediate plan preview, no automatic start, and return to the finished run.')
} finally {
  socket.close()
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
