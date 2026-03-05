import type { Issue, BlockerRef, TrackerConfig } from './types.js';
import * as logger from './logger.js';

const DEFAULT_PAGE_SIZE = 50;
const NETWORK_TIMEOUT_MS = 30_000;

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  state: { name: string };
  branchName?: string | null;
  url?: string | null;
  labels?: { nodes: Array<{ name: string }> };
  relations?: { nodes: Array<{ type: string; relatedIssue: { id: string; identifier: string; state: { name: string } } }> };
  inverseRelations?: { nodes: Array<{ type: string; issue: { id: string; identifier: string; state: { name: string } } }> };
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface GraphQLResponse {
  data?: {
    issues?: {
      nodes: LinearIssueNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
}

function normalizeIssue(node: LinearIssueNode): Issue {
  const labels = (node.labels?.nodes ?? []).map((l) => l.name.toLowerCase());

  const blockedBy: BlockerRef[] = [];
  // Derive blockers from inverse relations where relation type is "blocks"
  for (const rel of node.inverseRelations?.nodes ?? []) {
    if (rel.type === 'blocks') {
      blockedBy.push({
        id: rel.issue.id,
        identifier: rel.issue.identifier,
        state: rel.issue.state.name,
      });
    }
  }

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: node.priority ?? null,
    state: node.state.name,
    branchName: node.branchName ?? null,
    url: node.url ?? null,
    labels,
    blockedBy,
    createdAt: node.createdAt ? new Date(node.createdAt) : null,
    updatedAt: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  state { name }
  branchName
  url
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
  createdAt
  updatedAt
`;

export class TrackerClient {
  private endpoint: string;
  private apiKey: string;
  private projectSlug: string;

  constructor(config: TrackerConfig) {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.projectSlug = config.projectSlug;
  }

  updateConfig(config: TrackerConfig): void {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.projectSlug = config.projectSlug;
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
      }

      return await response.json() as GraphQLResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const result = await this.graphql(
        `query($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
          issues(
            filter: {
              project: { slugId: { eq: $projectSlug } }
              state: { name: { in: $states } }
            }
            first: $first
            after: $after
          ) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        {
          projectSlug: this.projectSlug,
          states: activeStates,
          first: DEFAULT_PAGE_SIZE,
          after: cursor,
        },
      );

      if (result.errors?.length) {
        throw new Error(`Linear GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`);
      }

      const issues = result.data?.issues;
      if (!issues) break;

      allIssues.push(...issues.nodes.map(normalizeIssue));
      hasMore = issues.pageInfo.hasNextPage;
      cursor = issues.pageInfo.endCursor;
    }

    logger.debug(`Fetched ${allIssues.length} candidate issues`);
    return allIssues;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];

    const allIssues: Issue[] = [];
    // Batch IDs in chunks to avoid overly large queries
    const chunkSize = DEFAULT_PAGE_SIZE;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const result = await this.graphql(
        `query($ids: [ID!]!) {
          issues(filter: { id: { in: $ids } }) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { ids: chunk },
      );

      if (result.errors?.length) {
        throw new Error(`Linear GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`);
      }

      const issues = result.data?.issues;
      if (issues) {
        allIssues.push(...issues.nodes.map(normalizeIssue));
      }
    }

    return allIssues;
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const result = await this.graphql(
        `query($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
          issues(
            filter: {
              project: { slugId: { eq: $projectSlug } }
              state: { name: { in: $states } }
            }
            first: $first
            after: $after
          ) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        {
          projectSlug: this.projectSlug,
          states: stateNames,
          first: DEFAULT_PAGE_SIZE,
          after: cursor,
        },
      );

      if (result.errors?.length) {
        throw new Error(`Linear GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`);
      }

      const issues = result.data?.issues;
      if (!issues) break;

      allIssues.push(...issues.nodes.map(normalizeIssue));
      hasMore = issues.pageInfo.hasNextPage;
      cursor = issues.pageInfo.endCursor;
    }

    return allIssues;
  }
}
