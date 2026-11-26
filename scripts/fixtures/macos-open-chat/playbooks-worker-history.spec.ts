import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
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

  function runLine(args: string[], output: string) {
    return 'run: ' + args.map(shellWord).join(' ') + ' >' + shellWord(output) + ' 2>' + shellWord(output + '.stderr')
  }
  async function receipt(file: string) {
    await expect.poll(async () => (await readFile(file, 'utf8').catch(() => '')).trim(), {
      timeout: 45_000,
    }).not.toBe('').catch(async (error) => {
      const detail = await readFile(file + '.stderr', 'utf8').catch(() => '')
      throw new Error('No fixture receipt: ' + path.basename(file) + (detail ? '\n' + detail : ''), { cause: error })
    })
    const response = JSON.parse(await readFile(file, 'utf8'))
    expect(response.ok, JSON.stringify(response.error)).toBe(true)
    return response.result
  }

  const workspace = 'path:' + seededRepoPath
  const reportScript = path.join(fixtureRoot, 'tests/e2e/golden-journeys/playbooks-fixture-report.cjs')
  const cases = [
    { name: 'Playbooks fixture manual worker', autoRelease: false, suffix: 'manual' },
    { name: 'Playbooks fixture automatic worker', autoRelease: true, suffix: 'automatic' },
  ].map((scenario) => ({
    ...scenario,
    startLog: path.join(profile.home, 'worker-start-' + scenario.suffix + '.json'),
    doneLog: path.join(profile.home, 'worker-done-' + scenario.suffix + '.json'),
  }))
  const launchLines = await Promise.all(cases.map(async ({ name, suffix, autoRelease, startLog, doneLog }) => {
    const marker = 'Fixture marker ' + name
    const report = runLine(
      [process.execPath, reportScript, cliEntry, launchLog.replace(/\.jsonl$/, '-inputs.jsonl'), marker],
      doneLog,
    )
    const spec = path.join(profile.home, 'worker-spec-' + suffix + '.txt')
    await writeFile(spec, marker + '\n' + report + '\n')
    return runLine([
      process.execPath, cliEntry, 'orchestration', 'worker-start', '--agent', 'claude',
      '--worktree', workspace, '--task-title', name, '--spec-file', spec,
      ...(autoRelease ? [] : ['--keep-open']), '--json',
    ], startLog)
  }))
  const parent = await cli(
    'agent', 'launch', '--agent', 'claude', '--surface', 'chat', '--worktree', workspace,
    '--prompt', ['Playbooks fixture parent', ...launchLines].join('\n'), '--focus',
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

  async function exerciseWorker({ name, autoRelease, startLog, doneLog }: typeof cases[number]) {
    const worker = await receipt(startLog)
    expect(worker.mode).toBe('structured')
    const dispatch = (await cli('orchestration', 'dispatch-show', '--task', worker.taskId)).dispatch
    const rawSession = dispatch.assigneeOrcaSessionId ?? dispatch.assignee_orca_session_id
    expect(rawSession).toBeTruthy()
    const sessionId = rawSession.startsWith('orca_session_id:') ? rawSession : 'orca_session_id:' + rawSession
    await expect.poll(async () => JSON.stringify(await cli('agent', 'read', sessionId))).toContain('Stub reply.')
    await cli('chat', 'rename', '--session', sessionId.split(':')[1], '--name', name)
    const transcript = await cli('agent', 'read', sessionId)
    expect(JSON.stringify(transcript)).toContain('Fixture marker ' + name)
    await receipt(doneLog)

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

  for (const scenario of cases) await exerciseWorker(scenario)
})
