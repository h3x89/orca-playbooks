import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect } from '@stablyai/playwright-test'
import { test } from '../desktop/electron-fixtures/orca-app'

const exec = promisify(execFile)
const fixtureRoot = process.cwd()
const cliEntry = path.join(fixtureRoot, 'out/cli/index.js')

test('opens a closed orchestration worker from session history', async ({
  electronApp,
  orcaPage,
  seededRepoPath,
}, testInfo) => {
  test.setTimeout(300_000)
  const profile = await electronApp.evaluate(({ app }) => ({
    home: app.getPath('home'),
    userData: app.getPath('userData'),
  }))
  async function cli(...args: string[]) {
    const { stdout } = await exec(process.execPath, [cliEntry, ...args, '--json'], {
      cwd: seededRepoPath,
      env: { PATH: process.env.PATH, HOME: profile.home, ORCA_USER_DATA_PATH: profile.userData },
      timeout: 45_000,
    })
    const response = JSON.parse(stdout)
    expect(response.ok).toBe(true)
    return response.result
  }

  const launchLog = path.join(profile.home, 'claude-stub.jsonl')
  const wrapper = path.join(profile.home, 'claude-stub')
  const stub = path.join(fixtureRoot, 'tests/e2e/fixtures/structured-claude-stub.cjs')
  function shellWord(value: string) {
    return "'" + value.replaceAll("'", "'\"'\"'") + "'"
  }
  await writeFile(
    wrapper,
    '#!/bin/sh\nexec ' + [process.execPath, stub, launchLog].map(shellWord).join(' ') + ' "$@"\n',
    { mode: 0o700 },
  )
  await orcaPage.evaluate(async (command) => {
    const state = window.__store?.getState()
    if (!state) throw new Error('The E2E renderer store did not load.')
    await state.updateSettings({
      agentDefaultSurface: 'chat',
      nativeChatProviders: { claude: true },
      agentCmdOverrides: { claude: command },
    })
  }, shellWord(wrapper))

  const workspace = 'path:' + seededRepoPath
  const parent = await cli(
    'agent', 'launch', '--agent', 'claude', '--surface', 'chat', '--worktree', workspace,
    '--prompt', 'Playbooks fixture parent', '--focus',
  )
  expect(parent.outcome.kind).toBe('structured')
  const parentId = parent.outcome.sessionId
  expect(parentId).toMatch(/^[0-9a-f-]{36}$/i)
  const parentHandle = 'orca_session_id:' + parentId
  await expect.poll(async () => (await cli('agent', 'show', parentHandle)).places.length).toBe(1)

  async function openFromHistory(name: string, sessionId: string, evidenceName: string) {
    await orcaPage.evaluate((chatId) => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) throw new Error('There is no active worktree.')
      const worktreeId = state.activeWorktreeId
      const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.contentType === 'agent-session' && candidate.entityId === chatId,
      )
      if (!tab) throw new Error('The coordinator tab is not open.')
      state.openModal('agent-session-history', {
        worktreeId, chatTabId: tab.id, initialQuery: '', agent: 'claude', alongside: true,
      })
    }, parentId)

    const history = orcaPage.getByRole('dialog', { name: 'Agent Session History' })
    await expect(history).toBeVisible()
    const row = history.locator('.ai-vault-session-row').filter({ hasText: name })
    await expect(row).toHaveCount(1)
    await row.click()
    await expect.poll(async () => (await cli('agent', 'show', sessionId)).places.length).toBe(1)
    await expect.poll(() => orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) return null
      const workspaceId = state.activeWorktreeId
      const group = state.groupsByWorktree[workspaceId]?.find(
        (item) => item.id === state.activeGroupIdByWorktree[workspaceId],
      )
      return state.unifiedTabsByWorktree[workspaceId]?.find(
        (item) => item.id === group?.activeTabId,
      )?.entityId
    })).toBe(sessionId.split(':')[1])
    await orcaPage.screenshot({ path: testInfo.outputPath(evidenceName + '.png') })
  }

  async function exerciseWorker(name: string, autoRelease: boolean) {
    const worker = await cli(
      'orchestration', 'worker-start', '--agent', 'claude', '--worktree', workspace,
      '--from', parentHandle, '--task-title', name, '--spec', 'Fixture marker ' + name,
      ...(autoRelease ? [] : ['--keep-open']),
    )
    expect(worker.mode).toBe('structured')
    const dispatch = (await cli('orchestration', 'dispatch-show', '--task', worker.taskId)).dispatch
    const rawSession = dispatch.assigneeOrcaSessionId ?? dispatch.assignee_orca_session_id
    expect(rawSession).toBeTruthy()
    const sessionId = rawSession.startsWith('orca_session_id:') ? rawSession : 'orca_session_id:' + rawSession
    await expect.poll(async () => JSON.stringify(await cli('agent', 'read', sessionId))).toContain('Stub reply.')
    await cli('chat', 'rename', '--session', sessionId.split(':')[1], '--name', name)
    const transcript = await cli('agent', 'read', sessionId)
    expect(JSON.stringify(transcript)).toContain('Fixture marker ' + name)
    await cli(
      'orchestration', 'send', '--from', worker.terminal, '--type', 'worker_done',
      '--subject', 'Fixture completed', '--body', 'Synthetic fixture completed.',
      '--task-id', worker.taskId, '--dispatch-id', worker.dispatchId, '--outcome', 'succeeded',
    )

    if (!autoRelease) {
      await openFromHistory(name, sessionId, 'already-open')
      const release = await cli('orchestration', 'worker-release', '--dispatch', worker.dispatchId)
      expect(release.state).toBe('released')
    }
    await expect.poll(async () => (await cli('agent', 'show', sessionId)).places.length, {
      timeout: autoRelease ? 155_000 : 15_000,
      intervals: [1_000, 2_000, 5_000],
    }).toBe(0)
    await openFromHistory(name, sessionId, autoRelease ? 'automatic-release' : 'manual-release')
    const restored = await cli('agent', 'read', sessionId)
    expect(restored.orcaSessionId).toBe(transcript.orcaSessionId)
    expect(restored.entries).toEqual(transcript.entries)
    expect(JSON.stringify(restored)).toContain('Fixture marker ' + name)
  }

  await exerciseWorker('Playbooks fixture manual worker', false)
  await exerciseWorker('Playbooks fixture automatic worker', true)
})
