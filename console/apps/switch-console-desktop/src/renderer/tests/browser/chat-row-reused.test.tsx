/** A chat New chat reused stands out in the list for a moment, so the click visibly did something. */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChatRow } from '@renderer/features/chats/components/chat-row';
import { REUSE_FLASH_MS, reuseFlash } from '@renderer/features/chats/stores/reuse-flash';
import type { ChatSummary } from '@shared/core/chats/chats';

const chat = {
  roomId: 'r1',
  name: 'New Chat',
  channelType: 'direct',
  bridgeType: null,
  channelName: null,
  agents: [],
  canManage: true,
  ownsAgent: true,
  memberUserIds: [],
  memberCount: 1,
  unreadCount: 0,
  lastMessage: null,
} as unknown as ChatSummary;

it('highlights the reused chat, then lets it go', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<ChatRow serverId="s" chat={chat} isActive onOpen={() => {}} />)
  );
  const row = () => container.querySelector('[data-reused]');
  expect(row()).toBeNull();

  await act(async () => reuseFlash.flash('r1'));
  expect(row()).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(REUSE_FLASH_MS + 10));
  expect(row()).toBeNull();

  vi.useRealTimers();
  await act(async () => root.unmount());
  container.remove();
});
