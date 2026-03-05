---
tracker:
  kind: local
  issues_dir: ./issues
  active_states:
    - Todo
    - In Progress
    - Rework
  terminal_states:
    - Done
    - Cancelled
polling:
  interval_ms: 5000
workspace:
  root: ~/conductor-workspaces
hooks:
  after_create: |
    echo "Workspace created for {{ issue.identifier }}"
agent:
  max_concurrent_agents: 3
  max_turns: 20
  permission_mode: "acceptEdits"
---

You are working on a local issue `{{ issue.identifier }}`.

Title: {{ issue.title }}
Current status: {{ issue.state }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
