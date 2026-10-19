import { readFileSync } from 'node:fs';

/**
 * The server's own log, read back so a scenario fails when the server logged an
 * error while it ran, even if every assertion passed. A bug that logs and
 * carries on (an event loop catching one bad event) would otherwise pass every
 * scenario it breaks.
 *
 * Only a log the harness can read: the throwaway stack's `switch-core.log`,
 * written with `LOG_FORMAT=json` so each line is one record with a timestamp to
 * the millisecond. A deployed environment's log lives in its log backend, so
 * there the check is off and says so.
 *
 * Errors are found by time, not by request id: work a scenario sets off runs on
 * background tasks (a consumer delivering its message, a bridge relaying it)
 * that carry no request id. The id is attribution: each request the harness
 * sends carries `X-Request-Id: <scope tag>-<n>`, so an error logged while
 * serving one says which.
 */

export interface ServerLogError {
  timestamp: string;
  logger: string;
  message: string;
  /** The request it was logged while serving, or null for background work. */
  requestId: string | null;
}

/** How long after a scenario its background work may still log about it. */
export const SETTLE_MS = 1_500;

export class ServerLog {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Every record at error level or above logged in `[startMs, endMs]`. A line
   * that is not a JSON record is output that bypassed logging (a traceback
   * printed to stderr, say) and counts as an error, at the time of the record
   * before it.
   */
  errorsBetween(startMs: number, endMs: number): ServerLogError[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      throw new Error(
        `Cannot read the server log at ${this.path} (SWITCH_E2E_SERVER_LOG): ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    const errors: ServerLogError[] = [];
    let lastMs = Number.NEGATIVE_INFINITY;
    let lastTimestamp = '(before the first record)';
    let records = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const record = parseRecord(line);
      if (record === null) {
        if (lastMs >= startMs && lastMs <= endMs) {
          errors.push({
            timestamp: lastTimestamp,
            logger: '(unstructured output)',
            message: line.slice(0, 300),
            requestId: null,
          });
        }
        continue;
      }
      records += 1;
      lastMs = record.ms;
      lastTimestamp = record.timestamp;
      if (record.ms < startMs || record.ms > endMs) continue;
      if (record.status === 'error' || record.status === 'critical') {
        errors.push({
          timestamp: record.timestamp,
          logger: record.logger,
          message: record.message.slice(0, 500),
          requestId: record.requestId,
        });
      }
    }
    if (records === 0 && raw.trim() !== '') {
      throw new Error(
        `The server log at ${this.path} holds no JSON records: start the server ` +
          `with LOG_FORMAT=json for the harness to read it.`
      );
    }
    return errors;
  }
}

interface LogRecord {
  ms: number;
  timestamp: string;
  status: string;
  logger: string;
  message: string;
  requestId: string | null;
}

function parseRecord(line: string): LogRecord | null {
  if (!line.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as { [key: string]: unknown };
  const timestamp = typeof fields.timestamp === 'string' ? fields.timestamp : null;
  const ms = timestamp === null ? Number.NaN : Date.parse(timestamp);
  if (timestamp === null || Number.isNaN(ms)) return null;
  const logger = fields.logger as { name?: unknown } | undefined;
  return {
    ms,
    timestamp,
    status: typeof fields.status === 'string' ? fields.status : '',
    logger: typeof logger?.name === 'string' ? logger.name : '?',
    message: typeof fields.message === 'string' ? fields.message : '',
    requestId: typeof fields.request_id === 'string' ? fields.request_id : null,
  };
}

/** One line per error, saying whose request it came from. */
export function describeErrors(errors: readonly ServerLogError[], tag: string): string {
  return errors
    .map((error) => {
      const source =
        error.requestId === null
          ? 'background work'
          : error.requestId.startsWith(`${tag}-`)
            ? `this scenario's request ${error.requestId}`
            : `request ${error.requestId}`;
      return `${error.timestamp} [${error.logger}] ${error.message} (${source})`;
    })
    .join('\n  ');
}

/**
 * Watches one scenario: tags its requests, and on `finish` returns what the
 * server logged at error level while it ran, or null when there is no log to
 * read here.
 */
export class ScenarioObserver {
  readonly tag: string;
  private readonly log: ServerLog | null;
  private readonly client: { tagRequests(tag: string | null): void };
  private readonly startMs: number;

  constructor(
    serverLog: string | null,
    client: { tagRequests(tag: string | null): void },
    tag: string
  ) {
    this.tag = tag;
    this.log = serverLog === null ? null : new ServerLog(serverLog);
    this.client = client;
    this.startMs = Date.now();
    client.tagRequests(tag);
  }

  async finish(): Promise<ServerLogError[] | null> {
    this.client.tagRequests(null);
    if (this.log === null) return null;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    return this.log.errorsBetween(this.startMs, Date.now());
  }
}

/** What the run's log says about the no-error check, for the run header. */
export function describeServerLogCheck(serverLog: string | null): string {
  return serverLog === null
    ? 'server-log check off: SWITCH_E2E_SERVER_LOG is not set, so errors the server logs go unseen'
    : `server-log check on: ${serverLog}`;
}
