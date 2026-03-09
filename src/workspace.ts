import { mkdir, rm, access, constants } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import type { Workspace, HookScripts } from './types.js';
import * as logger from './logger.js';

export function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

function ensureContainment(workspacePath: string, root: string): void {
  const resolved = resolve(workspacePath);
  const resolvedRoot = resolve(root);
  if (!resolved.startsWith(resolvedRoot + '/') && resolved !== resolvedRoot) {
    throw new Error(`Workspace path ${resolved} escapes root ${resolvedRoot}`);
  }
}

export class WorkspaceManager {
  private root: string;
  private hooks: HookScripts;

  constructor(root: string, hooks: HookScripts) {
    this.root = resolve(root);
    this.hooks = hooks;
  }

  updateConfig(root: string, hooks: HookScripts): void {
    this.root = resolve(root);
    this.hooks = hooks;
  }

  async createForIssue(identifier: string): Promise<Workspace> {
    const key = sanitizeIdentifier(identifier);
    const wsPath = join(this.root, key);
    ensureContainment(wsPath, this.root);

    let createdNow = false;
    try {
      await access(wsPath, constants.F_OK);
    } catch {
      await mkdir(wsPath, { recursive: true });
      createdNow = true;
    }

    const workspace: Workspace = { path: wsPath, workspaceKey: key, createdNow };

    if (createdNow && this.hooks.afterCreate) {
      await this.runHook('after_create', this.hooks.afterCreate, wsPath);
    }

    return workspace;
  }

  async removeWorkspace(identifier: string): Promise<void> {
    const key = sanitizeIdentifier(identifier);
    const wsPath = join(this.root, key);
    ensureContainment(wsPath, this.root);

    if (this.hooks.beforeRemove) {
      try {
        await this.runHook('before_remove', this.hooks.beforeRemove, wsPath);
      } catch (err) {
        logger.warn(`before_remove hook failed for ${identifier}`, {
          issueIdentifier: identifier,
          error: String(err),
        });
      }
    }

    await rm(wsPath, { recursive: true, force: true });
    logger.info(`Removed workspace for ${identifier}`, { issueIdentifier: identifier });
  }

  async runHook(hookType: string, script: string, workspacePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = execFile('sh', ['-c', script], {
        cwd: workspacePath,
        timeout: this.hooks.timeoutMs,
        env: { ...process.env },
      }, (error, stdout, stderr) => {
        if (error) {
          logger.error(`Hook ${hookType} failed`, {
            hookType,
            error: error.message,
            stdout: stdout?.slice(0, 500),
            stderr: stderr?.slice(0, 500),
          });
          reject(new Error(`Hook ${hookType} failed: ${error.message}`));
          return;
        }
        if (stdout) logger.debug(`Hook ${hookType} stdout: ${stdout.slice(0, 500)}`, { hookType });
        resolve();
      });
    });
  }

  getRoot(): string {
    return this.root;
  }

  getWorkspacePath(identifier: string): string {
    const key = sanitizeIdentifier(identifier);
    return join(this.root, key);
  }
}
