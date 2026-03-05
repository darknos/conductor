import { EventEmitter } from 'node:events';
import type {
  Issue,
  ConductorConfig,
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  AggregateTotals,
  WorkerExit,
  AgentEvent,
} from './types.js';
import { ExitReason } from './types.js';
import { TrackerClient } from './tracker.js';
import { WorkspaceManager } from './workspace.js';
import { AgentRunner } from './agent-runner.js';
import type { AgentSDK } from './agent-runner.js';
import * as logger from './logger.js';

const CONTINUATION_RETRY_DELAY_MS = 1_000;
const FAILURE_BASE_DELAY_MS = 10_000;

export class Orchestrator extends EventEmitter {
  private config: ConductorConfig;
  private promptTemplate: string;
  private tracker: TrackerClient;
  private wsManager: WorkspaceManager;
  private agentRunner: AgentRunner;
  private state: OrchestratorState;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  constructor(
    config: ConductorConfig,
    promptTemplate: string,
    sdk: AgentSDK,
  ) {
    super();
    this.config = config;
    this.promptTemplate = promptTemplate;

    this.tracker = new TrackerClient(config.tracker);
    this.wsManager = new WorkspaceManager(config.workspace.root, config.hooks);
    this.agentRunner = new AgentRunner({
      agentConfig: config.agent,
      hooks: config.hooks,
      workspaceManager: this.wsManager,
      sdk,
      onEvent: (event) => this.handleAgentEvent(event),
    });

    this.state = {
      running: new Map(),
      claimed: new Set(),
      retryQueue: new Map(),
      completed: new Set(),
      agentTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
      rateLimits: null,
    };
  }

  updateConfig(config: ConductorConfig, promptTemplate: string): void {
    this.config = config;
    this.promptTemplate = promptTemplate;
    this.tracker.updateConfig(config.tracker);
    this.wsManager.updateConfig(config.workspace.root, config.hooks);
    this.agentRunner.updateConfig(config.agent, config.hooks);
  }

  getState(): OrchestratorState {
    return this.state;
  }

