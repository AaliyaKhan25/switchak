import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeErrors, ServerLog } from './server-log.ts';

const dirs: string[] = [];

function logWith(lines: string[]): ServerLog {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-server-log-'));
  dirs.push(dir);
  const file = path.join(dir, 'switch-core.log');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return new ServerLog(file);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(timestamp: string, status: string, message: string, requestId?: string): string {
  return JSON.stringify({
    timestamp,
    status,
    message,
    logger: { name: 'switch_core.test' },
    ...(requestId ? { request_id: requestId } : {}),
  });
}

const at = (iso: string): number => Date.parse(iso);

describe('server log', () => {
  it('returns the errors logged inside the window, and nothing at lower levels or outside it', () => {
    const log = logWith([
      record('2026-10-19T10:00:00.000+00:00', 'error', 'before the scenario'),
      record('2026-10-19T10:00:01.000+00:00', 'info', 'ordinary'),
      record('2026-10-19T10:00:01.500+00:00', 'warning', 'degraded'),
      record('2026-10-19T10:00:02.000+00:00', 'error', 'delivery failed', 'e2e-abc123a-3'),
      record('2026-10-19T10:00:02.500+00:00', 'critical', 'loop died'),
      record('2026-10-19T10:00:09.000+00:00', 'error', 'after the scenario'),
    ]);
    const errors = log.errorsBetween(at('2026-10-19T10:00:01Z'), at('2026-10-19T10:00:03Z'));
    expect(errors.map((error) => error.message)).toEqual(['delivery failed', 'loop died']);
    expect(describeErrors(errors, 'e2e-abc123a')).toContain(
      "this scenario's request e2e-abc123a-3"
    );
    expect(describeErrors(errors, 'e2e-abc123a')).toContain('loop died (background work)');
  });

  it('counts output that bypassed logging as an error, at the time of the record before it', () => {
    const log = logWith([
      record('2026-10-19T10:00:02.000+00:00', 'info', 'serving'),
      'Traceback (most recent call last):',
      record('2026-10-19T10:00:09.000+00:00', 'info', 'later'),
    ]);
    const errors = log.errorsBetween(at('2026-10-19T10:00:01Z'), at('2026-10-19T10:00:03Z'));
    expect(errors).toEqual([
      {
        timestamp: '2026-10-19T10:00:02.000+00:00',
        logger: '(unstructured output)',
        message: 'Traceback (most recent call last):',
        requestId: null,
      },
    ]);
  });

  it('refuses a log that is not JSON, rather than finding no errors in it', () => {
    const log = logWith(['2026-10-19T10:00:02 ERROR [switch_core] text format']);
    expect(() => log.errorsBetween(0, Date.now())).toThrow(/LOG_FORMAT=json/);
  });

  it('refuses a log it cannot read', () => {
    expect(() => new ServerLog('/nonexistent/switch-core.log').errorsBetween(0, 1)).toThrow(
      /Cannot read the server log/
    );
  });
});
