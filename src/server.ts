import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Orchestrator } from './orchestrator.js';
import type { Issue, StateSnapshot } from './types.js';
import * as logger from './logger.js';

export function buildSnapshot(orchestrator: Orchestrator): StateSnapshot {
  const state = orchestrator.getState();

  const running = [...state.running.values()].map((e) => ({
    issueId: e.issue.id,
    issueIdentifier: e.identifier,
    state: e.issue.state,
    sessionId: e.sessionId,
    lastEvent: e.lastAgentEvent,
    lastMessage: e.lastAgentMessage,
    startedAt: e.startedAt.toISOString(),
    lastEventAt: e.lastAgentTimestamp?.toISOString() ?? null,
    tokens: {
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      totalTokens: e.totalTokens,
    },
  }));

  const retrying = [...state.retryQueue.values()].map((e) => ({
    issueId: e.issueId,
    issueIdentifier: e.identifier,
    attempt: e.attempt,
    dueAt: new Date(e.dueAtMs).toISOString(),
    error: e.error,
  }));

  return {
    generatedAt: new Date().toISOString(),
    counts: { running: running.length, retrying: retrying.length },
    running,
    retrying,
    agentTotals: { ...state.agentTotals },
    rateLimits: state.rateLimits,
  };
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface BoardData {
  columns: Array<{
    name: string;
    issues: Array<{
      issue: Issue;
      agentStatus: 'running' | 'retrying' | 'idle';
      tokens?: number;
      attempt?: number;
      startedAt?: string;
      lastEvent?: string | null;
      retryDueAt?: string;
      retryError?: string | null;
    }>;
  }>;
  snapshot: StateSnapshot;
}

async function buildBoardData(orchestrator: Orchestrator): Promise<BoardData> {
  const config = orchestrator.getConfig();
  const state = orchestrator.getState();
  const snapshot = buildSnapshot(orchestrator);

  // Fetch all project issues from Linear
  let allIssues: Issue[];
  try {
    allIssues = await orchestrator.getTracker().fetchAllProjectIssues();
  } catch (err) {
    logger.warn('Board: failed to fetch all issues, showing only orchestrator state', { error: String(err) });
    allIssues = [];
  }

  // Build running/retrying lookup sets
  const runningMap = new Map(
    [...state.running.values()].map((e) => [e.issue.id, e]),
  );
  const retryMap = new Map(
    [...state.retryQueue.values()].map((e) => [e.issueId, e]),
  );

  // Determine column order: active states first, then common non-active/non-terminal, then terminal
  const activeStates = config.tracker.activeStates;
  const terminalStates = config.tracker.terminalStates;

  // Collect all unique states from issues
  const allStates = new Set<string>();
  for (const issue of allIssues) {
    allStates.add(issue.state);
  }
  // Also add states from running/retrying that might not be in allIssues
  for (const entry of state.running.values()) {
    allStates.add(entry.issue.state);
  }

  // Build ordered state list
  const orderedStates: string[] = [];
  // 1. Active states in config order
  for (const s of activeStates) {
    if (allStates.has(s)) {
      orderedStates.push(s);
      allStates.delete(s);
    }
  }
  // 2. Non-terminal, non-active states
  const nonTerminalRest: string[] = [];
  const terminalFound: string[] = [];
  for (const s of allStates) {
    if (terminalStates.includes(s)) {
      terminalFound.push(s);
    } else {
      nonTerminalRest.push(s);
    }
  }
  orderedStates.push(...nonTerminalRest.sort());
  // 3. Terminal states in config order
  for (const s of terminalStates) {
    if (terminalFound.includes(s)) {
      orderedStates.push(s);
    }
  }

  // Build columns
  const columns = orderedStates.map((stateName) => {
    const issues = allIssues
      .filter((i) => i.state === stateName)
      .sort((a, b) => {
        const pa = a.priority ?? 999;
        const pb = b.priority ?? 999;
        return pa - pb || a.identifier.localeCompare(b.identifier);
      })
      .map((issue) => {
        const running = runningMap.get(issue.id);
        const retry = retryMap.get(issue.id);

        if (running) {
          return {
            issue,
            agentStatus: 'running' as const,
            tokens: running.totalTokens,
            startedAt: running.startedAt.toISOString(),
            lastEvent: running.lastAgentEvent,
          };
        }
        if (retry) {
          return {
            issue,
            agentStatus: 'retrying' as const,
            attempt: retry.attempt,
            retryDueAt: new Date(retry.dueAtMs).toISOString(),
            retryError: retry.error,
          };
        }
        return { issue, agentStatus: 'idle' as const };
      });

    return { name: stateName, issues };
  });

  return { columns, snapshot };
}

function renderBoard(data: BoardData): string {
  const { columns, snapshot } = data;

  const columnHtml = columns
    .map((col) => {
      const count = col.issues.length;
      const cards = col.issues
        .map((item) => {
          const { issue, agentStatus } = item;
          const statusClass = agentStatus;
          const priorityLabel = issue.priority !== null ? `P${issue.priority}` : '';
          const labels = issue.labels.length > 0
            ? `<div class="labels">${issue.labels.map((l) => `<span class="label">${escapeHtml(l)}</span>`).join('')}</div>`
            : '';

          let statusBadge = '';
          if (agentStatus === 'running') {
            const tokens = item.tokens ?? 0;
            statusBadge = `<div class="badge running">Running &middot; ${tokens.toLocaleString()} tk</div>`;
          } else if (agentStatus === 'retrying') {
            statusBadge = `<div class="badge retrying">Retry #${item.attempt ?? '?'}</div>`;
          }

          const url = issue.url ? ` href="${escapeHtml(issue.url)}" target="_blank"` : '';

          return `<div class="card ${statusClass}">
  <div class="card-header">
    <a class="identifier"${url}>${escapeHtml(issue.identifier)}</a>
    ${priorityLabel ? `<span class="priority">${priorityLabel}</span>` : ''}
  </div>
  <div class="card-title">${escapeHtml(issue.title)}</div>
  ${labels}
  ${statusBadge}
</div>`;
        })
        .join('');

      return `<div class="column">
  <div class="column-header">${escapeHtml(col.name)} <span class="count">${count}</span></div>
  <div class="column-body">${cards || '<div class="empty">No issues</div>'}</div>
</div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html><head><title>Conductor Board</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,system-ui,sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh}
.topbar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;align-items:center;justify-content:space-between}
.topbar h1{font-size:18px;color:#58a6ff;font-weight:600}
.topbar .stats{font-size:13px;color:#8b949e}
.topbar .stats span{margin-left:16px}
.board{display:flex;gap:12px;padding:16px 24px;overflow-x:auto;min-height:calc(100vh - 60px);align-items:flex-start}
.column{background:#161b22;border:1px solid #30363d;border-radius:8px;min-width:260px;max-width:320px;flex-shrink:0;display:flex;flex-direction:column}
.column-header{padding:12px 16px;font-weight:600;font-size:14px;border-bottom:1px solid #30363d;color:#c9d1d9;display:flex;align-items:center;justify-content:space-between}
.column-header .count{background:#30363d;color:#8b949e;border-radius:12px;padding:2px 8px;font-size:12px;font-weight:400}
.column-body{padding:8px;display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 120px);overflow-y:auto}
.card{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px;transition:border-color .15s}
.card:hover{border-color:#58a6ff}
.card.running{border-left:3px solid #3fb950}
.card.retrying{border-left:3px solid #d29922}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.identifier{font-size:13px;font-weight:600;color:#58a6ff;text-decoration:none}
.identifier:hover{text-decoration:underline}
.priority{font-size:11px;color:#8b949e;background:#21262d;border-radius:4px;padding:1px 6px}
.card-title{font-size:13px;color:#c9d1d9;line-height:1.4}
.labels{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px}
.label{font-size:11px;background:#1f2937;color:#8b949e;border-radius:12px;padding:2px 8px}
.badge{font-size:11px;margin-top:8px;padding:3px 8px;border-radius:4px;display:inline-block;font-weight:500}
.badge.running{background:#0f291a;color:#3fb950;border:1px solid #238636}
.badge.retrying{background:#2a1f00;color:#d29922;border:1px solid #9e6a03}
.empty{color:#484f58;font-size:13px;padding:16px;text-align:center}
.refresh-btn{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}
.refresh-btn:hover{background:#30363d;border-color:#58a6ff}
</style>
<script>
async function refreshBoard(){
  try{
    await fetch('/api/v1/refresh',{method:'POST'});
    setTimeout(()=>location.reload(),1500);
  }catch(e){console.error(e)}
}
setTimeout(()=>location.reload(),30000);
</script>
</head><body>
<div class="topbar">
  <h1>Conductor</h1>
  <div class="stats">
    <span>Running: ${snapshot.counts.running}</span>
    <span>Retrying: ${snapshot.counts.retrying}</span>
    <span>Tokens: ${snapshot.agentTotals.totalTokens.toLocaleString()}</span>
    <span>Uptime: ${snapshot.agentTotals.secondsRunning.toFixed(0)}s</span>
    <button class="refresh-btn" onclick="refreshBoard()">Refresh</button>
  </div>
</div>
<div class="board">${columnHtml}</div>
</body></html>`;
}

export function startServer(orchestrator: Orchestrator, port: number): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/') {
        const boardData = await buildBoardData(orchestrator);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderBoard(boardData));
        return;
      }

      if (req.method === 'GET' && path === '/api/v1/state') {
        sendJson(res, 200, buildSnapshot(orchestrator));
        return;
      }

      if (req.method === 'GET' && path === '/api/v1/board') {
        const boardData = await buildBoardData(orchestrator);
        sendJson(res, 200, boardData);
        return;
      }

      if (req.method === 'GET' && path.startsWith('/api/v1/')) {
        const identifier = path.slice('/api/v1/'.length);
        const state = orchestrator.getState();

        const running = [...state.running.values()].find((e) => e.identifier === identifier);
        if (running) {
          sendJson(res, 200, {
            issueId: running.issue.id,
            identifier: running.identifier,
            state: running.issue.state,
            sessionId: running.sessionId,
            lastEvent: running.lastAgentEvent,
            lastMessage: running.lastAgentMessage,
            tokens: { inputTokens: running.inputTokens, outputTokens: running.outputTokens, totalTokens: running.totalTokens },
            startedAt: running.startedAt.toISOString(),
          });
          return;
        }

        const retry = [...state.retryQueue.values()].find((e) => e.identifier === identifier);
        if (retry) {
          sendJson(res, 200, {
            issueId: retry.issueId,
            identifier: retry.identifier,
            attempt: retry.attempt,
            dueAt: new Date(retry.dueAtMs).toISOString(),
            error: retry.error,
          });
          return;
        }

        sendJson(res, 404, { error: 'Issue not found' });
        return;
      }

      if (req.method === 'POST' && path === '/api/v1/refresh') {
        orchestrator.triggerPoll().catch((err) => {
          logger.error('Manual poll trigger failed', { error: String(err) });
        });
        sendJson(res, 200, { status: 'poll triggered' });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error('Server request error', { error: String(err), path });
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`HTTP server listening on http://127.0.0.1:${port}`);
  });

  return server;
}
