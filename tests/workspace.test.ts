import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeIdentifier, WorkspaceManager } from '../src/workspace.js';
import type { HookScripts } from '../src/types.js';

const noHooks: HookScripts = {
  afterCreate: null,
  beforeRun: null,
  afterRun: null,
  beforeRemove: null,
  timeoutMs: 5000,
};

describe('sanitizeIdentifier', () => {
  it('passes through valid chars', () => {
    expect(sanitizeIdentifier('ABC-123')).toBe('ABC-123');
  });

  it('replaces invalid chars with underscore', () => {
    expect(sanitizeIdentifier('AB/C 123')).toBe('AB_C_123');
  });

  it('handles dots and underscores', () => {
    expect(sanitizeIdentifier('issue.v1_fix')).toBe('issue.v1_fix');
  });

  it('replaces special chars', () => {
    expect(sanitizeIdentifier('issue@#$%')).toBe('issue____');
  });
});

describe('WorkspaceManager', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'conductor-ws-test-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('creates a new workspace directory', async () => {
    const mgr = new WorkspaceManager(tempRoot, noHooks);
    const ws = await mgr.createForIssue('TEST-1');
    expect(ws.createdNow).toBe(true);
    expect(ws.workspaceKey).toBe('TEST-1');
    await access(ws.path, constants.F_OK); // should not throw
  });

  it('reuses existing workspace', async () => {
    const mgr = new WorkspaceManager(tempRoot, noHooks);
    const ws1 = await mgr.createForIssue('TEST-2');
    expect(ws1.createdNow).toBe(true);
    const ws2 = await mgr.createForIssue('TEST-2');
    expect(ws2.createdNow).toBe(false);
    expect(ws2.path).toBe(ws1.path);
  });

  it('runs after_create hook on new workspace', async () => {
    const hooks: HookScripts = {
      ...noHooks,
      afterCreate: 'touch hook_ran.txt',
    };
    const mgr = new WorkspaceManager(tempRoot, hooks);
    const ws = await mgr.createForIssue('TEST-3');
    await access(join(ws.path, 'hook_ran.txt'), constants.F_OK);
  });

  it('does not run after_create on reuse', async () => {
    const hooks: HookScripts = {
      ...noHooks,
      afterCreate: 'touch hook_ran.txt',
    };
    const mgr = new WorkspaceManager(tempRoot, hooks);
    await mgr.createForIssue('TEST-4');
    // Remove the file to verify it doesn't get recreated
    await rm(join(tempRoot, 'TEST-4', 'hook_ran.txt'));
    const ws2 = await mgr.createForIssue('TEST-4');
    expect(ws2.createdNow).toBe(false);
    // hook_ran.txt should NOT exist since after_create doesn't run
    await expect(access(join(ws2.path, 'hook_ran.txt'), constants.F_OK)).rejects.toThrow();
  });

  it('removes workspace', async () => {
    const mgr = new WorkspaceManager(tempRoot, noHooks);
    await mgr.createForIssue('TEST-5');
    await mgr.removeWorkspace('TEST-5');
    await expect(access(join(tempRoot, 'TEST-5'), constants.F_OK)).rejects.toThrow();
  });

  it('sanitizes identifier in path', async () => {
    const mgr = new WorkspaceManager(tempRoot, noHooks);
    const ws = await mgr.createForIssue('AB/C D');
    expect(ws.workspaceKey).toBe('AB_C_D');
  });

  it('rejects path traversal', async () => {
    const mgr = new WorkspaceManager(tempRoot, noHooks);
    // Direct path traversal via crafted identifier won't work
    // because sanitizeIdentifier replaces / with _
    // but let's verify containment is enforced
    const ws = await mgr.createForIssue('../../etc');
    expect(ws.workspaceKey).toBe('.._.._etc');
    expect(ws.path.startsWith(tempRoot)).toBe(true);
  });
});
