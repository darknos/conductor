import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalTrackerClient } from '../src/local-tracker.js';
import type { TrackerConfig } from '../src/types.js';

function makeConfig(issuesDir: string): TrackerConfig {
  return {
    kind: 'local',
    endpoint: '',
    apiKey: '',
    projectSlug: '',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Cancelled'],
    issuesDir,
    beadsRepoPath: null,
  };
}

describe('LocalTrackerClient', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'local-tracker-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should parse a valid issue file', async () => {
    await writeFile(
      join(tempDir, 'TEST-1.md'),
      `---
id: test-1
identifier: TEST-1
title: My test issue
state: Todo
priority: 1
labels: [bug, Critical]
---

This is the description.
`,
    );

    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchAllProjectIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('test-1');
    expect(issues[0].identifier).toBe('TEST-1');
    expect(issues[0].title).toBe('My test issue');
    expect(issues[0].state).toBe('Todo');
    expect(issues[0].priority).toBe(1);
    expect(issues[0].labels).toEqual(['bug', 'critical']);
    expect(issues[0].description).toBe('This is the description.');
  });

  it('should default identifier from filename', async () => {
    await writeFile(
      join(tempDir, 'MY-ISSUE.md'),
      `---
title: Issue from filename
state: In Progress
---
`,
    );

    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchAllProjectIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].identifier).toBe('MY-ISSUE');
    expect(issues[0].id).toBe('MY-ISSUE');
  });

  it('should filter by active states for fetchCandidateIssues', async () => {
    await writeFile(join(tempDir, 'A.md'), '---\nstate: Todo\n---\n');
    await writeFile(join(tempDir, 'B.md'), '---\nstate: Done\n---\n');
    await writeFile(join(tempDir, 'C.md'), '---\nstate: In Progress\n---\n');

    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchCandidateIssues(['Todo', 'In Progress']);

    expect(issues).toHaveLength(2);
    const states = issues.map((i) => i.state).sort();
    expect(states).toEqual(['In Progress', 'Todo']);
  });

  it('should fetch issues by IDs', async () => {
    await writeFile(join(tempDir, 'X.md'), '---\nid: x1\nstate: Todo\n---\n');
    await writeFile(join(tempDir, 'Y.md'), '---\nid: y2\nstate: Done\n---\n');
    await writeFile(join(tempDir, 'Z.md'), '---\nid: z3\nstate: Todo\n---\n');

    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchIssueStatesByIds(['x1', 'z3']);

    expect(issues).toHaveLength(2);
    const ids = issues.map((i) => i.id).sort();
    expect(ids).toEqual(['x1', 'z3']);
  });

  it('should fetch issues by state names', async () => {
    await writeFile(join(tempDir, 'A.md'), '---\nstate: Todo\n---\n');
    await writeFile(join(tempDir, 'B.md'), '---\nstate: Done\n---\n');

    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchIssuesByStates(['Done']);

    expect(issues).toHaveLength(1);
    expect(issues[0].state).toBe('Done');
  });

  it('should return empty array for empty IDs', async () => {
    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchIssueStatesByIds([]);
    expect(issues).toEqual([]);
  });

  it('should skip files without front matter', async () => {
    await writeFile(join(tempDir, 'bad.md'), 'No front matter here\n');

    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchAllProjectIssues();

    expect(issues).toHaveLength(0);
  });

  it('should skip files with invalid YAML', async () => {
    await writeFile(join(tempDir, 'bad.md'), '---\n[invalid: yaml:\n---\n');

    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchAllProjectIssues();

    expect(issues).toHaveLength(0);
  });

  it('should ignore non-markdown files', async () => {
    await writeFile(join(tempDir, 'notes.txt'), '---\nstate: Todo\n---\n');
    await writeFile(join(tempDir, 'data.json'), '{}');

    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchAllProjectIssues();

    expect(issues).toHaveLength(0);
  });

  it('should handle blocked_by references', async () => {
    await writeFile(
      join(tempDir, 'ISSUE.md'),
      `---
state: In Progress
blocked_by:
  - identifier: OTHER-1
    state: Todo
  - identifier: OTHER-2
    state: Done
---
`,
    );

    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchAllProjectIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].blockedBy).toHaveLength(2);
    expect(issues[0].blockedBy[0].identifier).toBe('OTHER-1');
    expect(issues[0].blockedBy[0].state).toBe('Todo');
    expect(issues[0].blockedBy[1].identifier).toBe('OTHER-2');
  });

  it('should return empty array for missing directory', async () => {
    const client = new LocalTrackerClient(makeConfig('/nonexistent/dir'));
    const issues = await client.fetchAllProjectIssues();
    expect(issues).toEqual([]);
  });

  it('should throw on construction without issuesDir', () => {
    expect(() => {
      new LocalTrackerClient({
        ...makeConfig(tempDir),
        issuesDir: null,
      });
    }).toThrow('requires tracker.issues_dir');
  });

  it('should handle .markdown extension', async () => {
    await writeFile(join(tempDir, 'ITEM.markdown'), '---\nstate: Todo\ntitle: Markdown ext\n---\n');

    const client = new LocalTrackerClient(makeConfig(tempDir));
    const issues = await client.fetchAllProjectIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe('Markdown ext');
  });
});
