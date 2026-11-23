import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { devNull, homedir } from 'node:os'
import path from 'node:path'

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

// Temporary local fallback until Orca exposes the timestamp: https://github.com/stablyai/orca/issues/47231.
// Read metadata only. For a compacted journal, require the original submission (ordinal 0).
export async function localFirstPrompts(config: unknown, sessionIds: string[]): Promise<Map<string, number>> {
  const times = new Map<string, number>()
  if (typeof config !== 'string' || !config.trim()) return times
  const configured = config.trim()
  const database = configured.startsWith('~/') ? path.join(homedir(), configured.slice(2)) : configured
  if (!path.isAbsolute(database) || path.basename(database) !== 'agent-session-domain.db' || !existsSync(database)) return times
  const ids = [...new Set(sessionIds.filter((id) => SESSION_ID.test(id)))].slice(0, 500)
  if (!ids.length) return times

  const query = `SELECT a.session_id, MIN(a.submitted_at) AS first_prompt_at
    FROM journal_submission_attempts a
    JOIN journal_chat_state c USING (session_id, epoch)
    JOIN journal_items i USING (session_id, epoch, item_id)
    WHERE a.session_id IN (${ids.map((id) => `'${id}'`).join(',')})
      AND a.admitted_personal=1 AND a.dispatch_state='accepted'
      AND a.current=1 AND a.request_failure=0
      AND i.kind='message' AND i.message_role='user' AND i.root=1 AND i.command_entry=0
      AND (c.retained_sequence=0 OR a.ordinal=0)
    GROUP BY a.session_id;`
  const output = await new Promise<string>((resolve) => {
    execFile('sqlite3', ['-batch', '-init', devNull, '-safe', '-readonly', '-json', database, query],
      { timeout: 1000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout))
  })
  if (!output) return times
  try {
    for (const { session_id, first_prompt_at } of JSON.parse(output) as { session_id: string; first_prompt_at: number }[]) {
      if (ids.includes(session_id) && Number.isSafeInteger(first_prompt_at) && first_prompt_at > 0 && first_prompt_at <= 8.64e15) times.set(session_id, first_prompt_at)
    }
  } catch {
    // An unavailable or incompatible local journal has no timestamp to show.
  }
  return times
}
