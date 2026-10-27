import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchManagedAgents: vi.fn(),
  deleteConsoleAgent: vi.fn(async () => {}),
  records: vi.fn(),
}));

vi.mock('@main/core/agent-migration/agent-migration', () => ({ agentMigrationService: {} }));
vi.mock('@main/core/agent-migration/managed-agents-store', () => ({
  listManagedAgentRecords: mocks.records,
}));
vi.mock('@main/core/agents/deleteAgent', () => ({ deleteAgent: mocks.deleteConsoleAgent }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/embedded-controller/embedded-controllers', () => ({
  embeddedControllerService: {},
}));
vi.mock('@main/core/host-controllers/host-controllers', () => ({ hostControllerService: {} }));
vi.mock('@main/core/workspaces/workspaces-store', () => ({
  requireWorkspaceForServer: async () => ({ id: 'ws' }),
}));
vi.mock('@main/core/workspaces/workspace-session', () => ({
  withReachableServerWorkspaceSession: (_serverId: string, run: (server: unknown) => unknown) =>
    run({ id: 'server-1', url: 'https://switch.example.com' }),
}));
vi.mock('@main/core/switch-servers/local-provider-sign-in', () => ({
  localProviderAuthPath: () => '',
  readLocalProviderSignIn: vi.fn(),
}));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  AgentManagementUnavailableError: class extends Error {},
  GatewayError: class extends Error {},
  deleteAgent: vi.fn(),
  deleteManagedAgent: vi.fn(),
  fetchAdvancedConfigSchema: vi.fn(),
  fetchManagedAgents: mocks.fetchManagedAgents,
  managementErrorMessage: vi.fn(),
  setManagedAgentDesiredState: vi.fn(),
  updateManagedAgent: vi.fn(),
  fetchManagementControllers: vi.fn(async () => []),
  giveMachineLogin: vi.fn(),
  fetchMachineOperation: vi.fn(),
}));

const { managedAgentsController } = await import('./controller');

const moved = (agentId: string, switchAgentId: string) => ({
  agentId,
  workspaceId: 'ws',
  controllerId: 'controller',
  placement: { kind: 'this-computer', serverId: 'server-1' },
  identities: [
    {
      switchAgentId,
      slug: agentId,
      subagent: null,
      credentialsStashed: false,
      controllerRoot: '~',
    },
  ],
  movedAt: '2026-01-01T00:00:00Z',
});

const listed = (agentId: string) => ({
  agentId,
  name: agentId,
  displayName: null,
  iconUrl: null,
  description: '',
  machine: null,
  controllerId: null,
  desiredState: 'running',
  revision: 1,
  provider: 'claude',
  model: null,
  advancedConfig: {},
  instructions: '',
  autoMode: false,
  autoApprove: false,
  directory: null,
  isolation: 'shared',
  status: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.records.mockResolvedValue([moved('console-gone', 'gone'), moved('console-kept', 'kept')]);
});

describe('listing managed agents', () => {
  it('forgets on load a moved agent deleted on the server, and only that one', async () => {
    mocks.fetchManagedAgents.mockResolvedValue([listed('kept')]);
    const agents = await managedAgentsController.list('server-1');
    expect(agents?.map((agent) => agent.agentId)).toEqual(['kept']);
    expect(mocks.deleteConsoleAgent).toHaveBeenCalledTimes(1);
    expect(mocks.deleteConsoleAgent).toHaveBeenCalledWith('console-gone', {
      deleteInSwitch: false,
      removeProvisionedFiles: false,
      trigger: 'server_teardown',
    });
  });

  it('forgets nothing when the list could not be read', async () => {
    mocks.fetchManagedAgents.mockRejectedValue(new Error('unreachable'));
    await expect(managedAgentsController.list('server-1')).rejects.toThrow('unreachable');
    expect(mocks.deleteConsoleAgent).not.toHaveBeenCalled();
  });
});
