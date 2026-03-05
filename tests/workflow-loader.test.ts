import { describe, it, expect } from 'vitest';
import { parseWorkflowContent, loadWorkflow } from '../src/workflow-loader.js';
import { WorkflowError, WorkflowErrorKind } from '../src/types.js';

describe('parseWorkflowContent', () => {
  it('parses valid front matter and body', () => {
    const input = `---
tracker:
  kind: linear
  project_slug: test-123
agent:
  max_turns: 5
---

Hello {{ issue.identifier }}`;

    const result = parseWorkflowContent(input);

    expect(result.config).toEqual({
      tracker: { kind: 'linear', project_slug: 'test-123' },
      agent: { max_turns: 5 },
    });
    expect(result.promptTemplate).toBe('Hello {{ issue.identifier }}');
  });

  it('returns empty config when no front matter', () => {
    const input = 'Just a plain template {{ issue.title }}';
    const result = parseWorkflowContent(input);
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe('Just a plain template {{ issue.title }}');
  });

  it('throws on unterminated front matter', () => {
    const input = `---
tracker:
  kind: linear
no closing delimiter`;

    expect(() => parseWorkflowContent(input)).toThrow(WorkflowError);
    try {
      parseWorkflowContent(input);
    } catch (err) {
      expect((err as WorkflowError).kind).toBe(WorkflowErrorKind.ParseError);
    }
  });

  it('throws on invalid YAML', () => {
    const input = `---
: : : invalid yaml [[[
---
body`;

    expect(() => parseWorkflowContent(input)).toThrow(WorkflowError);
  });

  it('throws when front matter is not a map', () => {
    const input = `---
- item1
- item2
---
body`;

    expect(() => parseWorkflowContent(input)).toThrow(WorkflowError);
    try {
      parseWorkflowContent(input);
    } catch (err) {
      expect((err as WorkflowError).kind).toBe(WorkflowErrorKind.FrontMatterNotAMap);
    }
  });

  it('handles empty front matter as empty config', () => {
    const input = `---
---
body content`;

    const result = parseWorkflowContent(input);
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toBe('body content');
  });
});

describe('loadWorkflow', () => {
  it('throws MissingFile for non-existent path', async () => {
    await expect(loadWorkflow('/nonexistent/WORKFLOW.md')).rejects.toThrow(WorkflowError);
    try {
      await loadWorkflow('/nonexistent/WORKFLOW.md');
    } catch (err) {
      expect((err as WorkflowError).kind).toBe(WorkflowErrorKind.MissingFile);
    }
  });
});
