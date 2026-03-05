// Domain model types per SPEC.md §4

// --- Issue Tracker ---

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: Date | null;
  updatedAt: Date | null;
}

// --- Workflow ---

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export enum WorkflowErrorKind {
  MissingFile = 'missing_workflow_file',
  ParseError = 'workflow_parse_error',
  FrontMatterNotAMap = 'workflow_front_matter_not_a_map',
  TemplateParseError = 'template_parse_error',
  TemplateRenderError = 'template_render_error',
}

export class WorkflowError extends Error {
  constructor(
    public readonly kind: WorkflowErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// --- Config ---

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  activeStates: string[];
  terminalStates: string[];
  /** Directory containing issue files (for kind: "local") */
  issuesDir: string | null;
  /** Path to beads repository (for kind: "beads") */
  beadsRepoPath: string | null;
}

// --- Tracker Interface ---

export interface ITrackerClient {
  updateConfig(config: TrackerConfig): void;
  fetchCandidateIssues(activeStates: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;
  fetchAllProjectIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  /** Update issue state (optional — not all trackers support writes) */
  updateIssueState?(issueId: string, newState: string): Promise<void>;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
  permissionMode: string | null;
  allowedTools: string[];
  disallowedTools: string[];
  model: string | null;
  systemPrompt: string | null;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  maxBudgetUsd: number | null;
  env: Record<string, string>;
  sandbox: Record<string, unknown> | null;
}

export interface HookScripts {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface DashboardConfig {
  /** External dashboard URL to redirect to (e.g. beadboard at http://localhost:3000) */
  externalUrl: string | null;
  /** Auto-launch beadboard dashboard alongside conductor */
  autoLaunch: boolean;
  /** Port for beadboard (default: 3000) */
  port: number;
}

export interface ServerConfig {
  port: number | null;
}

export interface ConductorConfig {
  tracker: TrackerConfig;
  polling: { intervalMs: number };
  dashboard: DashboardConfig;
  workspace: { root: string };
  hooks: HookScripts;
  agent: AgentConfig;
  server: ServerConfig;
}

// --- Workspace ---

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

// --- Orchestrator ---

export enum ExitReason {
  Normal = 'normal',
  MaxTurns = 'max_turns',
  Failure = 'failure',
  Timeout = 'timeout',
  Stall = 'stall',
  CanceledByReconciliation = 'canceled_by_reconciliation',
}

export enum IssueOrchestratorState {
  Unclaimed = 'unclaimed',
  Claimed = 'claimed',
  Running = 'running',
  RetryQueued = 'retry_queued',
  Released = 'released',
}

export enum RunAttemptPhase {
  PreparingWorkspace = 'preparing_workspace',
  BuildingPrompt = 'building_prompt',
  LaunchingAgent = 'launching_agent',
  StreamingTurns = 'streaming_turns',
  Finishing = 'finishing',
  Succeeded = 'succeeded',
  Failed = 'failed',
}

export interface SessionMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnsCompleted: number;
}

export interface WorkerExit {
  reason: ExitReason;
  error: string | null;
  metrics: SessionMetrics;
}

export interface RunningEntry {
  workerHandle: AbortController;
  identifier: string;
  issue: Issue;
  sessionId: string | null;
  phase: RunAttemptPhase;
  lastAgentMessage: string | null;
  lastAgentEvent: string | null;
  lastAgentTimestamp: Date | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turnCount: number;
  retryAttempt: number | null;
  startedAt: Date;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: ReturnType<typeof setTimeout>;
  error: string | null;
}

export interface AggregateTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export interface RateLimitSnapshot {
  retryAfterMs: number | null;
  lastSeenAt: Date | null;
}

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryQueue: Map<string, RetryEntry>;
  completed: Set<string>;
  agentTotals: AggregateTotals;
  rateLimits: RateLimitSnapshot | null;
}

// --- Agent Runner Events ---

export type AgentEvent =
  | { type: 'session_started'; issueId: string; sessionId: string }
  | { type: 'turn_completed'; issueId: string; metrics: SessionMetrics }
  | { type: 'turn_failed'; issueId: string; error: string }
  | { type: 'notification'; issueId: string; message: string }
  | { type: 'rate_limit'; issueId: string; retryAfterMs: number };

// --- Status Surface ---

export interface StateSnapshot {
  generatedAt: string;
  counts: { running: number; retrying: number };
  running: Array<{
    issueId: string;
    issueIdentifier: string;
    state: string;
    sessionId: string | null;
    turnCount: number;
    lastEvent: string | null;
    lastMessage: string | null;
    startedAt: string;
    lastEventAt: string | null;
    tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
  }>;
  retrying: Array<{
    issueId: string;
    issueIdentifier: string;
    attempt: number;
    dueAt: string;
    error: string | null;
  }>;
  agentTotals: AggregateTotals;
  rateLimits: RateLimitSnapshot | null;
}
