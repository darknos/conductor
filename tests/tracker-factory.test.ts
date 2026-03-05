import { describe, it, expect } from 'vitest';
import { createTracker } from '../src/tracker-factory.js';
import { TrackerClient } from '../src/tracker.js';
import { LocalTrackerClient } from '../src/local-tracker.js';
import type { TrackerConfig } from '../src/types.js';

const baseConfig: TrackerConfig = {
  kind: 'linear',
  endpoint: 'https://api.linear.app/graphql',
  apiKey: 'test-key',
  projectSlug: 'test-project',
  activeStates: ['Todo'],
  terminalStates: ['Done'],
  issuesDir: null,
};

describe('createTracker', () => {
  it('should create TrackerClient for linear kind', () => {
    const tracker = createTracker({ ...baseConfig, kind: 'linear' });
    expect(tracker).toBeInstanceOf(TrackerClient);
  });

  it('should create LocalTrackerClient for local kind', () => {
    const tracker = createTracker({ ...baseConfig, kind: 'local', issuesDir: '/tmp/issues' });
    expect(tracker).toBeInstanceOf(LocalTrackerClient);
  });

  it('should throw for unknown kind', () => {
    expect(() => createTracker({ ...baseConfig, kind: 'jira' })).toThrow('Unknown tracker kind: jira');
  });
});
