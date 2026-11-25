import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { focusExistingNativeChat } from './nativeChat'

const runtimeId = 'b9afbbef-5778-4d8f-9dcb-3e678a193d5f'
const sessionId = 'b184b40f-8cd5-4692-9beb-ba16a45be472'
const tab = { id: 'chat-a', type: 'agent-session', sessionId }
const rejected = /This chat tab is unavailable/

test('focuses only one existing native chat in the requested workspace', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'playbooks-chat-'))
  const socketPath = path.join(dir, 'orca.sock')
  const metadata = path.join(dir, 'runtime.json')
  const methods: string[] = []
  let active = 'terminal-a'
  let pendingFocus = false
  let tabs = [tab]
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.once('data', (chunk: string) => {
      const request = JSON.parse(chunk)
      methods.push(request.method)
      assert.equal(request.authToken, 'fixture-auth')
      assert.equal(request.params.worktree, 'demo::workspace')
      if (request.method === 'session.tabs.activate') {
        assert.equal(request.params.tabId, tab.id)
        pendingFocus = true
      } else {
        assert.equal(request.method, 'session.tabs.list')
      }
      socket.end(JSON.stringify({ id: request.id, ok: true, result: { tabs, activeTabId: active } }) + '\n')
      if (pendingFocus && request.method === 'session.tabs.list') active = tab.id
    })
  })
  try {
    server.listen(socketPath)
    await once(server, 'listening')
    await writeFile(metadata, JSON.stringify({ runtimeId, authToken: 'fixture-auth', transports: [{ kind: 'unix', endpoint: socketPath }] }), { mode: 0o600 })
    await focusExistingNativeChat('demo::workspace', sessionId, runtimeId, metadata)
    assert.deepEqual(methods, ['session.tabs.list', 'session.tabs.activate', 'session.tabs.list', 'session.tabs.list'])
    methods.length = 0

    tabs = []
    await assert.rejects(focusExistingNativeChat('demo::workspace', sessionId, runtimeId, metadata), rejected)
    assert.deepEqual(methods, ['session.tabs.list'])
    methods.length = 0

    tabs = [tab, { ...tab, id: 'chat-b' }]
    await assert.rejects(focusExistingNativeChat('demo::workspace', sessionId, runtimeId, metadata), rejected)
    assert.deepEqual(methods, ['session.tabs.list'])
    methods.length = 0

    await assert.rejects(focusExistingNativeChat('demo::workspace', sessionId, sessionId, metadata), rejected)
    assert.deepEqual(methods, [])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
