import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrackerClient } from '../src/tracker.js';
import type { TrackerConfig } from '../src/types.js';

const mockConfig: TrackerConfig = {
  kind: 'linear',
  endpoint: 'https://api.linear.app/graphql',
  apiKey: 'test-api-key',
  projectSlug: 'test-project',
  activeStates: ['Todo', 'In Progress'],
  terminalStates: ['Done', 'Closed'],
  issuesDir: null,
};

function makeIssueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'issue-1',
    identifier: 'TEST-1',
    title: 'Test Issue',
    description: 'A test issue',
    priority: 1,
    state: { name: 'Todo' },
    branchName: 'test/branch',
    url: 'https://linear.app/issue/TEST-1',
    labels: { nodes: [{ name: 'Bug' }, { name: 'URGENT' }] },
    inverseRelations: { nodes: [] },
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('TrackerClient', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchCandidateIssues returns normalized issues', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [makeIssueNode()],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });

    const client = new TrackerClient(mockConfig);
    const issues = await client.fetchCandidateIssues(['Todo', 'In Progress']);

    expect(issues).toHaveLength(1);
    expect(issues[0].identifier).toBe('TEST-1');
    expect(issues[0].state).toBe('Todo');
    expect(issues[0].labels).toEqual(['bug', 'urgent']); // lowercased
    expect(issues[0].createdAt).toBeInstanceOf(Date);
  });

  it('normalizes labels to lowercase', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [makeIssueNode({ labels: { nodes: [{ name: 'Feature' }, { name: 'HIGH PRIORITY' }] } })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });

    const client = new TrackerClient(mockConfig);
    const issues = await client.fetchCandidateIssues(['Todo']);
    expect(issues[0].labels).toEqual(['feature', 'high priority']);
  });

  it('derives blockers from inverse relations', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              makeIssueNode({
                inverseRelations: {
                  nodes: [
                    {
                      type: 'blocks',
                      issue: { id: 'blocker-1', identifier: 'TEST-2', state: { name: 'In Progress' } },
                    },
                    {
                      type: 'related',
                      issue: { id: 'related-1', identifier: 'TEST-3', state: { name: 'Todo' } },
                    },
                  ],
                },
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });

    const client = new TrackerClient(mockConfig);
    const issues = await client.fetchCandidateIssues(['Todo']);
    expect(issues[0].blockedBy).toHaveLength(1);
    expect(issues[0].blockedBy[0].identifier).toBe('TEST-2');
  });

  it('handles pagination', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [makeIssueNode({ id: '1', identifier: 'TEST-1' })],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [makeIssueNode({ id: '2', identifier: 'TEST-2' })],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      });

    const client = new TrackerClient(mockConfig);
    const issues = await client.fetchCandidateIssues(['Todo']);
    expect(issues).toHaveLength(2);
  });

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const client = new TrackerClient(mockConfig);
    await expect(client.fetchCandidateIssues(['Todo'])).rejects.toThrow('Linear API error: 401');
  });

  it('throws on GraphQL errors', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        errors: [{ message: 'Invalid query' }],
      }),
    });

    const client = new TrackerClient(mockConfig);
    await expect(client.fetchCandidateIssues(['Todo'])).rejects.toThrow('Linear GraphQL errors');
  });

  it('fetchIssueStatesByIds returns empty for empty input', async () => {
    const client = new TrackerClient(mockConfig);
    const result = await client.fetchIssueStatesByIds([]);
    expect(result).toEqual([]);
  });
});
