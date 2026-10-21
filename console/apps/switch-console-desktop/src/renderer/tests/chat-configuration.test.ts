import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  chatMembersQueryKey,
  RoomConfigurationPanel,
} from '@renderer/features/switch-rooms/room-configuration-panel';
import type { ChatSummary } from '@shared/core/chats/chats';

const chat = vi.hoisted(() => ({ current: null as ChatSummary | null }));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('@renderer/features/chats/stores/chats', () => ({
  chatsStore: {
    serverId: 's',
    removed: new Set(),
    chat: () => chat.current ?? undefined,
    add: vi.fn(),
  },
}));

const agent = {
  id: 'agent-1',
  name: 'helper',
  displayName: 'Helper',
  iconUrl: null,
  provider: null,
  alias: null,
  ownerName: null,
  ownedByViewer: false,
};

function render(canManage: boolean): string {
  chat.current = {
    roomId: 'r',
    name: 'Planning',
    channelType: 'channel_private',
    bridgeType: null,
    channelName: null,
    agents: [agent],
    canManage,
    ownsAgent: false,
    memberUserIds: ['u1', 'u2'],
    memberCount: 2,
    lastMessage: null,
  };
  const client = new QueryClient();
  client.setQueryData(chatMembersQueryKey('s', chat.current), [
    { userId: 'u1', name: 'Alice', isOwner: true },
    { userId: 'u2', name: 'Bob', isOwner: false },
  ]);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RoomConfigurationPanel, { roomId: 'r' })
    )
  );
}

describe('RoomConfigurationPanel for a group chat', () => {
  it('lists the chat’s agents and people, with add and remove for a manager', () => {
    const html = render(true);
    expect(html).toContain('Planning');
    expect(html).toContain('Helper');
    expect(html).toContain('1 agent · 2 people');
    expect(html).toContain('Add agent');
    expect(html).toContain('Add person');
    expect(html).not.toContain('From a template');
    expect(html).toContain('aria-label="Remove Helper"');
    expect(html).toContain('aria-label="Remove Bob"');
    expect(html).not.toContain('aria-label="Remove Alice"');
  });

  it('shows the participants without controls to someone who cannot manage', () => {
    const html = render(false);
    expect(html).toContain('Bob');
    expect(html).not.toContain('Add agent');
    expect(html).not.toContain('Add person');
    expect(html).not.toContain('aria-label="Remove');
  });
});

describe('chatMembersQueryKey', () => {
  it('reads the members again on an add, a removal or a swap, not on a new message', () => {
    render(true);
    const base = chat.current!;
    const key = (memberUserIds: string[], extra: Partial<ChatSummary> = {}) =>
      chatMembersQueryKey('s', {
        ...base,
        memberUserIds,
        memberCount: memberUserIds.length,
        ...extra,
      });
    const now = key(['u1', 'u2']);
    expect(key(['u1', 'u2', 'u3'])).not.toEqual(now);
    expect(key(['u1'])).not.toEqual(now);
    expect(key(['u1', 'u3'])).not.toEqual(now);
    expect(
      key(['u1', 'u2'], { lastMessage: { seq: 9, sentAt: '', preview: 'hi', senderName: 'Bob' } })
    ).toEqual(now);
  });
});
