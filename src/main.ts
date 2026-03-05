import { resolve } from 'node:path';
import { access, constants, readdir, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { ConfigManager } from './config.js';
import { loadWorkflow } from './workflow-loader.js';
import { Orchestrator } from './orchestrator.js';
import { startServer } from './server.js';
import * as logger from './logger.js';
import type { AgentSDK } from './agent-runner.js';
import type { DashboardConfig } from './types.js';

function parseArgs(args: string[]): { workflowPath: string; port: number | null } {
  let workflowPath = './WORKFLOW.md';
  let port: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workflow' && i + 1 < args.length) {
      workflowPath = args[++i];
    } else if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    }
  }

  return { workflowPath: resolve(workflowPath), port };
}

async function cleanupOrphanedWorkspaces(
  workspaceRoot: string,
  activeIdentifiers: Set<string>,
): Promise<void> {
  try {
    await access(workspaceRoot, constants.F_OK);
  } catch {
    return; // root doesn't exist yet
  }

  try {
    const entries = await readdir(workspaceRoot);
    for (const entry of entries) {
      if (!activeIdentifiers.has(entry)) {
        logger.info(`Cleaning up orphaned workspace: ${entry}`);
        await rm(resolve(workspaceRoot, entry), { recursive: true, force: true });
      }
    }
  } catch (err) {
    logger.warn('Workspace cleanup scan failed', { error: String(err) });
  }
}

async function createSDK(): Promise<AgentSDK> {
  // Remove CLAUDECODE env var to allow SDK to spawn nested Claude Code processes
  delete process.env.CLAUDECODE;

  try {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    const realQuery = mod.query;
    // Wrap the SDK's standalone query() into our AgentSDK interface
    return {
      query(options) {
        return realQuery({
          prompt: options.prompt,
          options: {
            cwd: options.cwd,
            maxTurns: options.maxTurns,
            model: options.model,
            permissionMode: options.permissionMode as any,
            allowedTools: options.allowedTools,
            disallowedTools: options.disallowedTools,
            maxBudgetUsd: options.maxBudgetUsd,
            env: options.env,
            systemPrompt: options.systemPrompt,
            debug: true,
            stderr: (data: string) => {
              logger.warn(`[claude-sdk-stderr] ${data.trimEnd()}`);
            },
          },
        }) as any;
      },
    };
  } catch (err) {
    logger.warn(`Claude Agent SDK not available: ${err}. Using stub (development mode)`);
    return {
      async *query() {
        yield { type: 'result' as const, subtype: 'error' as const, error: 'SDK not installed' };
      },
    };
  }
}

function launchBeadboard(dashboardConfig: DashboardConfig): ChildProcess | null {
  if (!dashboardConfig.autoLaunch || dashboardConfig.externalUrl) {
    return null;
  }

  const port = String(dashboardConfig.port);

  // Try npx beadboard first, fall back to beadboard if installed globally
  const child = spawn('npx', ['beadboard', '--port', port], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, PORT: port },
  });

  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.info(`[beadboard] ${line}`);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.warn(`[beadboard] ${line}`);
  });

  child.on('error', (err) => {
    logger.warn(`Beadboard launch failed: ${err.message}. Dashboard will not be available.`);
  });

  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      logger.warn(`Beadboard exited with code ${code}`);
    }
  });

  logger.info(`Beadboard dashboard launching on http://localhost:${port}`);
  return child;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Warn if ANTHROPIC_API_KEY is not set (SDK may use Claude Code's own credentials)
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn('ANTHROPIC_API_KEY not set — SDK will use Claude Code built-in credentials');
  }

  // Load workflow
  const configManager = new ConfigManager(args.workflowPath);
  let config;
  try {
    config = await configManager.load();
  } catch (err) {
    logger.error(`Failed to load workflow: ${err}`);
    process.exit(1);
  }

  // Load prompt template
  const workflow = await loadWorkflow(args.workflowPath);

  // Validate tracker config (API key only required for Linear)
  if (config.tracker.kind === 'linear' && !config.tracker.apiKey) {
    logger.error('Tracker API key is required for Linear (set LINEAR_API_KEY or tracker.api_key)');
    process.exit(1);
  }

  // Create SDK
  const sdk = await createSDK();

  // Create orchestrator
  const orchestrator = new Orchestrator(config, workflow.promptTemplate, sdk);

  // Dynamic reload
  configManager.startWatching();
  configManager.on('config-reloaded', async (newConfig) => {
    logger.info('Config reloaded, updating orchestrator');
    const newWorkflow = await loadWorkflow(args.workflowPath);
    orchestrator.updateConfig(newConfig, newWorkflow.promptTemplate);
  });
  configManager.on('config-reload-error', (err) => {
    logger.warn('Config reload failed, keeping previous config', { error: String(err) });
  });

  // Startup workspace cleanup (must complete before orchestrator starts to avoid race conditions)
  try {
    await cleanupOrphanedWorkspaces(config.workspace.root, new Set());
  } catch (err) {
    logger.warn('Startup workspace cleanup failed', { error: String(err) });
  }

  // Optional HTTP server
  const serverPort = args.port ?? config.server.port;
  let server: ReturnType<typeof startServer> | null = null;
  if (serverPort !== null) {
    server = startServer(orchestrator, serverPort);
  }

  // Launch beadboard dashboard
  const beadboardProcess = launchBeadboard(config.dashboard);

  // Start orchestrator
  orchestrator.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    if (beadboardProcess && !beadboardProcess.killed) {
      beadboardProcess.kill('SIGTERM');
    }
    await orchestrator.stop();
    if (server) {
      server.close();
    }
    await configManager.stopWatching();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
