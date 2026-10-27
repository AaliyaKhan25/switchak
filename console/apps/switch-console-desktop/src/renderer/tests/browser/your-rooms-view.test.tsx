import { observable, runInAction } from 'mobx';
/**
 * Your Rooms lists the rooms the sidebar lists. Someone who can read more (an
 * admin, or public rooms) can switch to All rooms, which never offers a Switch
 * Console chat they are not in: the server would not open it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const rooms = vi.hoisted(() => ({ list: null as unknown as { all: RemoteRoomSummary[] } }));

vi.mock('@renderer/lib/ipc', () => ({ events: { on: () => () => {} }, rpc: {} }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: { serverId: 'srv' } }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => () => {} }));
vi.mock('@renderer/features/sidebar/sidebar-tree-data', () => ({
  refreshSidebarRoomState: async () => {},
  refreshSidebarRoomStateAfterOnboarding: async () => {},
}));
vi.mock('@renderer/features/switch-rooms/open-room', () => ({ openRoom: async () => {} }));
vi.mock('@renderer/features/chats/components/unread-badge', () => ({ UnreadBadge: () => null }));
// The chats the user is in, as GET /gateway/chats lists them.
vi.mock('@renderer/features/chats/stores/chats', async () => {
  const { observable } = await import('mobx');
  return {
    chatsStore: observable({
      serverId: 'srv',
      chats: new Map<string, unknown>(),
      unlisted: new Set<string>(),
    }),
  };
});
vi.mock('@renderer/lib/stores/use-workspace-agents', () => ({
  useWorkspaceAgents: () => ({ data: [] }),
}));
vi.mock('@renderer/features/locations/stores/agents-store', () => ({
  agentsStore: { agentsOnServer: () => [] },
}));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ agent_chats: true, group_chats: true }),
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    idOnServerInScope: () => 'ws',
    serverIdFor: () => 'srv',
    activeId: 'ws',
  },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { servers: [{ id: 'srv', name: 'Server' }] },
}));
// The store's own rule for "yours": owned, a member, or an agent of yours inside.
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    workspacesNotSignedIn: [],
    workspacesThatFailedToLoad: [],
    localMemberIds: () => [],
    listedRoomsInWorkspace: () =>
      rooms.list.all.filter((room) => room.ownerId === 'me' || room.viewerIsMember),
    readableRoomsInWorkspace: () => rooms.list.all,
  },
}));

import { chatsStore } from '@renderer/features/chats/stores/chats';
import { serverRoomsView } from '@renderer/features/switch-servers/server-rooms-view';

function room(id: string, extra: Partial<RemoteRoomSummary>): RemoteRoomSummary {
  return {
    id,
    name: id,
    description: '',
    channelType: 'group',
    agentCount: 2,
    bridgeDisplayName: null,
    bridgeType: null,
    externalChannelUrl: null,
    ownerId: 'bob',
    viewerIsMember: false,
    archived: false,
    createdAt: '',
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

function chat(id: string) {
  return {
    roomId: id,
    name: id,
    channelType: 'channel_private',
    bridgeType: null,
    agents: [{ id: 'a1' }, { id: 'a2' }],
    lastMessage: null,
  };
}

beforeEach(() => {
  rooms.list = observable({
    all: [
      room('bobs-chat', { viewerIsMember: true, channelType: 'channel_private' }),
      // The room list says "member" because the user's agent is in it; the user is not.
      room('agent-only-chat', { viewerIsMember: true, channelType: 'channel_private' }),
      room('strangers-chat', { channelType: 'channel_private' }),
      room('public-room', { channelType: 'channel_public' }),
      room('public-slack', { bridgeType: 'slack', bridgeDisplayName: 'Slack' }),
    ],
  });
  runInAction(() => {
    chatsStore.chats.clear();
    chatsStore.chats.set('bobs-chat', chat('bobs-chat') as never);
  });
});

const removeFromBobsChat = () =>
  act(async () =>
    runInAction(() => {
      chatsStore.chats.delete('bobs-chat');
      rooms.list.all[0].viewerIsMember = false;
    })
  );

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const Panel = serverRoomsView.MainPanel;
  await act(async () => root.render(<Panel />));
}

const names = () =>
  [...container.querySelectorAll('button.group\\/room span.truncate')].map((s) => s.textContent);
const toggle = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label);

it('lists your rooms by default, and drops a chat once you are removed from it', async () => {
  await render();
  expect(names()).toEqual(['bobs-chat']);
  await removeFromBobsChat();
  expect(names()).toEqual([]);
});

it('offers All rooms to someone who can read more: bridged rooms, never chats they are not in', async () => {
  await render();
  await act(async () => toggle('All rooms')!.click());
  expect(names()).toEqual(['#public-slack', 'bobs-chat', 'public-room']);
  await removeFromBobsChat();
  expect(names()).toEqual(['#public-slack', 'public-room']);
});

it('offers no choice to someone who can read only their own rooms', async () => {
  rooms.list.all = [room('bobs-chat', { viewerIsMember: true, channelType: 'channel_private' })];
  await render();
  expect(toggle('All rooms')).toBeUndefined();
});
