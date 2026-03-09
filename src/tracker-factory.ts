import type { TrackerConfig, ITrackerClient } from './types.js';
import { TrackerClient } from './tracker.js';
import { LocalTrackerClient } from './local-tracker.js';
import { BeadsTrackerClient } from './beads-tracker.js';

export function createTracker(config: TrackerConfig): ITrackerClient {
  switch (config.kind) {
    case 'linear':
      return new TrackerClient(config);
    case 'local':
      return new LocalTrackerClient(config);
    case 'beads':
      return new BeadsTrackerClient(config);
    default:
      throw new Error(`Unknown tracker kind: ${config.kind}`);
  }
}
