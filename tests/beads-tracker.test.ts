import { describe, it, expect, vi } from 'vitest';
import { BeadsTrackerClient } from '../src/beads-tracker.js';
import type { TrackerConfig } from '../src/types.js';

function makeConfig(repoPath: string): TrackerConfig {
  return {
    kind: 'beads',
    endpoint: '',
    apiKey: '',
    projectSlug: '',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Cancelled'],
    issuesDir: null,
    beadsRepoPath: repoPath,
  };
}

describe('BeadsTrackerClient', () => {
  it('should throw on construction without beadsRepoPath', () => {
    expect(() => {
      new BeadsTrackerClient({
        ...makeConfig('/tmp/repo'),
        beadsRepoPath: null,
      });
    }).toThrow('requires tracker.beads_repo_path');
  });

  it('should construct with valid beadsRepoPath', () => {
    const client = new BeadsTrackerClient(makeConfig('/tmp/beads-repo'));
    expect(client).toBeInstanceOf(BeadsTrackerClient);
  });

  it('should return empty array for fetchIssueStatesByIds with empty ids', async () => {
    const client = new BeadsTrackerClient(makeConfig('/tmp/beads-repo'));
    const result = await client.fetchIssueStatesByIds([]);
    expect(result).toEqual([]);
  });

  it('should accept config update with new repoPath', () => {
    const client = new BeadsTrackerClient(makeConfig('/tmp/repo-1'));
    // Should not throw
    client.updateConfig(makeConfig('/tmp/repo-2'));
  });
});
