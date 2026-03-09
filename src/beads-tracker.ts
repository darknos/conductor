import type { Issue, BlockerRef, TrackerConfig, ITrackerClient } from './types.js';
import * as logger from './logger.js';

/**
 * Beads issue tracker adapter.
 *
 * Uses @herbcaudill/beads-sdk (which spawns `bd` CLI subprocess) to read
 * issues from a local beads repository.
 *
 * Beads statuses map to Conductor states:
 *   open        → Todo
 *   in_progress → In Progress
 *   blocked     → In Progress (with blockers)
 *   closed      → Done
 *   deferred    → Backlog
 */

// Beads SDK types (imported dynamically)
interface BdIssue {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: number;
  issue_type: string;
  created_at: string;
  updated_at: string;
  blocked_by?: string[];
  dependencies?: Array<{ id: string; status?: string; dependency_type?: string }>;
}

interface BdListOptions {
  limit?: number;
  status?: string;
  all?: boolean;
  ready?: boolean;
}

interface BeadsClientLike {
  list(options?: BdListOptions): Promise<BdIssue[]>;
  show(ids: string | string[]): Promise<BdIssue[]>;
  getLabels(id: string): Promise<string[]>;
}

const BEADS_STATUS_MAP: Record<string, string> = {
  open: 'Todo',
  in_progress: 'In Progress',
  blocked: 'In Progress',
  closed: 'Done',
  deferred: 'Backlog',
};

function mapBeadsStatus(beadsStatus: string): string {
  return BEADS_STATUS_MAP[beadsStatus] ?? beadsStatus;
}

function normalizeBeadsIssue(bi: BdIssue): Issue {
  const blockedBy: BlockerRef[] = (bi.blocked_by ?? []).map((blockerId) => ({
    id: blockerId,
    identifier: blockerId,
    state: null,
  }));

  return {
    id: bi.id,
    identifier: bi.id,
    title: bi.title,
    description: bi.description ?? null,
    priority: bi.priority ?? null,
    state: mapBeadsStatus(bi.status),
    branchName: null,
    url: null,
    labels: [],
    blockedBy,
    createdAt: bi.created_at ? new Date(bi.created_at) : null,
    updatedAt: bi.updated_at ? new Date(bi.updated_at) : null,
  };
}

export class BeadsTrackerClient implements ITrackerClient {
  private repoPath: string;
  private client: BeadsClientLike | null = null;

  constructor(config: TrackerConfig) {
    if (!config.beadsRepoPath) {
      throw new Error('BeadsTrackerClient requires tracker.beads_repo_path to be set');
    }
    this.repoPath = config.beadsRepoPath;
  }

  updateConfig(config: TrackerConfig): void {
    if (config.beadsRepoPath && config.beadsRepoPath !== this.repoPath) {
      this.repoPath = config.beadsRepoPath;
      this.client = null; // Force re-creation
    }
  }

  private async getClient(): Promise<BeadsClientLike> {
    if (this.client) return this.client;

    const { BeadsClient } = await import('@herbcaudill/beads-sdk');
    this.client = new BeadsClient({ cwd: this.repoPath }) as BeadsClientLike;
    logger.info('Created beads client', { repoPath: this.repoPath });
    return this.client;
  }

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    const client = await this.getClient();
    // Fetch non-closed issues
    const issues = await client.list({ limit: 500 });
    const normalized = issues.map(normalizeBeadsIssue);
    const candidates = normalized.filter((i) => activeStates.includes(i.state));
    logger.debug(`Fetched ${candidates.length} candidate issues from beads`);
    return candidates;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const client = await this.getClient();
    const issues = await client.show(ids);
    return issues.map(normalizeBeadsIssue);
  }

  async fetchAllProjectIssues(): Promise<Issue[]> {
    const client = await this.getClient();
    const all = await client.list({ all: true, limit: 1000 });
    logger.debug(`Fetched ${all.length} total issues from beads`);
    return all.map(normalizeBeadsIssue);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const all = await this.fetchAllProjectIssues();
    return all.filter((i) => stateNames.includes(i.state));
  }
}
