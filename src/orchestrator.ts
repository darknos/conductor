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
  ITrackerClient,
} from './types.js';
import { ExitReason, RunAttemptPhase } from './types.js';
import { createTracker } from './tracker-factory.js';
import { WorkspaceManager } from './workspace.js';
import { AgentRunner } from './agent-runner.js';
import type { AgentSDK } from './agent-runner.js';
import * as logger from './logger.js';

const CONTINUATION_RETRY_DELAY_MS = 1_000;
const FAILURE_BASE_DELAY_MS = 10_000;

/** Normalize state for comparison per §4.2: trim + lowercase */
function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

function stateMatches(state: string, stateList: string[]): boolean {
  const norm = normalizeState(state);
  return stateList.some((s) => normalizeState(s) === norm);
}

export class Orchestrator extends EventEmitter {
  private config: ConductorConfig;
  private promptTemplate: string;
  private tracker: ITrackerClient;
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

    this.tracker = createTracker(config.tracker);
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

  getTracker(): ITrackerClient {
    return this.tracker;
  }

  getConfig(): ConductorConfig {
    return this.config;
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
      // 1. Reconcile running issues
      await this.reconcile();

      // 2. Dispatch preflight validation (§6.3)
      if (!this.validateDispatchConfig()) {
        return; // Skip dispatch, keep reconciliation active
      }

      // 3. Fetch candidates
      const candidates = await this.tracker.fetchCandidateIssues(
        this.config.tracker.activeStates,
      );

      // 4. Sort candidates
      const sorted = this.sortCandidates(candidates);

      // 5. Dispatch eligible
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

  /** Dispatch preflight validation per §6.3 */
  private validateDispatchConfig(): boolean {
    const { tracker, agent } = this.config;
    if (!tracker.kind) {
      logger.error('Dispatch validation: tracker.kind is not set');
      return false;
    }
    if (tracker.kind === 'linear' && !tracker.apiKey) {
      logger.error('Dispatch validation: tracker.api_key missing for Linear');
      return false;
    }
    if (tracker.kind === 'linear' && !tracker.projectSlug) {
      logger.error('Dispatch validation: tracker.project_slug missing for Linear');
      return false;
    }
    if (agent.maxConcurrentAgents < 1) {
      logger.error('Dispatch validation: max_concurrent_agents must be >= 1');
      return false;
    }
    return true;
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
    if (!stateMatches(state, this.config.tracker.activeStates)) return false;

    // Must not be terminal
    if (stateMatches(state, this.config.tracker.terminalStates)) return false;

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

    // Todo + non-terminal blockers → ineligible (§8.2)
    if (normalizeState(state) === 'todo' && issue.blockedBy.length > 0) {
      const hasNonTerminalBlocker = issue.blockedBy.some(
        (b) => b.state !== null && !stateMatches(b.state, this.config.tracker.terminalStates),
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
      phase: RunAttemptPhase.PreparingWorkspace,
      lastAgentMessage: null,
      lastAgentEvent: null,
      lastAgentTimestamp: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turnCount: 0,
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
        // Continuation retry per §16.6 — agent may need another session
        this.scheduleRetry(issue, (entry?.retryAttempt ?? 0) + 1, CONTINUATION_RETRY_DELAY_MS, null);
        break;

      case ExitReason.MaxTurns:
        // Agent exhausted max turns — mark completed, no more retries
        logger.info(`Agent finished ${identifier} (max_turns), marking completed`, {
          issueId: id,
          issueIdentifier: identifier,
        });
        this.state.completed.add(id);
        if (this.tracker.updateIssueState) {
          this.tracker.updateIssueState(id, 'Done').catch((err) => {
            logger.warn(`Failed to update issue state for ${identifier}`, { error: String(err) });
          });
        }
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

    // Cancel existing retry timer for same issue
    const existing = this.state.retryQueue.get(id);
    if (existing) clearTimeout(existing.timerHandle);

    logger.info(`Scheduling retry for ${identifier} in ${delayMs}ms (attempt ${attempt})`, {
      issueId: id,
      issueIdentifier: identifier,
    });

    const timerHandle = setTimeout(() => {
      this.state.retryQueue.delete(id);
      this.handleRetryFired(issue, attempt);
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

  /** Re-validate issue eligibility on retry fire per §16.6 */
  private async handleRetryFired(issue: Issue, attempt: number): Promise<void> {
    const { id, identifier } = issue;
    try {
      const candidates = await this.tracker.fetchCandidateIssues(this.config.tracker.activeStates);
      const found = candidates.find((c) => c.id === id);
      if (!found) {
        // Issue no longer active — release claim
        logger.info(`Retry fired for ${identifier} but issue no longer active, releasing`, {
          issueId: id, issueIdentifier: identifier,
        });
        this.state.claimed.delete(id);
        return;
      }
      // Check concurrency slots
      if (this.state.running.size >= this.config.agent.maxConcurrentAgents) {
        logger.info(`Retry fired for ${identifier} but no slots, requeuing`, {
          issueId: id, issueIdentifier: identifier,
        });
        this.scheduleRetry(found, attempt, CONTINUATION_RETRY_DELAY_MS, 'No concurrency slots available');
        return;
      }
      this.dispatch(found, attempt);
    } catch (err) {
      logger.warn(`Retry re-validation failed for ${identifier}, rescheduling`, {
        issueId: id, error: String(err),
      });
      this.scheduleRetry(issue, attempt + 1, FAILURE_BASE_DELAY_MS, `Retry re-validation failed: ${err}`);
    }
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
      const isTerminal = stateMatches(state, this.config.tracker.terminalStates);
      const isActive = stateMatches(state, this.config.tracker.activeStates);

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
          entry.turnCount = event.metrics.turnsCompleted;
          entry.lastAgentTimestamp = new Date();
          entry.lastAgentEvent = 'turn_completed';
          entry.phase = RunAttemptPhase.StreamingTurns;
        }
        break;
      }
      case 'turn_failed': {
        const entry = this.state.running.get(event.issueId);
        if (entry) {
          entry.lastAgentTimestamp = new Date();
          entry.lastAgentEvent = 'turn_failed';
          entry.lastAgentMessage = event.error;
          entry.phase = RunAttemptPhase.Failed;
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
      case 'rate_limit': {
        this.state.rateLimits = {
          retryAfterMs: event.retryAfterMs,
          lastSeenAt: new Date(),
        };
        const entry = this.state.running.get(event.issueId);
        if (entry) {
          entry.lastAgentTimestamp = new Date();
        }
        break;
      }
    }

    this.emit('agent-event', event);
  }
}
