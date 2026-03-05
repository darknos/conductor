import { resolve } from 'node:path';
import { access, constants, readdir, rm } from 'node:fs/promises';
import { ConfigManager } from './config.js';
import { loadWorkflow } from './workflow-loader.js';
import { Orchestrator } from './orchestrator.js';
import { startServer } from './server.js';
import * as logger from './logger.js';
import type { AgentSDK } from './agent-runner.js';

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
  // Dynamic import of Claude Agent SDK
  try {
    // @ts-expect-error — SDK may not be installed at build time
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    return mod.default ?? mod;
  } catch {
    logger.warn('Claude Agent SDK not installed, using stub (development mode)');
    return {
      async *query() {
        yield { type: 'result' as const, subtype: 'error' as const, error: 'SDK not installed' };
      },
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Validate ANTHROPIC_API_KEY
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.error('ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
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

  // Validate tracker config
  if (!config.tracker.apiKey) {
    logger.error('Tracker API key is required (set LINEAR_API_KEY or tracker.api_key)');
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

  // Startup workspace cleanup
  // Fetch active issues to determine which workspaces are still needed
  // (best-effort, don't block startup)
  cleanupOrphanedWorkspaces(config.workspace.root, new Set()).catch((err) => {
    logger.warn('Startup workspace cleanup failed', { error: String(err) });
  });

  // Optional HTTP server
  const serverPort = args.port ?? config.server.port;
  let server: ReturnType<typeof startServer> | null = null;
  if (serverPort !== null) {
    server = startServer(orchestrator, serverPort);
  }

  // Start orchestrator
  orchestrator.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
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
