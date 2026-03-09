# Conductor

A daemon that polls issue trackers, dispatches [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) coding sessions into per-issue workspaces, and manages retries and reconciliation.

Conductor is a scheduler/runner — ticket writes (state transitions, comments, PRs) are performed by the coding agent, not by Conductor itself.

Inspired by [Symphony](https://github.com/anthropics/symphony) — Conductor extends the same idea with multi-tracker support, in-memory orchestration, dynamic config reload, and a built-in Kanban dashboard.

## Quick Start

```bash
npm install
npx tsx src/main.ts --workflow examples/WORKFLOW.local.md
```

Open `http://localhost:8080` for the built-in Kanban board.

### Local Demo

The `examples/` directory includes a file-based tracker with sample issues:

```
examples/
  WORKFLOW.local.md      # Config + prompt template
  issues/
    LOCAL-1.md           # "Create hello.txt"
    LOCAL-2.md           # "Create goodbye.txt"
    LOCAL-3.md           # Already Done
```

Each issue is a Markdown file with YAML front matter (`id`, `identifier`, `title`, `state`, etc.). Conductor polls `issues/`, dispatches an agent per active issue, and marks them Done on completion.

## How It Works

```
WORKFLOW.md ──→ Config + Prompt Template
                      │
                      ▼
              ┌──────────────┐
              │ Orchestrator │──→ Poll loop (fetch → reconcile → sort → dispatch)
              └──────┬───────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Agent 1 │ │ Agent 2 │ │ Agent N │   Claude Agent SDK sessions
   │ (ws/A-1)│ │ (ws/A-2)│ │ (ws/A-N)│   in per-issue workspaces
   └─────────┘ └─────────┘ └─────────┘
```

1. **Poll** — fetch active issues from tracker (Linear, local files, or Beads)
2. **Sort** — by priority (ascending), then creation date, then identifier
3. **Dispatch** — launch Claude Agent SDK `query()` per issue, respecting concurrency limits
4. **Monitor** — stall detection, reconciliation (cancel if issue goes terminal)
5. **Retry** — continuation retry (1s) on normal exit; exponential backoff on failure

## Configuration

All configuration lives in a single `WORKFLOW.md` file — YAML front matter for settings, Markdown body for the Liquid prompt template:

```yaml
---
tracker:
  kind: linear              # linear | local | beads
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]
polling:
  interval_ms: 30000
workspace:
  root: ~/conductor-workspaces
agent:
  max_concurrent_agents: 10
  max_turns: 20
  model: claude-sonnet-4-6
  permission_mode: acceptEdits
  allowed_tools: [Read, Edit, Glob, Grep, Bash]
  stall_timeout_ms: 300000
  max_retry_backoff_ms: 300000
server:
  port: 8080
---

You are working on issue `{{ issue.identifier }}`.

Title: {{ issue.title }}

{{ issue.description | default: "No description provided." }}
```

Config reloads automatically on file change — no restart needed.

### Tracker Adapters

| Kind | Description | Required Config |
|------|-------------|-----------------|
| `linear` | Linear GraphQL API | `api_key`, `project_slug` |
| `local` | File-based (Markdown with YAML front matter) | `issues_dir` |
| `beads` | [Beads SDK](https://github.com/herbcaudill/beads) | `beads_repo_path` |

### CLI

```bash
npx tsx src/main.ts [--workflow path/to/WORKFLOW.md] [--port 8080]
```

- `--workflow` — path to workflow file (default: `./WORKFLOW.md`)
- `--port` — HTTP server port (overrides `server.port` in config)

## HTTP API

When `server.port` is set, Conductor serves a JSON API and a Kanban dashboard:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Kanban board (HTML) |
| `/api/v1/state` | GET | Current system state (running, retrying, totals) |
| `/api/v1/<identifier>` | GET | Per-issue debug details |
| `/api/v1/refresh` | POST | Trigger immediate poll + reconciliation |

## Development

```bash
npm test                             # Run all tests (vitest)
npx vitest run tests/config.test.ts  # Run single test file
npx tsc --noEmit                     # Type-check
npm run build                        # Build to dist/
```

## Architecture

See [SPEC.md](SPEC.md) for the full specification. Six core components:

- **Workflow Loader** — parses YAML front matter + Liquid template
- **Config Layer** — typed getters, `$VAR` env resolution, dynamic reload
- **Tracker Client** — Linear, local file, or Beads adapter
- **Orchestrator** — single-authority state machine (poll, dispatch, retry, reconcile)
- **Workspace Manager** — per-issue directories with lifecycle hooks
- **Agent Runner** — renders prompt, calls Claude Agent SDK `query()`, streams messages

## License

Apache 2.0
