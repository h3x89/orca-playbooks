const { randomUUID } = require('node:crypto')
const { appendFileSync, mkdirSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

module.exports = function recordingWriter(sessionId) {
  const cwd = process.cwd()
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const projectDir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  const transcript = join(projectDir, sessionId + '.jsonl')
  mkdirSync(projectDir, { recursive: true })

  let parentUuid = null
  return (frame) => {
    if (frame.type === 'user' || frame.type === 'assistant') {
      const uuid = frame.uuid || randomUUID()
      appendFileSync(transcript, JSON.stringify({
        parentUuid,
        isSidechain: false,
        type: frame.type,
        message: frame.message,
        uuid,
        timestamp: new Date().toISOString(),
        cwd,
        sessionId,
      }) + '\n')
      parentUuid = uuid
    }
    process.stdout.write(JSON.stringify(frame) + '\n')
  }
}
