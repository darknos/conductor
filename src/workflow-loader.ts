import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { WorkflowDefinition, WorkflowError, WorkflowErrorKind } from './types.js';

const FRONT_MATTER_DELIMITER = '---';

export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    throw new WorkflowError(WorkflowErrorKind.MissingFile, `Workflow file not found: ${filePath}`);
  }

  return parseWorkflowContent(raw);
}

export function parseWorkflowContent(raw: string): WorkflowDefinition {
  const trimmed = raw.trimStart();

  if (!trimmed.startsWith(FRONT_MATTER_DELIMITER)) {
    return { config: {}, promptTemplate: trimmed.trim() };
  }

  const afterFirst = trimmed.slice(FRONT_MATTER_DELIMITER.length);
  const endIndex = afterFirst.indexOf(`\n${FRONT_MATTER_DELIMITER}`);

  if (endIndex === -1) {
    throw new WorkflowError(
      WorkflowErrorKind.ParseError,
      'Unterminated YAML front matter: missing closing ---',
    );
  }

  const yamlBlock = afterFirst.slice(0, endIndex);
  const body = afterFirst.slice(endIndex + 1 + FRONT_MATTER_DELIMITER.length).trim();

  let config: unknown;
  try {
    config = parseYaml(yamlBlock);
  } catch (err) {
    throw new WorkflowError(
      WorkflowErrorKind.ParseError,
      `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (config === null || config === undefined) {
    return { config: {}, promptTemplate: body };
  }

  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new WorkflowError(
      WorkflowErrorKind.FrontMatterNotAMap,
      'YAML front matter must be a map/object',
    );
  }

  return { config: config as Record<string, unknown>, promptTemplate: body };
}
