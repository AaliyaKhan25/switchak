import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));

const { managedIdentities } = await import('./sidebar-tree-data');
const { queryClient } = await import('@renderer/lib/query-client');

describe('managedIdentities', () => {
  it('names the managed agents the list last read, so their rooms are reconciled too', () => {
    queryClient.setQueryData(
      ['managed-agents', 'srv', 'ws-a', 'user'],
      [{ agentId: 'buddy', workspaceId: 'ws-a' }]
    );
    queryClient.setQueryData(['managed-agents', 'srv-2', 'ws-b', 'user'], null);
    expect(managedIdentities()).toEqual([{ workspaceId: 'ws-a', switchAgentId: 'buddy' }]);
  });
});
