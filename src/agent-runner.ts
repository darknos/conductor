import { Liquid } from 'liquidjs';
import type {
  Issue,
  Workspace,
  AgentConfig,
  HookScripts,
  WorkerExit,
  ExitReason,
  SessionMetrics,
  AgentEvent,
} from './types.js';
import { ExitReason as ExitReasonEnum } from './types.js';
import { WorkspaceManager } from './workspace.js';
import * as logger from './logger.js';

const liquid = new Liquid({ strictVariables: true, strictFilters: true });

export interface AgentSDK {
  query(options: AgentQueryOptions): AsyncGenerator<SDKMessage>;
}

export interface AgentQueryOptions {
  prompt: string;
  systemPrompt?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  cwd: string;
  maxTurns?: number;
  model?: string;
  env?: Record<string, string>;
  sandbox?: Record<string, unknown>;
  maxBudgetUsd?: number;
}

// SDK message types (simplified from Claude Agent SDK)
export type SDKMessage =
  | SDKAssistantMessage
  | SDKResultMessage
  | SDKStreamEvent;

export interface SDKAssistantMessage {
  type: 'assistant';
  content: Array<{ type: string; text?: string }>;
}

export interface SDKResultMessage {
  type: 'result';
  subtype: 'success' | 'error';
  error?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  session_id?: string;
}

export interface SDKStreamEvent {
  type: 'stream';
  event: string;
}

export interface AgentRunnerOptions {
  agentConfig: AgentConfig;
  hooks: HookScripts;
  workspaceManager: WorkspaceManager;
  sdk: AgentSDK;
  onEvent?: (event: AgentEvent) => void;
}

export class AgentRunner {
  private config: AgentConfig;
  private hooks: HookScripts;
  private wsManager: WorkspaceManager;
  private sdk: AgentSDK;
  private onEvent: (event: AgentEvent) => void;

  constructor(options: AgentRunnerOptions) {
    this.config = options.agentConfig;
    this.hooks = options.hooks;
    this.wsManager = options.workspaceManager;
    this.sdk = options.sdk;
    this.onEvent = options.onEvent ?? (() => {});
  }

  updateConfig(agentConfig: AgentConfig, hooks: HookScripts): void {
    this.config = agentConfig;
    this.hooks = hooks;
  }

  async renderPrompt(issue: Issue, attempt: number | null, template: string): Promise<string> {
    return liquid.parseAndRender(template, {
      issue: {
        identifier: issue.identifier,
        title: issue.title,
        state: issue.state,
        description: issue.description ?? '',
        labels: issue.labels.join(', '),
        url: issue.url ?? '',
      },
      attempt,
    });
  }

  async runAttempt(
    issue: Issue,
    attempt: number | null,
    promptTemplate: string,
    abortSignal?: AbortSignal,
  ): Promise<WorkerExit> {
    const ctx = { issueId: issue.id, issueIdentifier: issue.identifier };

    // Create/reuse workspace
    const workspace = await this.wsManager.createForIssue(issue.identifier);

    // Run before_run hook (fatal on error)
    if (this.hooks.beforeRun) {
      try {
        await this.wsManager.runHook('before_run', this.hooks.beforeRun, workspace.path);
      } catch (err) {
        logger.error('before_run hook failed, aborting attempt', { ...ctx, error: String(err) });
        return {
          reason: ExitReasonEnum.Failure,
          error: `before_run hook failed: ${err}`,
          metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turnsCompleted: 0 },
        };
      }
    }

    // Render prompt (fallback to minimal default if template is empty per §5.4)
    const effectiveTemplate = promptTemplate.trim() || 'You are working on issue `{{ issue.identifier }}`: {{ issue.title }}';
    const prompt = await this.renderPrompt(issue, attempt, effectiveTemplate);

    // Build SDK options
    const queryOptions: AgentQueryOptions = {
      prompt,
      cwd: workspace.path,
    };
    if (this.config.systemPrompt) queryOptions.systemPrompt = this.config.systemPrompt;
    if (this.config.permissionMode) queryOptions.permissionMode = this.config.permissionMode;
    if (this.config.allowedTools.length > 0) queryOptions.allowedTools = this.config.allowedTools;
    if (this.config.disallowedTools.length > 0) queryOptions.disallowedTools = this.config.disallowedTools;
    if (this.config.maxTurns) queryOptions.maxTurns = this.config.maxTurns;
    if (this.config.model) queryOptions.model = this.config.model;
    if (Object.keys(this.config.env).length > 0) queryOptions.env = this.config.env;
    if (this.config.sandbox) queryOptions.sandbox = this.config.sandbox;
    if (this.config.maxBudgetUsd !== null) queryOptions.maxBudgetUsd = this.config.maxBudgetUsd;

