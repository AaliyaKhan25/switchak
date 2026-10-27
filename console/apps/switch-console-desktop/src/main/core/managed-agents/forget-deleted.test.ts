import { describe, expect, it, vi } from 'vitest';
import type { ManagedAgentRecord } from '@main/core/agent-migration/managed-agents-store';
import { forgetDeletedManagedAgents, RECENT_MOVE_GRACE_MS } from './forget-deleted';

const NOW = Date.parse('2026-10-27T12:00:00Z');

const record = (
  agentId: string,
  switchAgentId: string,
  movedAgoMs: number,
  workspaceId = 'ws'
): ManagedAgentRecord => ({
  agentId,
  workspaceId,
  controllerId: 'controller',
  placement: { kind: 'this-computer', serverId: 'srv' },
  identities: [
    {
      switchAgentId,
      slug: agentId,
      subagent: null,
      credentialsStashed: false,
      controllerRoot: '~/agents',
    },
  ],
  movedAt: new Date(NOW - movedAgoMs).toISOString(),
});

function deps(records: ManagedAgentRecord[]) {
  return {
    records: async () => records,
    forget: vi.fn(async () => {}),
    warn: vi.fn(),
    now: () => NOW,
  };
}

describe('forgetDeletedManagedAgents', () => {
  it('forgets a moved agent the server no longer lists, and keeps the listed ones', async () => {
    const calls = deps([
      record('console-gone', 'switch-gone', 60 * 60_000),
      record('console-kept', 'switch-kept', 60 * 60_000),
    ]);
    await forgetDeletedManagedAgents('ws', new Set(['switch-kept']), calls);
    expect(calls.forget).toHaveBeenCalledTimes(1);
    expect(calls.forget).toHaveBeenCalledWith('console-gone');
  });

  it('leaves another workspace’s agents and one moved moments ago', async () => {
    const calls = deps([
      record('other-ws', 'switch-a', 60 * 60_000, 'ws-2'),
      record('just-moved', 'switch-b', RECENT_MOVE_GRACE_MS / 2),
    ]);
    await forgetDeletedManagedAgents('ws', new Set(), calls);
    expect(calls.forget).not.toHaveBeenCalled();
  });

  it('logs one that cannot be forgotten and goes on with the rest', async () => {
    const calls = deps([
      record('a', 'switch-a', 60 * 60_000),
      record('b', 'switch-b', 60 * 60_000),
    ]);
    calls.forget.mockRejectedValueOnce(new Error('locked'));
    await forgetDeletedManagedAgents('ws', new Set(), calls);
    expect(calls.forget).toHaveBeenCalledTimes(2);
    expect(calls.warn).toHaveBeenCalledOnce();
  });
});
