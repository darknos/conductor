import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Issue, TrackerConfig, ITrackerClient } from './types.js';
import * as logger from './logger.js';

/**
 * File-based local tracker adapter.
 *
 * Each issue is a markdown file with YAML front matter in the configured
 * `issuesDir` directory. File format:
 *
 * ```
 * ---
 * id: unique-id
 * identifier: LOCAL-1
 * title: My task title
 * state: Todo
 * priority: 1
 * labels: [bug, urgent]
 * blocked_by:
 *   - identifier: LOCAL-2
 *     state: In Progress
 * ---
 *
 * Description body in markdown.
 * ```
 *
 * The `state` field is what the orchestrator uses for dispatch decisions.
 * Agents can update state by modifying the front matter directly (or a
 * higher-level tool can wrap this).
 */

interface IssueFrontMatter {
  id?: string;
  identifier?: string;
  title?: string;
  state?: string;
  priority?: number | null;
  branch_name?: string | null;
  url?: string | null;
  labels?: string[];
  blocked_by?: Array<{
    id?: string | null;
    identifier?: string | null;
    state?: string | null;
  }>;
}

function parseIssueFile(filename: string, content: string): Issue | null {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    logger.warn(`Skipping ${filename}: no YAML front matter`);
    return null;
  }

  let meta: IssueFrontMatter;
  try {
    meta = parseYaml(fmMatch[1]) as IssueFrontMatter;
  } catch (err) {
    logger.warn(`Skipping ${filename}: invalid YAML`, { error: String(err) });
    return null;
  }

  if (!meta || typeof meta !== 'object') {
    logger.warn(`Skipping ${filename}: front matter is not a map`);
    return null;
  }

  const identifier = meta.identifier ?? filename.replace(/\.(md|markdown)$/i, '');
  const id = meta.id ?? identifier;

  // Body is everything after the closing ---
  const bodyStart = fmMatch[0].length;
  const description = content.slice(bodyStart).trim() || null;

  const blockedBy = (meta.blocked_by ?? []).map((b) => ({
    id: b.id ?? null,
    identifier: b.identifier ?? null,
    state: b.state ?? null,
  }));

  return {
    id,
    identifier,
    title: meta.title ?? identifier,
    description,
    priority: meta.priority ?? null,
    state: meta.state ?? 'Todo',
    branchName: meta.branch_name ?? null,
    url: meta.url ?? null,
    labels: (meta.labels ?? []).map((l) => String(l).toLowerCase()),
    blockedBy,
    createdAt: null,
    updatedAt: null,
  };
}

export class LocalTrackerClient implements ITrackerClient {
  private issuesDir: string;

  constructor(config: TrackerConfig) {
    if (!config.issuesDir) {
      throw new Error('LocalTrackerClient requires tracker.issues_dir to be set');
    }
    this.issuesDir = config.issuesDir;
  }

  updateConfig(config: TrackerConfig): void {
    if (config.issuesDir) {
      this.issuesDir = config.issuesDir;
    }
  }

  private async loadAllIssues(): Promise<Issue[]> {
    let entries: string[];
    try {
      entries = await readdir(this.issuesDir);
    } catch (err) {
      logger.error('Failed to read issues directory', {
        dir: this.issuesDir,
        error: String(err),
      });
      return [];
    }

    const mdFiles = entries.filter(
      (f) => extname(f).toLowerCase() === '.md' || extname(f).toLowerCase() === '.markdown',
    );

    const issues: Issue[] = [];
    for (const filename of mdFiles) {
      try {
        const content = await readFile(join(this.issuesDir, filename), 'utf-8');
        const issue = parseIssueFile(filename, content);
        if (issue) {
          issues.push(issue);
        }
      } catch (err) {
        logger.warn(`Failed to read issue file ${filename}`, { error: String(err) });
      }
    }

    logger.debug(`Loaded ${issues.length} issues from ${this.issuesDir}`);
    return issues;
  }

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    const all = await this.loadAllIssues();
    return all.filter((i) => activeStates.includes(i.state));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const all = await this.loadAllIssues();
    const idSet = new Set(ids);
    return all.filter((i) => idSet.has(i.id));
  }

  async fetchAllProjectIssues(): Promise<Issue[]> {
    return this.loadAllIssues();
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const all = await this.loadAllIssues();
    return all.filter((i) => stateNames.includes(i.state));
  }
}
