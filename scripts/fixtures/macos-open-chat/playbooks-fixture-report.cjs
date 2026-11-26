const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')

const [cli, inputs, marker] = process.argv.slice(2)
const prompts = readFileSync(inputs, 'utf8').trim().split('\n').reverse()
const taskLine = /^Your task ID is: (task_[a-z0-9]+)$/m
const task = prompts.map((line) => {
  const { content } = JSON.parse(line)
  return typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('\n')
}).find((text) => text.includes('\n=== TASK ===\n' + marker))
const taskId = task?.match(taskLine)?.[1]
if (!taskId) throw new Error('The fixture was not run inside a dispatched worker.')

const call = (...args) => execFileSync(process.execPath, [cli, ...args, '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})
const { result } = JSON.parse(call('orchestration', 'dispatch-show', '--task', taskId))
process.stdout.write(call(
  'orchestration', 'send', '--type', 'worker_done',
  '--subject', 'Fixture completed', '--body', 'Synthetic fixture completed.',
  '--task-id', taskId, '--dispatch-id', result.dispatch.id, '--outcome', 'succeeded',
))