  start(): void {
    logger.info('Orchestrator starting');
    // Immediate first tick
    this.tick().catch((err) => logger.error('Poll tick error', { error: String(err) }));
    // Schedule future ticks
    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => logger.error('Poll tick error', { error: String(err) }));
    }, this.config.polling.intervalMs);

    // Stall detection
    if (this.config.agent.stallTimeoutMs > 0) {
      this.stallTimer = setInterval(() => {
        this.detectStalls();
      }, Math.min(this.config.agent.stallTimeoutMs, 30_000));
    }
  }

  async stop(): Promise<void> {
    logger.info('Orchestrator stopping');
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }

    // Cancel all running agents
    for (const [issueId, entry] of this.state.running) {
      entry.workerHandle.abort();
      logger.info(`Canceled running agent for ${entry.identifier}`, {
        issueId,
        issueIdentifier: entry.identifier,
      });
    }

    // Clear retry timers
    for (const [, entry] of this.state.retryQueue) {
      clearTimeout(entry.timerHandle);
    }
    this.state.retryQueue.clear();
  }

  async triggerPoll(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.isPolling) return; // prevent overlapping ticks
    this.isPolling = true;

    try {
      // 1. Fetch candidates
      const candidates = await this.tracker.fetchCandidateIssues(
        this.config.tracker.activeStates,
      );

      // 2. Reconcile running issues
      await this.reconcile();

      // 3. Sort candidates
      const sorted = this.sortCandidates(candidates);

      // 4. Dispatch eligible
      for (const issue of sorted) {
        if (!this.canDispatch(issue)) continue;
        this.dispatch(issue, null);
      }
    } catch (err) {
      logger.error('Poll tick failed', { error: String(err) });
    } finally {
      this.isPolling = false;
    }
  }

  private sortCandidates(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      // Priority ascending (null sorts last)
      const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
      const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;

      // created_at ascending (null sorts last)
      const ca = a.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const cb = b.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (ca !== cb) return ca - cb;

      // identifier lexicographic
      return a.identifier.localeCompare(b.identifier);
    });
  }

  private canDispatch(issue: Issue): boolean {
    const { id, state, identifier } = issue;

    // Already running, claimed, or completed
    if (this.state.running.has(id)) return false;
    if (this.state.claimed.has(id)) return false;
    if (this.state.completed.has(id)) return false;
    if (this.state.retryQueue.has(id)) return false;

    // Must be in active state
    if (!this.config.tracker.activeStates.includes(state)) return false;

    // Must not be terminal
    if (this.config.tracker.terminalStates.includes(state)) return false;

    // Global slot check
    if (this.state.running.size >= this.config.agent.maxConcurrentAgents) return false;

    // Per-state slot check
    const byState = this.config.agent.maxConcurrentAgentsByState;
    if (state in byState) {
      const runningInState = [...this.state.running.values()].filter(
        (e) => e.issue.state === state,
      ).length;
      if (runningInState >= byState[state]) return false;
    }

    // Todo + non-terminal blockers → ineligible
    if (state === 'Todo' && issue.blockedBy.length > 0) {
      const hasNonTerminalBlocker = issue.blockedBy.some(
        (b) => b.state !== null && !this.config.tracker.terminalStates.includes(b.state),
      );
      if (hasNonTerminalBlocker) {
        logger.debug(`Skipping ${identifier}: blocked by non-terminal issue`, {
          issueIdentifier: identifier,
        });
        return false;
      }
    }

    return true;
  }

  private dispatch(issue: Issue, attempt: number | null): void {
    const { id, identifier } = issue;
    logger.info(`Dispatching ${identifier}${attempt !== null ? ` (attempt ${attempt})` : ''}`, {
      issueId: id,
      issueIdentifier: identifier,
    });

    this.state.claimed.add(id);

    const abortController = new AbortController();
    const entry: RunningEntry = {
      workerHandle: abortController,
      identifier,
      issue,
      sessionId: null,
      lastAgentMessage: null,
      lastAgentEvent: null,
      lastAgentTimestamp: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      retryAttempt: attempt,
      startedAt: new Date(),
    };

    this.state.running.set(id, entry);
    this.state.claimed.delete(id);

    // Run agent asynchronously
    this.agentRunner
      .runAttempt(issue, attempt, this.promptTemplate, abortController.signal)
      .then((exit) => this.handleWorkerExit(issue, exit))
      .catch((err) => {
        logger.error(`Unexpected agent error for ${identifier}`, {
          issueId: id,
          issueIdentifier: identifier,
          error: String(err),
        });
        this.handleWorkerExit(issue, {
          reason: ExitReason.Failure,
          error: String(err),
          metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turnsCompleted: 0 },
        });
      });
  }

  private handleWorkerExit(issue: Issue, exit: WorkerExit): void {
    const { id, identifier } = issue;
    const entry = this.state.running.get(id);

    // Update aggregate totals
    if (entry) {
      const elapsed = (Date.now() - entry.startedAt.getTime()) / 1000;
      this.state.agentTotals.inputTokens += exit.metrics.inputTokens;
      this.state.agentTotals.outputTokens += exit.metrics.outputTokens;
      this.state.agentTotals.totalTokens += exit.metrics.totalTokens;
      this.state.agentTotals.secondsRunning += elapsed;
    }

    this.state.running.delete(id);

    switch (exit.reason) {
      case ExitReason.Normal:
        // Continuation retry at 1s
        this.scheduleRetry(issue, (entry?.retryAttempt ?? 0) + 1, CONTINUATION_RETRY_DELAY_MS, null);
        break;

      case ExitReason.Failure:
      case ExitReason.Timeout:
      case ExitReason.Stall: {
        const attempt = (entry?.retryAttempt ?? 0) + 1;
        const delay = Math.min(
          FAILURE_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          this.config.agent.maxRetryBackoffMs,
        );
        this.scheduleRetry(issue, attempt, delay, exit.error);
        break;
      }

      case ExitReason.CanceledByReconciliation:
        // Release, no retry
        logger.info(`Released ${identifier} (canceled by reconciliation)`, {
          issueId: id,
          issueIdentifier: identifier,
        });
        break;
    }

    this.emit('worker-exit', issue, exit);
  }

  private scheduleRetry(issue: Issue, attempt: number, delayMs: number, error: string | null): void {
    const { id, identifier } = issue;
    logger.info(`Scheduling retry for ${identifier} in ${delayMs}ms (attempt ${attempt})`, {
      issueId: id,
      issueIdentifier: identifier,
    });

    const timerHandle = setTimeout(() => {
      this.state.retryQueue.delete(id);
      this.dispatch(issue, attempt);
    }, delayMs);

    this.state.retryQueue.set(id, {
      issueId: id,
      identifier,
      attempt,
      dueAtMs: Date.now() + delayMs,
      timerHandle,
      error,
    });
  }

  private async reconcile(): Promise<void> {
    if (this.state.running.size === 0) return;

    const runningIds = [...this.state.running.keys()];
    let refreshedIssues: Issue[];
    try {
      refreshedIssues = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch (err) {
      logger.warn('Reconciliation fetch failed', { error: String(err) });
      return;
    }

    const refreshedMap = new Map(refreshedIssues.map((i) => [i.id, i]));

    for (const [issueId, entry] of this.state.running) {
      const refreshed = refreshedMap.get(issueId);
      if (!refreshed) continue;

      const { state } = refreshed;
      const isTerminal = this.config.tracker.terminalStates.includes(state);
      const isActive = this.config.tracker.activeStates.includes(state);

      if (isTerminal) {
        // Terminal → cancel agent + cleanup workspace
        logger.info(`Reconciliation: ${entry.identifier} is terminal (${state}), canceling`, {
          issueId,
          issueIdentifier: entry.identifier,
        });
        entry.workerHandle.abort();
        this.state.running.delete(issueId);
        this.state.completed.add(issueId);
        // Cleanup workspace
        try {
          await this.wsManager.removeWorkspace(entry.identifier);
        } catch (err) {
          logger.warn(`Workspace cleanup failed for ${entry.identifier}`, {
            issueId,
            error: String(err),
          });
        }
      } else if (!isActive) {
        // Non-active, non-terminal → cancel agent, no workspace cleanup
        logger.info(`Reconciliation: ${entry.identifier} is non-active (${state}), canceling`, {
          issueId,
          issueIdentifier: entry.identifier,
        });
        entry.workerHandle.abort();
        this.state.running.delete(issueId);
      }
    }
  }

  private detectStalls(): void {
    const now = Date.now();
    const stallTimeout = this.config.agent.stallTimeoutMs;
    if (stallTimeout <= 0) return;

    for (const [issueId, entry] of this.state.running) {
      const lastEventTime = entry.lastAgentTimestamp?.getTime() ?? entry.startedAt.getTime();
      if (now - lastEventTime > stallTimeout) {
        logger.warn(`Stall detected for ${entry.identifier}`, {
          issueId,
          issueIdentifier: entry.identifier,
          stalledForMs: now - lastEventTime,
        });
        entry.workerHandle.abort();
        this.state.running.delete(issueId);
        this.handleWorkerExit(entry.issue, {
          reason: ExitReason.Stall,
          error: `Agent stalled for ${now - lastEventTime}ms`,
          metrics: {
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            totalTokens: entry.totalTokens,
            turnsCompleted: 0,
          },
        });
      }
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'session_started': {
        const entry = this.state.running.get(event.issueId);
        if (entry) {
          entry.sessionId = event.sessionId;
          entry.lastAgentTimestamp = new Date();
        }
        break;
      }
      case 'turn_completed': {
        const entry = this.state.running.get(event.issueId);
        if (entry) {
          entry.inputTokens = event.metrics.inputTokens;
          entry.outputTokens = event.metrics.outputTokens;
          entry.totalTokens = event.metrics.totalTokens;
          entry.lastAgentTimestamp = new Date();
          entry.lastAgentEvent = 'turn_completed';
        }
        break;
      }
      case 'turn_failed': {
        const entry = this.state.running.get(event.issueId);
        if (entry) {
          entry.lastAgentTimestamp = new Date();
          entry.lastAgentEvent = 'turn_failed';
          entry.lastAgentMessage = event.error;
        }
        break;
      }
      case 'notification': {
        const entry = this.state.running.get(event.issueId);
        if (entry) {
          entry.lastAgentTimestamp = new Date();
          entry.lastAgentMessage = event.message;
        }
        break;
      }
    }

    this.emit('agent-event', event);
  }
}