    const metrics: SessionMetrics = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turnsCompleted: 0,
    };

    let exitReason: ExitReason = ExitReasonEnum.Normal;
    let exitError: string | null = null;
    let sessionId: string | null = null;

    try {
      // Turn timeout
      const turnTimeout = this.config.turnTimeoutMs;
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Turn timeout exceeded')), turnTimeout);
        // Allow the timer to not prevent Node from exiting
        if (timer.unref) timer.unref();
      });

      const runAgent = async () => {
        logger.debug('Starting SDK query', { ...ctx, cwd: queryOptions.cwd, permissionMode: queryOptions.permissionMode, maxTurns: queryOptions.maxTurns });
        const stream = this.sdk.query(queryOptions);
        for await (const message of stream) {
          // Check abort
          if (abortSignal?.aborted) {
            exitReason = ExitReasonEnum.CanceledByReconciliation;
            break;
          }

          const msg = message as unknown as Record<string, unknown>;
          logger.debug(`SDK message: type=${msg.type} subtype=${msg.subtype ?? ''}`, { ...ctx });

          switch (msg.type) {
            case 'assistant':
              metrics.turnsCompleted++;
              this.onEvent({
                type: 'turn_completed',
                issueId: issue.id,
                metrics: { ...metrics },
              });
              break;

            case 'result': {
              const usage = msg.usage as Record<string, number> | undefined;
              if (usage) {
                metrics.inputTokens = usage.input_tokens ?? usage.inputTokens ?? 0;
                metrics.outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0;
                metrics.totalTokens = (metrics.inputTokens + metrics.outputTokens);
              }
              // Extract session ID
              if (msg.session_id && typeof msg.session_id === 'string') {
                sessionId = msg.session_id as string;
              }
              const subtype = msg.subtype as string;
              if (subtype === 'success') {
                exitReason = ExitReasonEnum.Normal;
              } else if (subtype === 'error_max_turns') {
                exitReason = ExitReasonEnum.MaxTurns;
              } else if (subtype?.startsWith('error')) {
                exitReason = ExitReasonEnum.Failure;
                exitError = (msg.error ?? msg.stop_reason ?? `SDK error: ${subtype}`) as string;
                this.onEvent({
                  type: 'turn_failed',
                  issueId: issue.id,
                  error: exitError,
                });
              }
              break;
            }

            case 'rate_limit_event': {
              const retryAfter = (msg.retryAfterMs ?? msg.retry_after_ms ?? 0) as number;
              this.onEvent({
                type: 'rate_limit',
                issueId: issue.id,
                retryAfterMs: retryAfter,
              });
              break;
            }

            default:
              // Other message types (user, system, status, etc.) — update liveness
              break;
          }
        }
      };

      await Promise.race([runAgent(), timeoutPromise]);
    } catch (err) {
      if (err instanceof Error && err.message === 'Turn timeout exceeded') {
        exitReason = ExitReasonEnum.Timeout;
        exitError = 'Turn timeout exceeded';
      } else {
        exitReason = ExitReasonEnum.Failure;
        exitError = err instanceof Error ? err.message : String(err);
      }
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error('Agent run failed', { ...ctx, error: exitError, stack });
    }

    // Emit session started if we got a session ID
    if (sessionId) {
      this.onEvent({ type: 'session_started', issueId: issue.id, sessionId });
    }

    // Run after_run hook (log & ignore errors)
    if (this.hooks.afterRun) {
      try {
        await this.wsManager.runHook('after_run', this.hooks.afterRun, workspace.path);
      } catch (err) {
        logger.warn('after_run hook failed', { ...ctx, error: String(err) });
      }
    }

    logger.info(`Agent attempt finished: ${exitReason}`, {
      ...ctx,
      exitReason,
      turnsCompleted: metrics.turnsCompleted,
      totalTokens: metrics.totalTokens,
    });

    return { reason: exitReason, error: exitError, metrics };
  }
}
