import type { Issue, BlockerRef, TrackerConfig, ITrackerClient } from './types.js';
import * as logger from './logger.js';

/**
 * Beads issue tracker adapter.
 *
 * Uses @herbcaudill/beads-sdk to communicate with a local beads daemon
 * via Unix socket. Requires `beads_repo_path` in tracker config.
 *
 * Beads statuses map to Conductor states:
 *   open        → Todo
 *   in_progress → In Progress
 *   blocked     → In Progress (with blockers)
 *   closed      → Done
 *   resolved    → Done
 *   deferred    → Backlog
 *
 * Custom status strings are passed through as-is.
 */

// Beads SDK types (minimal surface we use)
interface BeadsIssue {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: number | null;
  labels?: string[];
  dependencies?: BeadsLinkedIssue[];
  dependents?: BeadsLinkedIssue[];
  created_at?: string | null;
  updated_at?: string | null;
  external_ref?: string | null;
}

interface BeadsLinkedIssue {
  id: string;
  title?: string;
  status?: string;
  dependency_type?: string;
}

interface BeadsClientInstance {
  connect(repoPath: string): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  list(filters?: Record<string, unknown>): Promise<BeadsIssue[]>;
  show(id: string): Promise<BeadsIssue>;
  showMany(ids: string[]): Promise<BeadsIssue[]>;
  ready(filters?: Record<string, unknown>): Promise<BeadsIssue[]>;
}

// Status mapping from beads → conductor state names
const BEADS_STATUS_MAP: Record<string, string> = {
  open: 'Todo',
  in_progress: 'In Progress',
  blocked: 'In Progress',
  closed: 'Done',
  resolved: 'Done',
  deferred: 'Backlog',
};

function mapBeadsStatus(beadsStatus: string): string {
  return BEADS_STATUS_MAP[beadsStatus] ?? beadsStatus;
}

function normalizeBeadsIssue(bi: BeadsIssue): Issue {
  const blockedBy: BlockerRef[] = [];
  for (const dep of bi.dependencies ?? []) {
    if (dep.dependency_type === 'blocks') {
      blockedBy.push({
        id: dep.id,
        identifier: dep.id,
        state: dep.status ? mapBeadsStatus(dep.status) : null,
      });
    }
  }

  return {
    id: bi.id,
    identifier: bi.id,
    title: bi.title,
    description: bi.description ?? null,
    priority: bi.priority ?? null,
    state: mapBeadsStatus(bi.status),
    branchName: null,
    url: bi.external_ref ?? null,
    labels: (bi.labels ?? []).map((l) => l.toLowerCase()),
    blockedBy,
    createdAt: bi.created_at ? new Date(bi.created_at) : null,
    updatedAt: bi.updated_at ? new Date(bi.updated_at) : null,
  };
}

export class BeadsTrackerClient implements ITrackerClient {
  private repoPath: string;
  private client: BeadsClientInstance | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(config: TrackerConfig) {
    if (!config.beadsRepoPath) {
      throw new Error('BeadsTrackerClient requires tracker.beads_repo_path to be set');
    }
    this.repoPath = config.beadsRepoPath;
  }

  updateConfig(config: TrackerConfig): void {
    if (config.beadsRepoPath && config.beadsRepoPath !== this.repoPath) {
      this.repoPath = config.beadsRepoPath;
      // Force reconnect on next operation
      this.disconnect().catch(() => {});
      this.client = null;
      this.connectPromise = null;
    }
  }

  private async ensureConnected(): Promise<BeadsClientInstance> {
    if (this.client?.isConnected()) {
      return this.client;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      if (this.client?.isConnected()) return this.client;
    }

    this.connectPromise = this.doConnect();
    await this.connectPromise;
    return this.client!;
  }

  private async doConnect(): Promise<void> {
    try {
      // Dynamic import — beads-sdk is an optional dependency
      // @ts-expect-error — optional dependency, may not be installed
      const { BeadsClient } = await import('@herbcaudill/beads-sdk');
      this.client = new BeadsClient({ actor: 'conductor' }) as unknown as BeadsClientInstance;
      await this.client.connect(this.repoPath);
      logger.info('Connected to beads daemon', { repoPath: this.repoPath });
    } catch (err) {
      this.client = null;
      throw new Error(`Failed to connect to beads daemon at ${this.repoPath}: ${err}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client?.isConnected()) {
      await this.client.disconnect();
    }
    this.client = null;
    this.connectPromise = null;
  }

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    const client = await this.ensureConnected();
    // Fetch all open/in-progress issues, then filter by active states
    const allIssues = await client.list({ status: 'open' });
    const inProgress = await client.list({ status: 'in_progress' });
    const blocked = await client.list({ status: 'blocked' });

    const combined = [...allIssues, ...inProgress, ...blocked];
    // Deduplicate by id
    const seen = new Set<string>();
    const unique: BeadsIssue[] = [];
    for (const issue of combined) {
      if (!seen.has(issue.id)) {
        seen.add(issue.id);
        unique.push(issue);
      }
    }

    const normalized = unique.map(normalizeBeadsIssue);
    const candidates = normalized.filter((i) => activeStates.includes(i.state));
    logger.debug(`Fetched ${candidates.length} candidate issues from beads`);
    return candidates;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const client = await this.ensureConnected();
    const beadsIssues = await client.showMany(ids);
    return beadsIssues.map(normalizeBeadsIssue);
  }

  async fetchAllProjectIssues(): Promise<Issue[]> {
    const client = await this.ensureConnected();
    const all = await client.list({});
    logger.debug(`Fetched ${all.length} total issues from beads`);
    return all.map(normalizeBeadsIssue);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const all = await this.fetchAllProjectIssues();
    return all.filter((i) => stateNames.includes(i.state));
  }
}
