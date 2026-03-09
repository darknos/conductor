---
tracker:
  kind: local
  issues_dir: ./issues
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
polling:
  interval_ms: 5000
dashboard:
  auto_launch: false
workspace:
  root: ~/conductor-workspaces
agent:
  max_concurrent_agents: 2
  max_turns: 10
  model: claude-haiku-4-5-20251001
  permission_mode: acceptEdits
server:
  port: 8080
---

You are working on issue `{{ issue.identifier }}`.

Title: {{ issue.title }}
State: {{ issue.state }}

{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
