---
name: debug
description:
  Investigate stuck runs and execution failures by tracing Conductor logs
  with issue/session identifiers; use when runs stall, retry repeatedly, or
  fail unexpectedly.
---

# Debug

## Goals

- Find why a run is stuck, retrying, or failing.
- Correlate Linear issue identity to an agent session quickly.
- Read the right logs in the right order to isolate root cause.

## Log Sources

- Primary runtime log: stderr (structured JSON)
  - Includes orchestrator, agent runner, and agent session lifecycle logs.
- If Conductor output is redirected to a file, check that file.

## Correlation Keys

- `issueIdentifier`: human ticket key (example: `MT-625`)
- `issueId`: Linear UUID (stable internal ID)
- `sessionId`: agent session identifier

## Quick Triage (Stuck Run)

1. Confirm scheduler/worker symptoms for the ticket.
2. Find recent lines for the ticket (`issueIdentifier` first).
3. Extract `sessionId` from matching lines.
4. Trace that `sessionId` across start, stream, completion/failure, and stall
   handling logs.
5. Decide class of failure: timeout/stall, agent startup failure, turn
   failure, or orchestrator retry loop.

## Commands

```bash
# 1) Narrow by ticket key (fastest entry point)
rg -n "issueIdentifier.*MT-625" conductor.log*

# 2) If needed, narrow by Linear UUID
rg -n "issueId.*<linear-uuid>" conductor.log*

# 3) Pull session IDs seen for that ticket
rg -o '"sessionId":"[^"]*"' conductor.log* | sort -u

# 4) Trace one session end-to-end
rg -n "<session-id>" conductor.log*

# 5) Focus on stuck/retry signals
rg -n "stall|scheduling retry|timeout|turn_failed|Agent attempt finished.*failure" conductor.log*
```

## Investigation Flow

1. Locate the ticket slice:
    - Search by `issueIdentifier`.
    - If noise is high, add `issueId`.
2. Establish timeline:
    - Identify first `session_started` event.
    - Follow with `turn_completed`, `turn_failed`, or worker exit lines.
3. Classify the problem:
    - Stall loop: `Stall detected ... restarting with backoff`.
    - Agent startup: `before_run hook failed`.
    - Turn execution failure: `turn_failed`, `timeout`, or `Agent attempt finished.*failure`.
    - Worker crash: `Unexpected agent error`.
4. Validate scope:
    - Check whether failures are isolated to one issue/session or repeating across
      multiple tickets.
5. Capture evidence:
    - Save key log lines with timestamps, `issueIdentifier`, `issueId`, and
      `sessionId`.
    - Record probable root cause and the exact failing stage.

## Reading Agent Session Logs

In Conductor, agent session diagnostics are emitted as structured JSON to
stderr, keyed by `issueId` and `sessionId`. Read them as a lifecycle:

1. `Dispatching <identifier>` - agent dispatched
2. `Agent attempt finished: <reason>` - attempt completed
3. `Scheduling retry for <identifier>` - retry queued
4. `Stall detected for <identifier>` - stall timeout triggered

For one specific session investigation, keep the trace narrow:

1. Capture one `issueId` for the ticket.
2. Build a timestamped slice for only that issue.
3. Mark the exact failing stage.
4. Pair findings with `issueIdentifier` to confirm you are not mixing
   concurrent retries.

## Notes

- Prefer `rg` over `grep` for speed on large logs.
- Check rotated logs before concluding data is missing.
- Conductor uses structured JSON logging; use `jq` for parsing when needed.
