export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  issueId?: string;
  issueIdentifier?: string;
  sessionId?: string;
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

function formatEntry(level: LogLevel, message: string, context?: LogContext): string {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };
  return JSON.stringify(entry);
}

export function debug(message: string, context?: LogContext): void {
  if (shouldLog('debug')) process.stderr.write(formatEntry('debug', message, context) + '\n');
}

export function info(message: string, context?: LogContext): void {
  if (shouldLog('info')) process.stderr.write(formatEntry('info', message, context) + '\n');
}

export function warn(message: string, context?: LogContext): void {
  if (shouldLog('warn')) process.stderr.write(formatEntry('warn', message, context) + '\n');
}

export function error(message: string, context?: LogContext): void {
  if (shouldLog('error')) process.stderr.write(formatEntry('error', message, context) + '\n');
}
