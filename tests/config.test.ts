import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildConfig, resolveEnvVar, resolvePath } from '../src/config.js';

describe('resolveEnvVar', () => {
  beforeEach(() => {
    process.env.TEST_VAR = 'hello';
    process.env.API_KEY = 'secret123';
  });

  afterEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.API_KEY;
  });

  it('resolves $VAR from environment', () => {
    expect(resolveEnvVar('$TEST_VAR')).toBe('hello');
  });

  it('resolves multiple vars', () => {
    expect(resolveEnvVar('$TEST_VAR/$API_KEY')).toBe('hello/secret123');
  });

  it('returns empty string for missing vars', () => {
    expect(resolveEnvVar('$NONEXISTENT')).toBe('');
  });

  it('passes through plain strings', () => {
    expect(resolveEnvVar('plain text')).toBe('plain text');
  });
});

describe('resolvePath', () => {
  it('expands ~ to homedir', () => {
    const result = resolvePath('~/test');
    expect(result).not.toContain('~');
    expect(result).toContain('test');
  });
});

describe('buildConfig', () => {
  it('applies defaults for empty config', () => {
    const config = buildConfig({});
    expect(config.polling.intervalMs).toBe(30_000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.agent.maxTurns).toBe(20);
    expect(config.agent.maxRetryBackoffMs).toBe(300_000);
    expect(config.agent.turnTimeoutMs).toBe(3_600_000);
    expect(config.agent.stallTimeoutMs).toBe(300_000);
    expect(config.agent.allowedTools).toEqual(['Read', 'Edit', 'Glob', 'Grep', 'Bash']);
    expect(config.hooks.timeoutMs).toBe(60_000);
    expect(config.tracker.kind).toBe('linear');
    expect(config.tracker.endpoint).toBe('https://api.linear.app/graphql');
    expect(config.tracker.activeStates).toEqual(['Todo', 'In Progress']);
    expect(config.tracker.terminalStates).toEqual(['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']);
  });

  it('reads custom values', () => {
    const config = buildConfig({
      polling: { interval_ms: 5000 },
      agent: { max_concurrent_agents: 3, max_turns: 10 },
      tracker: { kind: 'linear', project_slug: 'test-slug' },
    });
    expect(config.polling.intervalMs).toBe(5000);
    expect(config.agent.maxConcurrentAgents).toBe(3);
    expect(config.agent.maxTurns).toBe(10);
    expect(config.tracker.projectSlug).toBe('test-slug');
  });

  it('resolves env vars in tracker api_key', () => {
    process.env.MY_KEY = 'resolved-key';
    const config = buildConfig({
      tracker: { api_key: '$MY_KEY' },
    });
    expect(config.tracker.apiKey).toBe('resolved-key');
    delete process.env.MY_KEY;
  });

  it('resolves workspace root path', () => {
    const config = buildConfig({
      workspace: { root: '~/workspaces' },
    });
    expect(config.workspace.root).not.toContain('~');
    expect(config.workspace.root).toContain('workspaces');
  });

  it('handles hooks config', () => {
    const config = buildConfig({
      hooks: {
        after_create: 'echo hello',
        timeout_ms: 30000,
      },
    });
    expect(config.hooks.afterCreate).toBe('echo hello');
    expect(config.hooks.beforeRun).toBeNull();
    expect(config.hooks.timeoutMs).toBe(30000);
  });

  it('handles agent env with $VAR resolution', () => {
    process.env.INNER_VAR = 'inner-value';
    const config = buildConfig({
      agent: { env: { CUSTOM: '$INNER_VAR' } },
    });
    expect(config.agent.env.CUSTOM).toBe('inner-value');
    delete process.env.INNER_VAR;
  });

  it('handles max_concurrent_agents_by_state', () => {
    const config = buildConfig({
      agent: { max_concurrent_agents_by_state: { 'In Progress': 5, 'Todo': 2 } },
    });
    expect(config.agent.maxConcurrentAgentsByState).toEqual({ 'In Progress': 5, 'Todo': 2 });
  });

  it('handles server config', () => {
    const config = buildConfig({ server: { port: 8080 } });
    expect(config.server.port).toBe(8080);
  });

  it('defaults server port to null', () => {
    const config = buildConfig({});
    expect(config.server.port).toBeNull();
  });
});
