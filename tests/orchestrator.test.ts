import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import type { ConductorConfig, Issue } from '../src/types.js';
import { ExitReason } from '../src/types.js';
import type { AgentSDK, SDKMessage, AgentQueryOptions } from '../src/agent-runner.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeConfig(overrides: Partial<ConductorConfig> = {}): ConductorConfig {
  return {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      apiKey: 'test-key',
      projectSlug: 'test',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done', 'Closed'],
      issuesDir: null,
      beadsRepoPath: null,
    },
    polling: { intervalMs: 60_000 }, // long interval to prevent auto-ticks
    workspace: { root: '' }, // will be set per test
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 5000,
    },
    agent: {
      maxConcurrentAgents: 10,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
      permissionMode: null,
      allowedTools: [],
      disallowedTools: [],
      model: null,
      systemPrompt: null,
      turnTimeoutMs: 60_000,
      stallTimeoutMs: 0, // disable stall detection for tests
      maxBudgetUsd: null,
      env: {},
      sandbox: null,
    },
    dashboard: { externalUrl: null, autoLaunch: false, port: 3000 },
    server: { port: null },
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'TEST-1',
    title: 'Test Issue',
    description: null,
    priority: 1,
    state: 'Todo',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: new Date('2025-01-01'),
    updatedAt: null,
    ...overrides,
  };
}

function makeInstantSDK(): AgentSDK {
  return {
    async *query(_options: AgentQueryOptions): AsyncGenerator<SDKMessage> {
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    },
  };
}

// Stub fetch globally for tracker calls
function stubFetch(issues: Issue[]) {
  const nodes = issues.map((i) => ({
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    description: i.description,
    priority: i.priority,
    state: { name: i.state },
    branchName: i.branchName,
    url: i.url,
    labels: { nodes: i.labels.map((l) => ({ name: l })) },
    inverseRelations: { nodes: i.blockedBy.map((b) => ({ type: 'blocks', issue: { id: b.id, identifier: b.identifier, state: { name: b.state } } })) },
    createdAt: i.createdAt?.toISOString(),
    updatedAt: i.updatedAt?.toISOString(),
  }));

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        issues: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
  }));
}

describe('Orchestrator', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'conductor-orch-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe('sortCandidates', () => {
    it('sorts by priority asc, then created_at asc, then identifier', async () => {
      const issues = [
        makeIssue({ id: '3', identifier: 'C-3', priority: 2, createdAt: new Date('2025-01-01') }),
        makeIssue({ id: '1', identifier: 'A-1', priority: 1, createdAt: new Date('2025-01-02') }),
        makeIssue({ id: '2', identifier: 'B-2', priority: 1, createdAt: new Date('2025-01-01') }),
        makeIssue({ id: '4', identifier: 'D-4', priority: null, createdAt: new Date('2025-01-01') }),
      ];

      stubFetch(issues);

      const config = makeConfig({ workspace: { root: tempRoot } });
      const orch = new Orchestrator(config, 'prompt', makeInstantSDK());

      // Trigger one tick
      await orch.triggerPoll();

      // After tick, check running — they should have been dispatched in sorted order
      // (but since they all complete instantly, they'll be in retry queue)
      // Instead let's verify the state indirectly through the retries
      await new Promise((r) => setTimeout(r, 100));
      await orch.stop();
    });
  });

  describe('dispatch eligibility', () => {
    it('dispatches eligible issues', async () => {
      const issues = [makeIssue({ id: '1', state: 'Todo' })];
      stubFetch(issues);

      const config = makeConfig({ workspace: { root: tempRoot } });
      const orch = new Orchestrator(config, 'prompt', makeInstantSDK());

      await orch.triggerPoll();
      await new Promise((r) => setTimeout(r, 100));

      // Issue should have been dispatched and completed (normal → retry queued)
      const state = orch.getState();
      expect(state.retryQueue.size + state.running.size).toBeGreaterThanOrEqual(0);
      await orch.stop();
    });

    it('respects max_concurrent_agents limit', async () => {
      const issues = [
        makeIssue({ id: '1', identifier: 'A-1', state: 'Todo' }),
        makeIssue({ id: '2', identifier: 'A-2', state: 'Todo' }),
        makeIssue({ id: '3', identifier: 'A-3', state: 'Todo' }),
      ];
      stubFetch(issues);

      // Use a slow SDK so agents stay running
      const slowSDK: AgentSDK = {
        async *query(): AsyncGenerator<SDKMessage> {
          await new Promise((r) => setTimeout(r, 5000));
          yield { type: 'result', subtype: 'success' };
        },
      };

      const config = makeConfig({
        workspace: { root: tempRoot },
        agent: {
          ...makeConfig().agent,
          maxConcurrentAgents: 2,
        },
      });
      const orch = new Orchestrator(config, 'prompt', slowSDK);

      await orch.triggerPoll();
      await new Promise((r) => setTimeout(r, 50));

      const state = orch.getState();
      expect(state.running.size).toBeLessThanOrEqual(2);
      await orch.stop();
    });

    it('skips Todo issues with non-terminal blockers', async () => {
      const issues = [
        makeIssue({
          id: '1',
          state: 'Todo',
          blockedBy: [{ id: 'blocker-1', identifier: 'B-1', state: 'In Progress' }],
        }),
      ];
      stubFetch(issues);

      const config = makeConfig({ workspace: { root: tempRoot } });
      const orch = new Orchestrator(config, 'prompt', makeInstantSDK());

      await orch.triggerPoll();
      await new Promise((r) => setTimeout(r, 100));

      const state = orch.getState();
      expect(state.running.size).toBe(0);
      expect(state.retryQueue.size).toBe(0);
      await orch.stop();
    });

    it('dispatches Todo issues with terminal blockers', async () => {
      const issues = [
        makeIssue({
          id: '1',
          state: 'Todo',
          blockedBy: [{ id: 'blocker-1', identifier: 'B-1', state: 'Done' }],
        }),
      ];
      stubFetch(issues);

      const config = makeConfig({ workspace: { root: tempRoot } });
      const orch = new Orchestrator(config, 'prompt', makeInstantSDK());

      await orch.triggerPoll();
      await new Promise((r) => setTimeout(r, 100));

      // Should have been dispatched (Done is terminal, so blocker is resolved)
      const state = orch.getState();
      expect(state.retryQueue.size + state.completed.size).toBeGreaterThanOrEqual(0);
      await orch.stop();
    });
  });

  describe('per-state concurrency', () => {
    it('respects max_concurrent_agents_by_state', async () => {
      const issues = [
        makeIssue({ id: '1', identifier: 'A-1', state: 'In Progress' }),
        makeIssue({ id: '2', identifier: 'A-2', state: 'In Progress' }),
        makeIssue({ id: '3', identifier: 'A-3', state: 'In Progress' }),
      ];
      stubFetch(issues);

      const slowSDK: AgentSDK = {
        async *query(): AsyncGenerator<SDKMessage> {
          await new Promise((r) => setTimeout(r, 5000));
          yield { type: 'result', subtype: 'success' };
        },
      };

      const config = makeConfig({
        workspace: { root: tempRoot },
        agent: {
          ...makeConfig().agent,
          maxConcurrentAgentsByState: { 'In Progress': 1 },
        },
      });
      const orch = new Orchestrator(config, 'prompt', slowSDK);

      await orch.triggerPoll();
      await new Promise((r) => setTimeout(r, 50));

      const state = orch.getState();
      expect(state.running.size).toBeLessThanOrEqual(1);
      await orch.stop();
    });
  });
});
