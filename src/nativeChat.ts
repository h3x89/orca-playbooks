import { randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Temporary for Orca 1.4.274. Replace these private tab calls when Orca exposes
// a native-chat focus action: https://github.com/stablyai/orca/issues/42069
export const NATIVE_CHAT_ORCA_VERSION = '1.4.274'
const TIMEOUT_MS = 2500
const MAX_RESPONSE = 2 * 1024 * 1024
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

const CHAT_UNAVAILABLE = 'This chat tab is unavailable. Use Last lines or the step result.'

type Runtime = { socket: string; auth: string }
type TabSnapshot = {
  tabs: { id?: string; type?: string; sessionId?: string }[]
  activeTabId?: string
}

async function readRuntime(file: string, runtimeId: string): Promise<Runtime> {
  const owner = process.getuid?.()
  const fileInfo = await lstat(file)
  if (!fileInfo.isFile() || fileInfo.uid !== owner || (fileInfo.mode & 0o077) !== 0 || fileInfo.size > 16384) throw new Error()
  const metadata = JSON.parse(await readFile(file, 'utf8'))
  if (metadata.runtimeId !== runtimeId || typeof metadata.authToken !== 'string' || !metadata.authToken) throw new Error()

  const endpoint = metadata.transports?.find((transport: { kind?: string }) => transport.kind === 'unix')?.endpoint
  if (typeof endpoint !== 'string' || !path.isAbsolute(endpoint)) throw new Error()
  const socket = await lstat(endpoint)
  if (!socket.isSocket() || socket.uid !== owner) throw new Error()
  return { socket: endpoint, auth: metadata.authToken }
}

/** Two fixed local RPCs. Never return Orca metadata or transport errors to the panel. */
function tabRequest<T>(runtime: Runtime, method: 'session.tabs.list' | 'session.tabs.activate', params: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = createConnection(runtime.socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let consumed = 0
    const timer = setTimeout(() => socket.destroy(new Error()), TIMEOUT_MS)
    socket.once('error', () => reject(new Error()))
    socket.once('close', () => {
      clearTimeout(timer)
      reject(new Error())
    })
    socket.once('connect', () => {
      socket.write(JSON.stringify({ id, authToken: runtime.auth, method, params }) + '\n')
    })
    socket.on('data', (chunk: string) => {
      try {
        consumed += Buffer.byteLength(chunk)
        if (consumed > MAX_RESPONSE) throw new Error()
        buffer += chunk
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const frame = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          if (frame._keepalive) continue
          if (frame.id !== id || frame.ok !== true) throw new Error()
          resolve(frame.result as T)
          socket.destroy()
          return
        }
      } catch {
        socket.destroy(new Error())
      }
    })
  })
}

function matchingTab(snapshot: TabSnapshot, sessionId: string): string | undefined {
  const matches = snapshot.tabs.filter((tab) => tab.type === 'agent-session' && tab.sessionId === sessionId)
  return matches.length === 1 ? matches[0].id : undefined
}

/** Focus an existing tab. A closed or ambiguous session is never opened or resumed. */
export async function focusExistingNativeChat(
  workspaceId: string,
  sessionId: string,
  runtimeId: string,
  metadataFile = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'orca', 'orca-runtime.json')
): Promise<void> {
  try {
    if (!workspaceId || !UUID.test(sessionId) || !UUID.test(runtimeId)) throw new Error()
    const runtime = await readRuntime(metadataFile, runtimeId)
    const params = { worktree: workspaceId }
    const before = await tabRequest<TabSnapshot>(runtime, 'session.tabs.list', params)
    const tabId = matchingTab(before, sessionId)
    if (!tabId) throw new Error()
    await tabRequest(runtime, 'session.tabs.activate', { ...params, tabId, notifyClients: true })
    // Orca acknowledges the request before its renderer updates the active tab.
    const deadline = Date.now() + 1000
    do {
      const after = await tabRequest<TabSnapshot>(runtime, 'session.tabs.list', params)
      if (matchingTab(after, sessionId) !== tabId) throw new Error()
      if (after.activeTabId === tabId) return
      await delay(80)
    } while (Date.now() < deadline)
    throw new Error()
  } catch {
    throw new Error(CHAT_UNAVAILABLE)
  }
}
