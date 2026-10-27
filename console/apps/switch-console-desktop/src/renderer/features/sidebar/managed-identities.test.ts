import { beforeEach, describe, expect, it, vi } from 'vitest';

const servers = vi.hoisted(() => ({
  servers: [{ id: 'srv' }],
  user: 'user-1' as string | null,
}));

vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    get servers() {
      return servers.servers;
    },
    statusFor: () => (servers.user ? { user: { id: servers.user } } : null),
  },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => 'ws-a' },
}));

const { managedIdentities } = await import('./sidebar-tree-data');
const { queryClient } = await import('@renderer/lib/query-client');

describe('managedIdentities', () => {
  beforeEach(() => {
    queryClient.clear();
    servers.user = 'user-1';
  });

  it('reads the current user’s agent list only, not machines kept under the same prefix', () => {
    queryClient.setQueryData(
      ['managed-agents', 'srv', 'ws-a', 'user-1'],
      [{ agentId: 'buddy', workspaceId: 'ws-a' }, { agentId: 'buddy', workspaceId: 'ws-a' }, {}]
    );
    queryClient.setQueryData(['managed-agents', 'srv', 'machines', 'ws-a'], [{ machine_id: 'm1' }]);
    expect(managedIdentities()).toEqual([{ workspaceId: 'ws-a', switchAgentId: 'buddy' }]);
  });

  it('leaves another account’s list alone after switching accounts', () => {
    queryClient.setQueryData(
      ['managed-agents', 'srv', 'ws-a', 'user-1'],
      [{ agentId: 'old-users-agent', workspaceId: 'ws-a' }]
    );
    servers.user = 'user-2';
    expect(managedIdentities()).toEqual([]);
    queryClient.setQueryData(
      ['managed-agents', 'srv', 'ws-a', 'user-2'],
      [{ agentId: 'mine', workspaceId: 'ws-a' }]
    );
    expect(managedIdentities()).toEqual([{ workspaceId: 'ws-a', switchAgentId: 'mine' }]);
  });
});
