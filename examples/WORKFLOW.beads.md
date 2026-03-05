---
tracker:
  kind: beads
  beads_repo_path: .
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
polling:
  interval_ms: 5000
dashboard:
  auto_launch: true
  port: 3000
workspace:
  root: ~/conductor-workspaces
agent:
  max_concurrent_agents: 5
  max_turns: 20
  permission_mode: "acceptEdits"
---

You are working on issue `{{ issue.identifier }}`.

Title: {{ issue.title }}
Current status: {{ issue.state }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
