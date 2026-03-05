# Conductor Implementation Plan

Tech stack: **TypeScript / Node.js**

## Phase 0: Project Scaffold

1. **Init project**
   - `package.json` (name: `conductor`, type: `module`, engines: `node >= 20`)
   - `tsconfig.json` (ESM, strict, target ES2022, outDir `dist/`)
   - `.gitignore` (node_modules, dist, .env)
   - Install deps:
     - Runtime: `@anthropic-ai/claude-agent-sdk`, `yaml`, `liquidjs`, `chokidar`
     - Dev: `typescript`, `vitest`, `@types/node`, `tsx`
   - Entry point: `src/main.ts` → `dist/main.js`
   - Scripts: `build`, `start`, `dev` (tsx), `test` (vitest)

## Phase 1: Domain Model & Types (`src/types.ts`)

2. **Core domain types** — all interfaces/enums from SPEC.md §4:
   - `Issue`, `BlockerRef`
   - `WorkflowDefinition`
   - `Workspace`
   - `TrackerConfig`, `AgentConfig`, `HookScripts`, `ConductorConfig`
   - `RunningEntry`, `RetryEntry`, `AggregateTotals`, `OrchestratorState`
   - `ExitReason` enum: `normal`, `failure`, `timeout`, `stall`, `canceled_by_reconciliation`
   - `IssueOrchestratorState` enum: `Unclaimed`, `Claimed`, `Running`, `RetryQueued`, `Released`
   - `WorkerExit`, `SessionMetrics`

## Phase 2: Workflow Loader (`src/workflow-loader.ts`)

3. **parse WORKFLOW.md** — split front matter / prompt body
   - `loadWorkflow(filePath: string): WorkflowDefinition`
   - YAML parse via `yaml` package
   - Error types: `WorkflowError` (missing file, parse error, not-a-map, template error)

4. **Tests**: `tests/workflow-loader.test.ts`
   - Valid file → config + template
   - No front matter → empty config
   - Invalid YAML → error
   - Missing file → error

## Phase 3: Config Layer (`src/config.ts`)

5. **Typed config with defaults and $VAR resolution**
   - `resolveEnvVars(value: string): string` — `$VAR` → `process.env.VAR`
   - `resolvePath(value: string): string` — `~` expansion + env vars
   - `buildConfig(raw: Record<string, any>): ConductorConfig` — apply defaults from SPEC.md §5.3
   - Defaults:
     - `polling.interval_ms`: 30000
     - `agent.max_concurrent_agents`: 10
     - `agent.max_turns`: 20
     - `agent.max_retry_backoff_ms`: 300000
     - `agent.turn_timeout_ms`: 3600000
     - `agent.stall_timeout_ms`: 300000
     - `agent.allowed_tools`: `[Read, Edit, Glob, Grep, Bash]`
     - `hooks.timeout_ms`: 60000
     - `tracker.endpoint`: `https://api.linear.app/graphql`
     - `tracker.active_states`: `[Todo, In Progress]`
     - `tracker.terminal_states`: `[Closed, Cancelled, Canceled, Duplicate, Done]`

6. **Dynamic reload** via `chokidar` file watcher
   - On change → re-parse → validate → swap config (keep last good on error)
   - Emit `config-reloaded` event

7. **Tests**: `tests/config.test.ts`
   - $VAR resolution, ~ expansion, defaults, invalid config keeps last good

## Phase 4: Issue Tracker Client (`src/tracker.ts`)

8. **Linear GraphQL adapter**
   - `fetchCandidateIssues(): Promise<Issue[]>` — filter by project slug + active states
   - `fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>` — refresh state for running issues
   - `fetchIssuesByStates(states: string[]): Promise<Issue[]>` — terminal cleanup
   - GraphQL queries with pagination (page size 50)
   - Label normalization (lowercase)
   - Blocker derivation from inverse `blocks` relations
   - Network timeout: 30s
   - Auth: `Authorization: ${api_key}` header

9. **Tests**: `tests/tracker.test.ts`
   - Mock HTTP responses
   - Pagination, label normalization, blocker derivation, error handling

## Phase 5: Workspace Manager (`src/workspace.ts`)

10. **Per-issue workspace lifecycle**
    - `sanitizeIdentifier(id: string): string` — replace non-`[A-Za-z0-9._-]` with `_`
    - `createForIssue(identifier: string): Promise<Workspace>` — create/reuse dir
    - `removeWorkspace(identifier: string): Promise<void>` — run `before_remove` hook, then delete
    - `runHook(hookType, workspacePath): Promise<void>` — shell exec with timeout
    - Path containment check: workspace path must be under root

11. **Tests**: `tests/workspace.test.ts`
    - Sanitization, create/reuse, hook execution, timeout, containment

## Phase 6: Agent Runner (`src/agent-runner.ts`)

