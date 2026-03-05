import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRunner } from '../src/agent-runner.js';
import type { AgentSDK, SDKMessage, AgentQueryOptions } from '../src/agent-runner.js';
import type { Issue, AgentConfig, HookScripts } from '../src/types.js';
import { ExitReason } from '../src/types.js';
import { WorkspaceManager } from '../src/workspace.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const noHooks: HookScripts = {
  afterCreate: null,
  beforeRun: null,
  afterRun: null,
  beforeRemove: null,
  timeoutMs: 5000,
};

const defaultAgentConfig: AgentConfig = {
  maxConcurrentAgents: 10,
  maxTurns: 20,
  maxRetryBackoffMs: 300_000,
  maxConcurrentAgentsByState: {},
  permissionMode: null,
  allowedTools: ['Read', 'Edit'],
  disallowedTools: [],
  model: null,
  systemPrompt: null,
  turnTimeoutMs: 60_000,
  stallTimeoutMs: 30_000,
  maxBudgetUsd: null,
  env: {},
  sandbox: null,
};

const testIssue: Issue = {
  id: 'issue-1',
  identifier: 'TEST-1',
  title: 'Test Issue',
  description: 'Fix the bug',
  priority: 1,
  state: 'Todo',
  branchName: null,
  url: 'https://linear.app/TEST-1',
  labels: ['bug'],
  blockedBy: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeMockSDK(messages: SDKMessage[]): AgentSDK {
  return {
    async *query(_options: AgentQueryOptions): AsyncGenerator<SDKMessage> {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

describe('AgentRunner', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'conductor-agent-test-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('renders prompt with issue variables', async () => {
    const sdk = makeMockSDK([
      { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
    ]);

    const wsManager = new WorkspaceManager(tempRoot, noHooks);
    const runner = new AgentRunner({
      agentConfig: defaultAgentConfig,
      hooks: noHooks,
      workspaceManager: wsManager,
      sdk,
    });

    const template = 'Working on {{ issue.identifier }}: {{ issue.title }}';
    const result = await runner.runAttempt(testIssue, null, template);

    expect(result.reason).toBe(ExitReason.Normal);
    expect(result.metrics.totalTokens).toBe(150);
  });

  it('handles SDK error result', async () => {
    const sdk = makeMockSDK([
      { type: 'result', subtype: 'error', error: 'API rate limit' },
    ]);

    const wsManager = new WorkspaceManager(tempRoot, noHooks);
    const events: any[] = [];
    const runner = new AgentRunner({
      agentConfig: defaultAgentConfig,
      hooks: noHooks,
      workspaceManager: wsManager,
      sdk,
      onEvent: (e) => events.push(e),
    });

    const result = await runner.runAttempt(testIssue, null, 'prompt');

    expect(result.reason).toBe(ExitReason.Failure);
    expect(result.error).toBe('API rate limit');
    expect(events.some((e) => e.type === 'turn_failed')).toBe(true);
  });

  it('tracks turns via assistant messages', async () => {
    const sdk = makeMockSDK([
      { type: 'assistant', content: [{ type: 'text', text: 'Working...' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { type: 'result', subtype: 'success', usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 } },
    ]);

    const wsManager = new WorkspaceManager(tempRoot, noHooks);
    const events: any[] = [];
    const runner = new AgentRunner({
      agentConfig: defaultAgentConfig,
      hooks: noHooks,
      workspaceManager: wsManager,
      sdk,
      onEvent: (e) => events.push(e),
    });

    const result = await runner.runAttempt(testIssue, null, 'prompt');

    expect(result.reason).toBe(ExitReason.Normal);
    expect(result.metrics.turnsCompleted).toBe(2);
    expect(events.filter((e) => e.type === 'turn_completed')).toHaveLength(2);
  });

  it('handles abort via signal', async () => {
    const controller = new AbortController();

    const sdk: AgentSDK = {
      async *query(): AsyncGenerator<SDKMessage> {
        yield { type: 'assistant', content: [{ type: 'text', text: 'Start' }] };
        controller.abort();
        yield { type: 'result', subtype: 'success' };
      },
    };

    const wsManager = new WorkspaceManager(tempRoot, noHooks);
    const runner = new AgentRunner({
      agentConfig: defaultAgentConfig,
      hooks: noHooks,
      workspaceManager: wsManager,
      sdk,
    });

    const result = await runner.runAttempt(testIssue, null, 'prompt', controller.signal);
    expect(result.reason).toBe(ExitReason.CanceledByReconciliation);
  });

  it('fails on before_run hook error', async () => {
    const hooks: HookScripts = {
      ...noHooks,
      beforeRun: 'exit 1',
    };

    const sdk = makeMockSDK([]);
    const wsManager = new WorkspaceManager(tempRoot, hooks);
    const runner = new AgentRunner({
      agentConfig: defaultAgentConfig,
      hooks,
      workspaceManager: wsManager,
      sdk,
    });

    const result = await runner.runAttempt(testIssue, null, 'prompt');
    expect(result.reason).toBe(ExitReason.Failure);
    expect(result.error).toContain('before_run hook failed');
  });

  it('renders retry attempt in template', async () => {
    let capturedPrompt = '';
    const sdk: AgentSDK = {
      async *query(options: AgentQueryOptions): AsyncGenerator<SDKMessage> {
        capturedPrompt = options.prompt;
        yield { type: 'result', subtype: 'success' };
      },
    };

    const wsManager = new WorkspaceManager(tempRoot, noHooks);
    const runner = new AgentRunner({
      agentConfig: defaultAgentConfig,
      hooks: noHooks,
      workspaceManager: wsManager,
      sdk,
    });

    const template = '{% if attempt %}Retry #{{ attempt }}{% else %}First run{% endif %}';
    await runner.runAttempt(testIssue, 3, template);
    expect(capturedPrompt).toBe('Retry #3');

    await runner.runAttempt(testIssue, null, template);
    expect(capturedPrompt).toBe('First run');
  });
});
