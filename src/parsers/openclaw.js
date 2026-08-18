import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { queryDbJsonSnapshotOnLock } from './sqlite.js';

// OpenClaw >= 2026.8 stores data in SQLite at ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite (table transcript_events)
// Legacy OpenClaw (< 2026.8) stores data at ~/.openclaw/agents/<agentId>/sessions/*.jsonl
// Profile deployments use ~/.openclaw-<profile>/agents/...
// Legacy paths: ~/.clawdbot, ~/.moltbot, ~/.moldbot, ~/.qclaw
export function getPossibleRoots() {
  const override = process.env.VIBE_USAGE_OPENCLAW_DIRS?.trim();
  if (override) return override.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const home = homedir();
  const roots = [
    join(home, '.clawdbot'),
    join(home, '.moltbot'),
    join(home, '.moldbot'),
    join(home, '.qclaw'),
  ];
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.openclaw' || /^\.openclaw-.+/.test(entry.name) || entry.name === '.qclaw' || /^\.qclaw-.+/.test(entry.name)) {
        roots.push(join(home, entry.name));
      }
    }
  } catch {
    // ignore read errors
  }
  return [...new Set(roots)];
}

/** Normalize usage fields — OpenClaw supports multiple naming conventions */
function getTokens(usage, ...keys) {
  if (!usage || typeof usage !== 'object') return 0;
  for (const key of keys) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function parseMessageObj(obj, fallbackSessionId, project, fallbackCreatedAt, sessionEvents, entries) {
  if (obj?.type !== 'message') return;
  const msg = obj.message;
  if (!msg) return;

  const timestamp = obj.timestamp || msg.timestamp || fallbackCreatedAt;
  if (!timestamp) return;
  const ts = new Date(typeof timestamp === 'number' ? timestamp : timestamp);
  if (isNaN(ts.getTime())) return;

  sessionEvents.push({
    sessionId: fallbackSessionId,
    source: 'openclaw',
    project,
    timestamp: ts,
    role: msg.role === 'user' ? 'user' : 'assistant',
  });

  if (msg.role !== 'assistant') return;
  const usage = msg.usage;
  if (!usage) return;

  const inputTokens = getTokens(
    usage,
    'input',
    'inputTokens',
    'input_tokens',
    'promptTokens',
    'prompt_tokens',
  );
  const cacheWriteTokens = getTokens(
    usage,
    'cacheCreation',
    'cacheCreationInputTokens',
    'cacheWrite',
    'cache_creation',
    'cache_write',
    'cache_creation_input_tokens',
    'cache_write_input_tokens',
  );
  const outputTokens = getTokens(
    usage,
    'output',
    'outputTokens',
    'output_tokens',
    'completionTokens',
    'completion_tokens',
  );
  const cachedInputTokens = getTokens(
    usage,
    'cacheRead',
    'cache_read',
    'cache_read_input_tokens',
  );
  const reasoningOutputTokens = getTokens(
    usage,
    'reasoningTokens',
    'reasoning_tokens',
    'reasoningOutputTokens',
    'thoughtTokens',
    'thoughts',
  );

  entries.push({
    source: 'openclaw',
    model: msg.model || obj.model || 'unknown',
    project,
    timestamp: ts,
    inputTokens: inputTokens + cacheWriteTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
  });
}

export async function parse() {
  const entries = [];
  const sessionEvents = [];

  for (const root of getPossibleRoots()) {
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) continue;

    let agentDirs;
    try {
      agentDirs = readdirSync(agentsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'));
    } catch {
      continue;
    }

    for (const agentDir of agentDirs) {
      const project = agentDir.name;
      const agentPath = join(agentsDir, agentDir.name);
      const parsedSessionIds = new Set();

      // 1. Try SQLite database first (OpenClaw >= 2026.8)
      const sqliteCandidates = [
        join(agentPath, 'agent', 'openclaw-agent.sqlite'),
        join(agentPath, 'openclaw-agent.sqlite'),
      ];
      const dbPath = sqliteCandidates.find(p => existsSync(p));

      if (dbPath) {
        try {
          // Use json_extract to query only required metadata fields, avoiding loading massive message text payloads
          const sql = `
            SELECT
              session_id,
              created_at,
              json_extract(event_json, '$.type') as type,
              json_extract(event_json, '$.timestamp') as obj_timestamp,
              json_extract(event_json, '$.model') as obj_model,
              json_extract(event_json, '$.message.role') as role,
              json_extract(event_json, '$.message.timestamp') as msg_timestamp,
              json_extract(event_json, '$.message.model') as msg_model,
              json_extract(event_json, '$.message.usage') as usage
            FROM transcript_events
            WHERE json_extract(event_json, '$.type') = 'message'
            ORDER BY created_at ASC
          `;
          const rows = queryDbJsonSnapshotOnLock(dbPath, sql, {
            tempPrefix: 'vibe-usage-openclaw-',
            opts: { maxBuffer: 100 * 1024 * 1024, timeout: 30000 },
          });
          if (Array.isArray(rows) && rows.length > 0) {
            for (const row of rows) {
              try {
                const sessionId = row.session_id || 'unknown';
                parsedSessionIds.add(sessionId);

                let usageVal = null;
                if (typeof row.usage === 'string') {
                  try { usageVal = JSON.parse(row.usage); } catch {}
                } else if (typeof row.usage === 'object' && row.usage !== null) {
                  usageVal = row.usage;
                }

                const obj = {
                  type: row.type || 'message',
                  timestamp: row.obj_timestamp,
                  model: row.obj_model,
                  message: row.role ? {
                    role: row.role,
                    timestamp: row.msg_timestamp,
                    model: row.msg_model,
                    usage: usageVal,
                  } : undefined,
                };
                parseMessageObj(obj, sessionId, project, row.created_at, sessionEvents, entries);
              } catch {}
            }
          }
        } catch {
          // If SQLite query failed, proceed to check JSONL files
        }
      }

      // 2. Check legacy / unmigrated JSONL session logs (skipping sessions already parsed from SQLite)
      const sessionsDir = join(agentPath, 'sessions');
      if (existsSync(sessionsDir)) {
        let files;
        try {
          files = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
        } catch {
          files = [];
        }

        for (const file of files) {
          const fileSessionId = file.slice(0, -6);
          if (parsedSessionIds.has(fileSessionId)) {
            // Already parsed from SQLite database, skip to prevent double counting
            continue;
          }

          const filePath = join(sessionsDir, file);
          let content;
          try {
            content = readFileSync(filePath, 'utf-8');
          } catch {
            continue;
          }

          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              const objSessionId = obj.sessionId || obj.session_id || fileSessionId;
              if (parsedSessionIds.has(objSessionId)) continue;
              parseMessageObj(obj, objSessionId, project, undefined, sessionEvents, entries);
            } catch {}
          }
        }
      }
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