12. **Claude Agent SDK integration**
    - `runAttempt(issue, attempt, workspace): Promise<WorkerExit>`
    - Render prompt via `liquidjs` (strict mode, fail on unknown vars)
    - First turn: full prompt; continuation turns: continuation guidance only
    - Build `ClaudeAgentOptions` from config (permission_mode, allowed_tools, model, cwd, max_turns, env, sandbox, etc.)
    - Call `query()` → iterate `AsyncGenerator<SDKMessage>`
    - Handle message types: `AssistantMessage`, `ResultMessage`, `StreamEvent`, `RateLimitEvent`
    - Track tokens, session_id, last_event
    - Turn timeout via `agent.turn_timeout_ms`
    - Run `before_run` hook (fatal on error), `after_run` hook (log & ignore)
    - Emit events to orchestrator: `session_started`, `turn_completed`, `turn_failed`

13. **Tests**: `tests/agent-runner.test.ts`
    - Prompt rendering, option mapping, message handling, timeout

## Phase 7: Orchestrator (`src/orchestrator.ts`)

14. **Single-authority poll loop & state management**
    - `OrchestratorState` — in-memory Maps/Sets
    - `startPolling()` — setInterval at `poll_interval_ms`, immediate first tick
    - **Poll tick**:
      1. `fetchCandidateIssues()` from tracker
      2. Sort: priority asc (null last) → created_at asc → identifier lexicographic
      3. Filter eligible: not running/claimed/completed, state is active, not terminal, slots available, per-state slots available, Todo issues skip if non-terminal blockers
      4. Dispatch eligible issues up to available slots
    - **Dispatch**:
      1. Mark `claimed`
      2. Create workspace
      3. Spawn agent runner (async)
      4. Move to `running`
    - **Worker exit handler**:
      - `normal` → schedule continuation retry at 1000ms
      - `failure` → exponential backoff `min(10000 * 2^(attempt-1), max_retry_backoff_ms)`
      - `timeout` / `stall` → same as failure
      - `canceled_by_reconciliation` → release, no retry
    - **Reconciliation** (every tick):
      1. Refresh tracker states for all running issues
      2. Non-active state → cancel agent, release (no workspace cleanup)
      3. Terminal state → cancel agent, cleanup workspace, mark completed
    - **Stall detection**:
      - If `stall_timeout_ms > 0` and running entry has no event for > stall_timeout_ms → kill with `stall` reason
    - **Retry timer handler**:
      - Remove from retry queue, dispatch as new attempt

15. **Tests**: `tests/orchestrator.test.ts`
    - Dispatch sorting, eligibility, slot limits, retry timing, reconciliation, stall detection

## Phase 8: Structured Logging (`src/logger.ts`)

16. **JSON structured logging**
    - Fields: `timestamp`, `level`, `message`, `issue_id`, `issue_identifier`, `session_id`
    - Log levels: `debug`, `info`, `warn`, `error`
    - Redact `$VAR` secret values
    - Token/rate-limit aggregation in state

## Phase 9: CLI Entry Point (`src/main.ts`)

17. **CLI bootstrap**
    - Parse args: `--workflow <path>` (default: `./WORKFLOW.md`), `--port <n>` (optional)
    - Validate `ANTHROPIC_API_KEY` present
    - Load workflow → build config → init components → start orchestrator
    - Graceful shutdown: SIGINT/SIGTERM → stop polling, wait for running agents, cleanup
    - Exit codes: 0 success, 1 error

## Phase 10: HTTP Status Surface (Optional, `src/server.ts`)

18. **Optional HTTP API** (only if `--port` or `server.port` set)
    - `GET /` — HTML dashboard
    - `GET /api/v1/state` — JSON runtime snapshot
    - `GET /api/v1/:identifier` — issue-specific info
    - `POST /api/v1/refresh` — trigger immediate poll
    - Use Node.js built-in `http` module (no Express needed)

## Phase 11: Integration & Polish

19. **Startup workspace sweep** — scan `workspace.root` on boot, cleanup orphaned dirs not in tracker active states
20. **End-to-end smoke test** — real workflow file, mocked tracker + SDK, verify full poll→dispatch→exit→retry cycle
21. **README** (brief usage instructions, if requested)

---

## Dependency Graph

```
types.ts (no deps)
  ↓
workflow-loader.ts (yaml)
  ↓
config.ts (workflow-loader, chokidar)
  ↓
logger.ts (config)
  ↓
tracker.ts (config, types, logger)
workspace.ts (config, types, logger)
  ↓
agent-runner.ts (config, types, logger, workspace, tracker, liquidjs, claude-agent-sdk)
  ↓
orchestrator.ts (config, types, logger, tracker, workspace, agent-runner)
  ↓
server.ts (orchestrator, logger) [optional]
  ↓
main.ts (all of the above)
```

## Implementation Order

Build bottom-up following the dependency graph:

1. Phase 0: Scaffold → 2. Phase 1: Types → 3. Phase 2: Workflow Loader + tests → 4. Phase 3: Config + tests → 5. Phase 4: Tracker + tests → 6. Phase 5: Workspace + tests → 7. Phase 8: Logger → 8. Phase 6: Agent Runner + tests → 9. Phase 7: Orchestrator + tests → 10. Phase 9: CLI → 11. Phase 10: HTTP (optional) → 12. Phase 11: Integration
