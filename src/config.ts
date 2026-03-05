import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watch } from 'chokidar';
import { EventEmitter } from 'node:events';
import { loadWorkflow } from './workflow-loader.js';
import type { ConductorConfig, TrackerConfig, AgentConfig, HookScripts, ServerConfig } from './types.js';

export function resolveEnvVar(value: string): string {
  return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    return process.env[name] ?? '';
  });
}

export function resolvePath(value: string): string {
  let resolved = value;
  if (resolved.startsWith('~/') || resolved === '~') {
    resolved = resolved.replace('~', homedir());
  }
  return resolveEnvVar(resolved);
}

function getString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : fallback;
}

function getNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key];
  return typeof v === 'number' ? v : fallback;
}

function getStringArray(obj: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const v = obj[key];
  return Array.isArray(v) ? v.map(String) : fallback;
}

function getStringOrNull(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function getNumberOrNull(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
}

function buildTrackerConfig(raw: Record<string, unknown>): TrackerConfig {
  const tracker = asRecord(raw['tracker']);
  const kind = getString(tracker, 'kind', 'linear');
  const apiKeyRaw = getString(tracker, 'api_key', '$LINEAR_API_KEY');
  const issuesDirRaw = getStringOrNull(tracker, 'issues_dir');
  return {
    kind,
    endpoint: getString(tracker, 'endpoint', 'https://api.linear.app/graphql'),
    apiKey: resolveEnvVar(apiKeyRaw),
    projectSlug: getString(tracker, 'project_slug', ''),
    activeStates: getStringArray(tracker, 'active_states', ['Todo', 'In Progress']),
    terminalStates: getStringArray(tracker, 'terminal_states', [
      'Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done',
    ]),
    issuesDir: issuesDirRaw ? resolvePath(issuesDirRaw) : null,
    beadsRepoPath: getStringOrNull(tracker, 'beads_repo_path'),
  };
}

function buildAgentConfig(raw: Record<string, unknown>): AgentConfig {
  const agent = asRecord(raw['agent']);
  const envRaw = asRecord(agent['env']);
  const resolvedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(envRaw)) {
    resolvedEnv[k] = resolveEnvVar(String(v));
  }

  const byState = asRecord(agent['max_concurrent_agents_by_state']);
  const resolvedByState: Record<string, number> = {};
  for (const [k, v] of Object.entries(byState)) {
    if (typeof v === 'number') resolvedByState[k] = v;
  }

  return {
    maxConcurrentAgents: getNumber(agent, 'max_concurrent_agents', 10),
    maxTurns: getNumber(agent, 'max_turns', 20),
    maxRetryBackoffMs: getNumber(agent, 'max_retry_backoff_ms', 300_000),
    maxConcurrentAgentsByState: resolvedByState,
    permissionMode: getStringOrNull(agent, 'permission_mode'),
    allowedTools: getStringArray(agent, 'allowed_tools', ['Read', 'Edit', 'Glob', 'Grep', 'Bash']),
    disallowedTools: getStringArray(agent, 'disallowed_tools', []),
    model: getStringOrNull(agent, 'model'),
    systemPrompt: getStringOrNull(agent, 'system_prompt'),
    turnTimeoutMs: getNumber(agent, 'turn_timeout_ms', 3_600_000),
    stallTimeoutMs: getNumber(agent, 'stall_timeout_ms', 300_000),
    maxBudgetUsd: getNumberOrNull(agent, 'max_budget_usd'),
    env: resolvedEnv,
    sandbox: agent['sandbox'] ? asRecord(agent['sandbox']) : null,
  };
}

function buildHookScripts(raw: Record<string, unknown>): HookScripts {
  const hooks = asRecord(raw['hooks']);
  return {
    afterCreate: getStringOrNull(hooks, 'after_create'),
    beforeRun: getStringOrNull(hooks, 'before_run'),
    afterRun: getStringOrNull(hooks, 'after_run'),
    beforeRemove: getStringOrNull(hooks, 'before_remove'),
    timeoutMs: getNumber(hooks, 'timeout_ms', 60_000),
  };
}

export function buildConfig(raw: Record<string, unknown>): ConductorConfig {
  const polling = asRecord(raw['polling']);
  const workspace = asRecord(raw['workspace']);
  const server = asRecord(raw['server']);

  const defaultRoot = join(tmpdir(), 'conductor_workspaces');
  const rootRaw = getString(workspace, 'root', defaultRoot);

  return {
    tracker: buildTrackerConfig(raw),
    polling: {
      intervalMs: getNumber(polling, 'interval_ms', 30_000),
    },
    workspace: {
      root: resolvePath(rootRaw),
    },
    hooks: buildHookScripts(raw),
    agent: buildAgentConfig(raw),
    server: {
      port: getNumberOrNull(server, 'port'),
    },
  };
}

export class ConfigManager extends EventEmitter {
  private config: ConductorConfig | null = null;
  private watcher: ReturnType<typeof watch> | null = null;
  private workflowPath: string;

  constructor(workflowPath: string) {
    super();
    this.workflowPath = workflowPath;
  }

  async load(): Promise<ConductorConfig> {
    const workflow = await loadWorkflow(this.workflowPath);
    this.config = buildConfig(workflow.config);
    return this.config;
  }

  getConfig(): ConductorConfig {
    if (!this.config) throw new Error('Config not loaded yet. Call load() first.');
    return this.config;
  }

  startWatching(): void {
    this.watcher = watch(this.workflowPath, { ignoreInitial: true });
    this.watcher.on('change', async () => {
      try {
        const workflow = await loadWorkflow(this.workflowPath);
        this.config = buildConfig(workflow.config);
        this.emit('config-reloaded', this.config);
      } catch (err) {
        this.emit('config-reload-error', err);
        // Keep last good config
      }
    });
  }

  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
