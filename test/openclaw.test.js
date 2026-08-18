import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, getPossibleRoots } from '../src/parsers/openclaw.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function createFixtureDb(dbPath, sql) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {}
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return;
  }
  execFileSync('sqlite3', [dbPath, sql]);
}

test('OpenClaw is registered as a parser and detected tool', () => {
  assert.equal(typeof parsers.openclaw, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'openclaw')?.name, 'OpenClaw');
});

test('getPossibleRoots honors VIBE_USAGE_OPENCLAW_DIRS override', () => {
  const orig = process.env.VIBE_USAGE_OPENCLAW_DIRS;
  try {
    process.env.VIBE_USAGE_OPENCLAW_DIRS = process.platform === 'win32'
      ? 'C:\\temp\\openclaw1;C:\\temp\\openclaw2'
      : '/tmp/openclaw1:/tmp/openclaw2';
    const roots = getPossibleRoots();
    assert.deepEqual(roots, process.platform === 'win32'
      ? ['C:\\temp\\openclaw1', 'C:\\temp\\openclaw2']
      : ['/tmp/openclaw1', '/tmp/openclaw2']);
  } finally {
    if (orig !== undefined) {
      process.env.VIBE_USAGE_OPENCLAW_DIRS = orig;
    } else {
      delete process.env.VIBE_USAGE_OPENCLAW_DIRS;
    }
  }
});

