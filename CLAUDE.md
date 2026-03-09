# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Conductor

Conductor is a long-running daemon that polls issue trackers, dispatches coding agent sessions (via Claude Agent SDK) into per-issue workspaces, and manages retries/reconciliation. It is a scheduler/runner — ticket writes (state transitions, comments, PRs) are performed by the coding agent, not by Conductor itself.

## Commands

```bash
npm run dev                          # Run with tsx (development)
npm run dev -- --workflow path.md    # Custom workflow file
npm test                             # Run all tests (vitest)
npx vitest run tests/config.test.ts  # Run single test file
npx vitest -t "test name"           # Run single test by name
npx tsc --noEmit                    # Type-check without emitting
npm run build                       # Build to dist/
```

Local demo: `npx tsx src/main.ts --workflow examples/WORKFLOW.local.md`

## Architecture

**Data flow:** `main.ts` → loads config from WORKFLOW.md → creates SDK wrapper → creates `Orchestrator` → starts poll loop → dispatches `AgentRunner` per issue.

Six core components:

1. **Workflow Loader** (`workflow-loader.ts`) — parses WORKFLOW.md: YAML front matter → config, body → Liquid prompt template
2. **Config Layer** (`config.ts`) — typed getters, defaults, `$VAR` env resolution, dynamic reload via chokidar file watch. `ConfigManager` extends `EventEmitter`, emits `config-reloaded`
3. **Issue Tracker Client** (`types.ts:ITrackerClient`) — three adapters selected by `tracker.kind`:
   - `linear` (`tracker.ts`) — Linear GraphQL API
   - `local` (`local-tracker.ts`) — file-based, each issue is a `.md` with YAML front matter in `issues_dir`
   - `beads` (`beads-tracker.ts`) — uses `@herbcaudill/beads-sdk` (optional dep)
   - Factory: `tracker-factory.ts`
4. **Orchestrator** (`orchestrator.ts`) — single-authority in-memory state machine: poll loop, dispatch, concurrency limiting, retry queue, reconciliation (checks if running issues went terminal), stall detection
5. **Workspace Manager** (`workspace.ts`) — per-issue dirs under `workspace.root`, lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
6. **Agent Runner** (`agent-runner.ts`) — renders Liquid prompt, calls `sdk.query()`, iterates `SDKMessage` stream, maps SDK message types to exit reasons

Optional: **HTTP Server** (`server.ts`) — JSON API at `/api/v1/*` with built-in Kanban board dashboard at `/`

**SDK integration** (`main.ts:createSDK`): wraps `@anthropic-ai/claude-agent-sdk`'s standalone `query({ prompt, options })` into the `AgentSDK` interface. Must `delete process.env.CLAUDECODE` to allow nested Claude Code processes.

## Key design decisions

- **Claude Agent SDK** (not subprocess wrapper): `query({ prompt, options })` returns `AsyncGenerator<SDKMessage>`. Real SDK message types include `system`, `assistant`, `user`, `result`, `rate_limit_event`. Result subtypes: `success`, `error_max_turns`, `error_during_execution`, etc.
- **Single-authority orchestrator**: all state mutations go through one serialized component. No distributed state.
- **In-memory state**: no persistent DB. Recovery is tracker-driven + filesystem-driven after restart. `completed` Set prevents re-dispatch of finished issues.
- **Exit reason handling**: `Normal`/`MaxTurns` → mark completed + update tracker state; `Failure`/`Timeout`/`Stall` → exponential backoff retry; `CanceledByReconciliation` → release without retry.
- **WORKFLOW.md is the config file**: dynamic reload on file change, no restart needed for most settings.

## Config schema (WORKFLOW.md front matter)

Key sections: `tracker`, `polling`, `workspace`, `hooks`, `agent`, `server`, `dashboard`. See SPEC.md §5.3 for full reference.

The `agent` section: `max_concurrent_agents`, `max_turns`, `permission_mode` (plan/acceptEdits/bypassPermissions), `allowed_tools`, `disallowed_tools`, `model`, `system_prompt`, `turn_timeout_ms`, `stall_timeout_ms`, `sandbox`, `env`, `max_budget_usd`.

## Testing

Tests use vitest with no special setup. Each source module has a corresponding test in `tests/`. Tests use mock/stub SDKs and in-memory tracker stubs — no external services needed. Currently 76 tests across 9 files.

## Conventions

- All comments in code and all `.md` files should be in English.
- Never add authorship or co-authorship attribution to documents, commit messages, or MR descriptions.
- `git commit` and `git push` only with explicit user confirmation.
