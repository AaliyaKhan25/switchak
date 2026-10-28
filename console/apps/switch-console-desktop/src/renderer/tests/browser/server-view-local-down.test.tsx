import type * as ReactQuery from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

// The home page of the server on this computer when it is not answering: a
// crash shows as the server being down, with Restart and the way to its status
// page, rather than as a connection problem.
const state = vi.hoisted(() => ({
  status: null as unknown,
  unreachable: false,
  localStart: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { serverId: 'local' } }),
  useNavigate: () => ({ navigate: state.navigate }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => () => {} }));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    get servers() {
      return [LOCAL];
    },
    serverById: () => LOCAL,
    statusFor: () => ({ connected: true }),
    refreshing: new Set(),
    isUnreachable: () => state.unreachable,
    isHostBlocked: () => false,
    refreshStatus: () => Promise.resolve(),
    ensureAuthConfig: () => Promise.resolve(),
    refreshServer: () => Promise.resolve(),
    retryConnection: () => Promise.resolve(),
    error: null,
    errorDetail: null,
  },
}));
vi.mock('@renderer/features/switch-servers/local-server-store', () => ({
  localServerStore: {
    get status() {
      return state.status;
    },
    get isRunning() {
      return (state.status as { phase: string }).phase === 'running';
    },
    busy: false,
    docker: null,
    isNative: true,
    message: null,
    start: (...args: unknown[]) => state.localStart(...args),
  },
}));
vi.mock('@renderer/features/remote-hosts/host-reachability-store', () => ({
  hostReachabilityStore: {
    hydrate: () => Promise.resolve(),
    get: () => null,
    isBlocked: () => false,
  },
}));
vi.mock('@renderer/features/remote-hosts/host-unreachable-panel', () => ({
  HostUnreachablePanel: () => null,
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { load: () => Promise.resolve() },
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { refreshRoomState: () => Promise.resolve() },
}));
vi.mock('@renderer/features/switch-servers/MessagingAppsCard', () => ({
  MessagingAppsCard: () => null,
}));
vi.mock('@renderer/features/switch-servers/GuardrailsSection', () => ({
  GuardrailsSection: () => null,
}));
vi.mock('@renderer/features/switch-servers/server-stat-tiles', () => ({
  ServerStatTiles: () => null,
}));
vi.mock('@renderer/features/switch-servers/server-sign-in', () => ({
  ServerSignInFields: () => null,
  useServerSignIn: () => ({}),
  machineUnavailableReason: () => null,
}));

import { serverView } from '@renderer/features/switch-servers/view';
import '@renderer/index.css';

const LOCAL = {
  id: 'local',
  name: 'Local server',
  url: 'http://localhost:41001',
  dashboardUrl: null,
  managed: true,
  managementKind: 'local' as const,
  sshHost: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const base = {
  checked: true,
  upgrade: null,
  drift: null,
  runtime: 'native',
  error: null,
  failedTo: null,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  state.status = { ...base, phase: 'running' };
  state.unreachable = false;
  state.localStart.mockReset();
  state.navigate.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render() {
  const Page = serverView.MainPanel;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Page />));
}

function button(label: RegExp): HTMLElement | undefined {
  return [...document.querySelectorAll('button')].find((b) =>
    label.test(b.textContent?.trim() ?? '')
  );
}

it('says the server stopped unexpectedly, and offers Restart and its status page', async () => {
  state.status = {
    ...base,
    phase: 'error',
    failedTo: 'run',
    error: 'switch-core stopped unexpectedly',
  };
  await render();

  expect(document.body.textContent).toContain('Local server stopped unexpectedly');
  expect(document.body.textContent).not.toContain('Check your connection');

  await act(async () => button(/^Restart$/)!.click());
  expect(state.localStart).toHaveBeenCalledOnce();
  await act(async () => button(/^Server status$/)!.click());
  expect(state.navigate).toHaveBeenCalledWith('managedServer', { serverId: 'local' });
});

it('offers Start for a server that was stopped', async () => {
  state.status = { ...base, phase: 'stopped' };
  await render();

  expect(document.body.textContent).toContain("Local server isn't running");
  expect(button(/^Start$/)).toBeDefined();
});

it('says nothing until the server has been looked at', async () => {
  state.status = { ...base, phase: 'stopped', checked: false };
  await render();

  expect(button(/^Start$/)).toBeUndefined();
  expect(button(/^Server status$/)).toBeUndefined();
});

it('does not blame the connection when the local server is not answering', async () => {
  state.unreachable = true;
  await render();

  expect(document.body.textContent).toContain("Local server isn't answering");
  expect(document.body.textContent).not.toContain('Check your connection');
  expect(button(/^Server status$/)).toBeDefined();
});
