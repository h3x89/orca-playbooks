import { assert, test } from 'orca/testing'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { localFirstPrompts } from './firstPrompt'

const original = '00000000-0000-0000-0000-000000000001'
const incomplete = '00000000-0000-0000-0000-000000000002'
const compacted = '00000000-0000-0000-0000-000000000003'

test('reads the first accepted personal prompt only, including a retained original submission', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'playbooks-journal-'))
  try {
    const db = path.join(dir, 'agent-session-domain.db')
    execFileSync('sqlite3', ['-batch', '-init', os.devNull, db, `
      CREATE TABLE journal_chat_state (session_id TEXT, epoch TEXT, retained_sequence INT);
      CREATE TABLE journal_items (session_id TEXT, epoch TEXT, item_id TEXT, kind TEXT, message_role TEXT, root INT, command_entry INT);
      CREATE TABLE journal_submission_attempts (session_id TEXT, epoch TEXT, item_id TEXT,
        submitted_at INT, admitted_personal INT, dispatch_state TEXT, current INT, request_failure INT, ordinal INT);
      INSERT INTO journal_chat_state VALUES ('${original}', 'now', 0), ('${incomplete}', 'now', 15), ('${compacted}', 'now', 15);
      INSERT INTO journal_items VALUES
        ('${original}','now','automated','message','user',1,0), ('${original}','now','rejected','message','user',1,0),
        ('${original}','now','prompt','message','user',1,0), ('${original}','now','next','message','user',1,0),
        ('${incomplete}','now','later','message','user',1,0), ('${compacted}','now','retained','message','user',1,0),
        ('${original}','past','old','message','user',1,0), ('${original}','now','slash','message','user',1,1);
      INSERT INTO journal_submission_attempts VALUES
        ('${original}','now','automated',10,0,'accepted',1,0,0), ('${original}','now','rejected',20,1,'rejected',1,1,1),
        ('${original}','now','prompt',30,1,'accepted',1,0,2), ('${original}','now','next',40,1,'accepted',1,0,3),
        ('${incomplete}','now','later',50,1,'accepted',1,0,4), ('${compacted}','now','retained',60,1,'accepted',1,0,0),
        ('${original}','past','old',5,1,'accepted',1,0,0), ('${original}','now','slash',25,1,'accepted',1,0,2);
    `])
    assert.deepEqual(await localFirstPrompts(db, [original, incomplete, compacted, "invalid')"]), new Map([[original, 30], [compacted, 60]]))
    assert.deepEqual(await localFirstPrompts('', [original]), new Map())
    assert.deepEqual(await localFirstPrompts(path.join(dir, 'missing/agent-session-domain.db'), [original]), new Map())
    execFileSync('sqlite3', ['-batch', '-init', os.devNull, db, 'DROP TABLE journal_items;'])
    assert.deepEqual(await localFirstPrompts(db, [original]), new Map())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