test('parse reads OpenClaw >= 2026.8 SQLite transcript_events with json_extract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-openclaw-test-'));
  const orig = process.env.VIBE_USAGE_OPENCLAW_DIRS;
  try {
    process.env.VIBE_USAGE_OPENCLAW_DIRS = root;
    const agentDir = join(root, 'agents', 'main', 'agent');
    mkdirSync(agentDir, { recursive: true });
    const dbPath = join(agentDir, 'openclaw-agent.sqlite');

    const userEvent = JSON.stringify({
      type: 'message',
      timestamp: '2026-08-18T10:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Hello '.repeat(100) }],
      },
    });

    const assistantEvent = JSON.stringify({
      type: 'message',
      timestamp: '2026-08-18T10:01:00.000Z',
      message: {
        role: 'assistant',
        model: 'gemini-3.7-flash',
        content: [{ type: 'text', text: 'Large response body '.repeat(500) }],
        usage: {
          input: 1000,
          cacheWrite: 200,
          output: 150,
          cacheRead: 500,
          reasoningTokens: 50,
        },
      },
    });

    const nonMessageEvent = JSON.stringify({
      type: 'model_change',
      timestamp: '2026-08-18T09:59:00.000Z',
      model: 'gemini-3.7-flash',
    });

    await createFixtureDb(dbPath, `
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      INSERT INTO transcript_events VALUES
        ('session-1', 1, ${sqlLiteral(nonMessageEvent)}, 1787047140000),
        ('session-1', 2, ${sqlLiteral(userEvent)}, 1787047200000),
        ('session-1', 3, ${sqlLiteral(assistantEvent)}, 1787047260000);
    `);

    const result = await parse();
    assert.equal(result.buckets.length, 1);
    const b = result.buckets[0];
    assert.equal(b.source, 'openclaw');
    assert.equal(b.model, 'gemini-3.7-flash');
    assert.equal(b.project, 'main');
    assert.equal(b.inputTokens, 1200); // input (1000) + cacheWrite (200)
    assert.equal(b.outputTokens, 150);
    assert.equal(b.cachedInputTokens, 500);
    assert.equal(b.reasoningOutputTokens, 50);
    assert.equal(b.totalTokens, 1400); // 1200 + 150 + 50

    assert.equal(result.sessions.length, 1);
    const s = result.sessions[0];
    assert.equal(s.source, 'openclaw');
    assert.equal(s.project, 'main');
    assert.equal(s.messageCount, 2);
    assert.equal(s.userMessageCount, 1);
  } finally {
    if (orig !== undefined) {
      process.env.VIBE_USAGE_OPENCLAW_DIRS = orig;
    } else {
      delete process.env.VIBE_USAGE_OPENCLAW_DIRS;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('parse deduplicates overlapping SQLite and JSONL while including unmigrated JSONL sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-openclaw-dedup-test-'));
  const orig = process.env.VIBE_USAGE_OPENCLAW_DIRS;
  try {
    process.env.VIBE_USAGE_OPENCLAW_DIRS = root;
    const agentRoot = join(root, 'agents', 'main');
    const agentDbDir = join(agentRoot, 'agent');
    const sessionsDir = join(agentRoot, 'sessions');
    mkdirSync(agentDbDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });

    // 1. Session 1 is in SQLite
    const assistantEventSqlite = JSON.stringify({
      type: 'message',
      timestamp: '2026-08-18T10:01:00.000Z',
      message: {
        role: 'assistant',
        model: 'gemini-3.7-flash',
        usage: { input: 1000, output: 200 },
      },
    });

    await createFixtureDb(join(agentDbDir, 'openclaw-agent.sqlite'), `
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      INSERT INTO transcript_events VALUES
        ('session-overlap', 1, ${sqlLiteral(assistantEventSqlite)}, 1787047260000);
    `);

    // 2. session-overlap.jsonl is ALSO in sessions/ (should be skipped to avoid double-counting)
    const duplicateJsonl = JSON.stringify({
      type: 'message',
      sessionId: 'session-overlap',
      timestamp: '2026-08-18T10:01:00.000Z',
      message: {
        role: 'assistant',
        model: 'gemini-3.7-flash',
        usage: { input: 1000, output: 200 },
      },
    });
    writeFileSync(join(sessionsDir, 'session-overlap.jsonl'), duplicateJsonl + '\n', 'utf-8');

    // 3. session-unmigrated.jsonl is ONLY in sessions/ (should be parsed)
    const unmigratedJsonl = JSON.stringify({
      type: 'message',
      sessionId: 'session-unmigrated',
      timestamp: '2026-08-18T10:05:00.000Z',
      message: {
        role: 'assistant',
        model: 'gemini-3.7-flash',
        usage: { input: 500, output: 100 },
      },
    });
    writeFileSync(join(sessionsDir, 'session-unmigrated.jsonl'), unmigratedJsonl + '\n', 'utf-8');

    const result = await parse();
    assert.equal(result.buckets.length, 1);
    const b = result.buckets[0];
    // 1000 (from SQLite session-overlap) + 500 (from unmigrated JSONL) = 1500 input
    // 200 (from SQLite session-overlap) + 100 (from unmigrated JSONL) = 300 output
    assert.equal(b.inputTokens, 1500);
    assert.equal(b.outputTokens, 300);
    assert.equal(result.sessions.length, 2);
  } finally {
    if (orig !== undefined) {
      process.env.VIBE_USAGE_OPENCLAW_DIRS = orig;
    } else {
      delete process.env.VIBE_USAGE_OPENCLAW_DIRS;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('parse reads legacy OpenClaw < 2026.8 JSONL session logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-openclaw-legacy-test-'));
  const orig = process.env.VIBE_USAGE_OPENCLAW_DIRS;
  try {
    process.env.VIBE_USAGE_OPENCLAW_DIRS = root;
    const sessionsDir = join(root, 'agents', 'helper', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    const lines = [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-18T11:00:00.000Z',
        message: { role: 'user', content: 'Help me' },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-08-18T11:00:30.000Z',
        message: {
          role: 'assistant',
          model: 'claude-3-5-sonnet',
          usage: {
            prompt_tokens: 300,
            cache_creation_input_tokens: 100,
            completion_tokens: 80,
            cache_read_input_tokens: 200,
          },
        },
      }),
    ].join('\n');

    writeFileSync(join(sessionsDir, 'session-legacy.jsonl'), lines, 'utf-8');

    const result = await parse();
    assert.equal(result.buckets.length, 1);
    const b = result.buckets[0];
    assert.equal(b.source, 'openclaw');
    assert.equal(b.model, 'claude-3-5-sonnet');
    assert.equal(b.project, 'helper');
    assert.equal(b.inputTokens, 400); // 300 + 100
    assert.equal(b.outputTokens, 80);
    assert.equal(b.cachedInputTokens, 200);
    assert.equal(b.totalTokens, 480);

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].project, 'helper');
  } finally {
    if (orig !== undefined) {
      process.env.VIBE_USAGE_OPENCLAW_DIRS = orig;
    } else {
      delete process.env.VIBE_USAGE_OPENCLAW_DIRS;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('parse skips hidden directories and gracefully handles corrupt JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-openclaw-corrupt-test-'));
  const orig = process.env.VIBE_USAGE_OPENCLAW_DIRS;
  try {
    process.env.VIBE_USAGE_OPENCLAW_DIRS = root;
    const gitDir = join(root, 'agents', '.git', 'sessions');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'ignored.jsonl'), 'not valid json\n', 'utf-8');

    const agentDir = join(root, 'agents', 'corrupt_agent', 'sessions');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'test.jsonl'), 'invalid json string\n{}\n', 'utf-8');

    const result = await parse();
    assert.equal(result.buckets.length, 0);
    assert.equal(result.sessions.length, 0);
  } finally {
    if (orig !== undefined) {
      process.env.VIBE_USAGE_OPENCLAW_DIRS = orig;
    } else {
      delete process.env.VIBE_USAGE_OPENCLAW_DIRS;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
