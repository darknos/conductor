---
id: local-2
identifier: LOCAL-2
title: Fix login error handling
state: In Progress
priority: 2
labels: [bug]
blocked_by:
  - identifier: LOCAL-1
    state: Todo
---

Login form shows generic "Something went wrong" instead of specific error messages.

## Steps to Reproduce

1. Enter invalid credentials
2. Submit form
3. See generic error instead of "Invalid email or password"
