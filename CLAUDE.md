# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Conductor

Conductor is a long-running daemon that polls a Linear issue tracker, dispatches coding agent sessions (via Claude Agent SDK) into per-issue workspaces, and manages retries/reconciliation. It is a scheduler/runner — ticket writes (state transitions, comments, PRs) are performed by the coding agent, not by Conductor itself.

## Repository status

This repo is in early implementation phase. Currently contains only specification and workflow definition — no source code yet.

- `SPEC.md` — the authoritative specification (~2000 lines). Covers domain model, orchestration state machine, config schema, agent runner protocol (Claude Agent SDK), reference algorithms, test matrix, and implementation checklist.
- `WORKFLOW.md` — example workflow file with YAML front matter (tracker/polling/workspace/hooks/agent config) + Liquid prompt template. **Note:** the `codex:` section in WORKFLOW.md is legacy and should be replaced with `agent:` fields per SPEC.md §5.3.5.

## Architecture (from SPEC.md)

Six core components, one optional:

1. **Workflow Loader** — parses `WORKFLOW.md` (YAML front matter + prompt body)
2. **Config Layer** — typed getters, defaults, `$VAR` env resolution, dynamic reload via file watch
3. **Issue Tracker Client** — Linear GraphQL adapter (fetch candidates, state refresh, terminal cleanup)
4. **Orchestrator** — single-authority in-memory state: poll loop, dispatch, concurrency, retry queue, reconciliation, stall detection
5. **Workspace Manager** — per-issue dirs under `workspace.root`, lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
6. **Agent Runner** — builds prompt, calls `query()` from `@anthropic-ai/claude-agent-sdk`, iterates `SDKMessage` stream, forwards events to orchestrator
7. **HTTP Server** (optional) — JSON API at `/api/v1/*` + dashboard at `/`

## Key design decisions

- **Claude Agent SDK** (not subprocess): `query({ prompt, options })` returns `AsyncGenerator<SDKMessage>`. Key message types: `SDKAssistantMessage`, `SDKResultMessage`, `SDKRateLimitEvent`.
- **Single-authority orchestrator**: all state mutations go through one serialized component. No distributed state.
- **In-memory state**: no persistent DB. Recovery is tracker-driven + filesystem-driven after restart.
- **WORKFLOW.md is the config file**: dynamic reload on file change, no restart needed for most settings.
- **Retry model**: normal exit → 1s continuation retry; failure → exponential backoff `min(10000 * 2^(attempt-1), agent.max_retry_backoff_ms)`.

## Config schema (WORKFLOW.md front matter)

Key sections: `tracker`, `polling`, `workspace`, `hooks`, `agent`. See SPEC.md §5.3 and §6.4 for full field reference. The `agent` section includes: `max_concurrent_agents`, `max_turns`, `permission_mode`, `allowed_tools`, `model`, `system_prompt`, `turn_timeout_ms`, `stall_timeout_ms`, `sandbox`, `env`, `max_budget_usd`.

## Conventions

- All comments in code and all `.md` files should be in English.
- Never add authorship or co-authorship attribution to documents, commit messages, or MR descriptions.
- `git commit` and `git push` only with explicit user confirmation.
