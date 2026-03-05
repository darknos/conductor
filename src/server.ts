import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Orchestrator } from './orchestrator.js';
import type { StateSnapshot } from './types.js';
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

function sendHtml(res: ServerResponse, snapshot: StateSnapshot): void {
  const runningRows = snapshot.running
    .map(
      (r) =>
        `<tr><td>${r.issueIdentifier}</td><td>${r.state}</td><td>${r.lastEvent ?? '-'}</td><td>${r.tokens.totalTokens}</td><td>${r.startedAt}</td></tr>`,
    )
    .join('');

  const retryRows = snapshot.retrying
    .map(
      (r) =>
        `<tr><td>${r.issueIdentifier}</td><td>${r.attempt}</td><td>${r.dueAt}</td><td>${r.error ?? '-'}</td></tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html><head><title>Conductor Dashboard</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:monospace;margin:2em;background:#111;color:#eee}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid #333;padding:6px 10px;text-align:left}
th{background:#222}
h1{color:#8cf}h2{color:#adf}
.totals{background:#1a1a2e;padding:1em;border-radius:4px;margin:1em 0}
</style></head><body>
<h1>Conductor Dashboard</h1>
<p>Generated: ${snapshot.generatedAt}</p>
<div class="totals">
<strong>Totals:</strong> ${snapshot.agentTotals.totalTokens} tokens | ${snapshot.agentTotals.secondsRunning.toFixed(1)}s running
</div>
<h2>Running (${snapshot.counts.running})</h2>
<table><tr><th>Issue</th><th>State</th><th>Last Event</th><th>Tokens</th><th>Started</th></tr>${runningRows || '<tr><td colspan="5">None</td></tr>'}</table>
<h2>Retry Queue (${snapshot.counts.retrying})</h2>
<table><tr><th>Issue</th><th>Attempt</th><th>Due</th><th>Error</th></tr>${retryRows || '<tr><td colspan="4">None</td></tr>'}</table>
</body></html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function startServer(orchestrator: Orchestrator, port: number): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/') {
      sendHtml(res, buildSnapshot(orchestrator));
      return;
    }

    if (req.method === 'GET' && path === '/api/v1/state') {
      sendJson(res, 200, buildSnapshot(orchestrator));
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
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`HTTP server listening on http://127.0.0.1:${port}`);
  });

  return server;
}
