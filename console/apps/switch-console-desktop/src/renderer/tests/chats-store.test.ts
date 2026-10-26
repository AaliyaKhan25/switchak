import { describe, expect, it, vi } from 'vitest';
import { readThroughSeq } from '@renderer/features/chats/read-progress';
import type { TimelineApi } from '@renderer/features/chats/stores/chat-timeline-store';
import {
  ChatsStore,
  type ChatsApi,
  type ChatsEvents,
  READ_DEBOUNCE_MS,
} from '@renderer/features/chats/stores/chats-store';
import type { ChatMessage, ChatSummary } from '@shared/core/chats/chats';

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    refreshRoomState: vi.fn(async () => {}),
  },
}));

function summary(roomId: string, seq: number): ChatSummary {
  return {
    roomId,
    name: roomId,
    channelType: 'direct',
    bridgeType: null,
    channelName: null,
    agents: [
      {
        id: 'a1',
        name: 'ada',
        displayName: null,
        iconUrl: null,
        provider: null,
        alias: null,
        ownerName: null,
        ownedByViewer: false,
      },
    ],
    canManage: true,
    ownsAgent: false,
    memberUserIds: [],
    memberCount: 0,
    unreadCount: 0,
    lastMessage: { seq, sentAt: '2026-01-01T00:00:00Z', preview: 'hi', senderName: 'Ada' },
  };
}

function message(roomId: string, seq: number): ChatMessage {
  return {
    messageId: `m${seq}`,
    seq,
    roomId,
    sentAt: '2026-01-01T00:00:00Z',
    sender: { clientId: 'c', name: 'Ada', kind: 'human', agentId: null, userId: 'u' },
    source: 'console',
    body: `body ${seq}`,
    format: null,
    threadRootId: null,
    attachments: [],
    clientTxn: null,
    namedAgentIds: [],
    namedUserIds: [],
    mentions: [],
    threadReplyCount: 0,
    threadLastReplySeq: null,
  };
}

function setup(
  list: () => Promise<ChatSummary[]>,
  timeline: Partial<TimelineApi> = {},
  identity: ChatsApi['identity'] = async () => ({ userId: 'u', tenantId: 't' })
) {
  let onMessage: Parameters<ChatsEvents['onMessage']>[0] = () => {};
  let onState: Parameters<ChatsEvents['onState']>[0] = () => {};
  const events: ChatsEvents = {
    onMessage: (cb) => {
      onMessage = cb;
      return () => {};
    },
    onSummary: () => () => {},
    onRemoved: () => () => {},
    onState: (cb) => {
      onState = cb;
      return () => {};
    },
    onReset: () => () => {},
  };
  const api: ChatsApi = {
    connect: async () => ({ state: 'live', detail: null }),
    disconnect: vi.fn(async () => {}),
    list: vi.fn(list),
    identity,
    timeline: () => timeline as TimelineApi,
    archive: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}),
    removeMember: vi.fn(async () => {}),
  };
  const store = new ChatsStore(api, events);
  return {
    store,
    api,
    emit: (m: ChatMessage) => onMessage({ serverId: 's1', message: m }),
    live: () => onState({ serverId: 's1', state: 'live', detail: null }),
  };
}

describe('ChatsStore', () => {
  it('stops the feed of the server it no longer follows', async () => {
    const { store, api } = setup(async () => []);
    await store.connect('s1');
    expect(api.disconnect).not.toHaveBeenCalled();
    await store.connect('s2');
    expect(api.disconnect).toHaveBeenCalledWith('s1');
    await store.connect(null);
    expect(api.disconnect).toHaveBeenLastCalledWith('s2');
    expect(api.disconnect).toHaveBeenCalledTimes(2);
  });

  it('stops a feed that came up after the store moved on', async () => {
    const { store, api } = setup(async () => []);
    const pending = store.connect('s1');
    await store.connect(null);
    await pending;
    expect(api.disconnect).toHaveBeenNthCalledWith(1, 's1');
    expect(api.disconnect).toHaveBeenNthCalledWith(2, 's1');
  });

  it('brings a hidden chat back when a message arrives in it', async () => {
    let chats = [summary('r1', 1)];
    const { store, api, emit } = setup(async () => chats);
    await store.connect('s1');
    expect(store.chat('r2')).toBeUndefined();

    chats = [summary('r1', 1), summary('r2', 2)];
    emit(message('r2', 2));
    await vi.waitFor(() => expect(store.chat('r2')?.lastMessage?.seq).toBe(2));
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it.each(['archive', 'delete'] as const)(
    'drops a chat once the server agrees to %s it',
    async (op) => {
      const { store, api } = setup(async () => [summary('r1', 1), summary('r2', 1)]);
      await store.connect('s1');
      await store[op]('s1', 'r2');
      expect(api[op]).toHaveBeenCalledWith('s1', 'r2');
      expect(store.chat('r2')).toBeUndefined();
      expect(store.chat('r1')).toBeDefined();
    }
  );

  it.each(['archive', 'delete'] as const)('keeps a chat the server refuses to %s', async (op) => {
    const { store, api } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    vi.mocked(api[op]).mockRejectedValueOnce(new Error('Not authorized'));
    await expect(store[op]('s1', 'r1')).rejects.toThrow('Not authorized');
    expect(store.chat('r1')).toBeDefined();
  });

  it('does not relist for a room the person lost', async () => {
    const { store, api, emit } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    store.remove('r1', 'access');
    emit(message('r1', 2));
    await Promise.resolve();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(store.chat('r1')).toBeUndefined();
  });

  it('lets a chat be read again when access comes back', async () => {
    const { store } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    store.remove('r1', 'access');
    expect(timeline.accessLost).toBe(true);
    expect(store.removed.has('r1')).toBe(true);

    store.upsert(summary('r1', 2));
    expect(timeline.accessLost).toBe(false);
    expect(timeline.loaded).toBe(false);
  });

  it('keeps an unlisted chat usable: off the list, not lost', async () => {
    const messages = vi.fn(async () => ({
      messages: [message('r1', 1)],
      headSeq: 1,
      hasMore: false,
    }));
    const { store } = setup(async () => [summary('r1', 1)], { messages });
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    await timeline.load();

    store.remove('r1', 'unlisted');
    expect(store.chat('r1')).toBeUndefined();
    expect(store.removed.has('r1')).toBe(false);
    expect(timeline.accessLost).toBe(false);
    expect(timeline.messages.map((m) => m.seq)).toEqual([1]);
  });

  it('lists an unlisted chat again and catches its open timeline up', async () => {
    let page = [message('r1', 1)];
    const messages = vi.fn(async () => ({ messages: page, headSeq: page.length, hasMore: false }));
    const { store } = setup(async () => [summary('r1', 1)], { messages });
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    await timeline.load();
    store.remove('r1', 'unlisted');

    page = [message('r1', 1), message('r1', 2)];
    store.upsert(summary('r1', 2));
    expect(store.chat('r1')?.lastMessage?.seq).toBe(2);
    await vi.waitFor(() => expect(timeline.messages.map((m) => m.seq)).toEqual([1, 2]));
    expect(timeline.accessLost).toBe(false);
  });

  it('revokes a chat unlisted earlier once access is lost', async () => {
    const { store } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    store.remove('r1', 'unlisted');
    store.remove('r1', 'access');
    expect(timeline.accessLost).toBe(true);
    expect(store.removed.has('r1')).toBe(true);
    expect(store.unlisted.has('r1')).toBe(false);
  });

  it('does not relist for unlisted rooms', async () => {
    const { store, api, emit } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    store.remove('r1', 'unlisted');
    emit(message('r1', 2));
    await Promise.resolve();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(store.chat('r1')).toBeUndefined();
  });

  it('loads who the person is, their chats and a failed timeline once a feed down at start comes up', async () => {
    let up = false;
    const down = () => Promise.reject(new Error('Could not reach the server'));
    const { store, live } = setup(
      async () => (up ? [summary('r1', 1)] : down()),
      {
        messages: async () =>
          up ? { messages: [message('r1', 1)], headSeq: 1, hasMore: false } : down(),
      },
      async () => (up ? { userId: 'u', tenantId: 't' } : down())
    );
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    await timeline.load();
    expect(store.userId).toBeNull();
    expect(store.listError).not.toBeNull();
    expect(timeline.loadError).not.toBeNull();

    up = true;
    live();
    await vi.waitFor(() => expect(store.userId).toBe('u'));
    await vi.waitFor(() => expect(timeline.loaded).toBe(true));
    expect(store.chat('r1')?.name).toBe('r1');
    expect(store.listError).toBeNull();
    expect(timeline.loadError).toBeNull();
  });

  it('reads a chat once the person is let into it after a refused first load', async () => {
    const { store } = setup(async () => []);
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    timeline.notMember = true;

    store.upsert(summary('r1', 1));
    expect(timeline.notMember).toBe(false);
    expect(timeline.loaded).toBe(false);
  });
});

/** A viewer's store whose feed the test drives, already connected to `s1`. */
async function viewer() {
  let onSummary: Parameters<ChatsEvents['onSummary']>[0] = () => {};
  let onMessage: Parameters<ChatsEvents['onMessage']>[0] = () => {};
  const markRead = vi.fn(async () => {});
  const removeMember = vi.fn(async (_serverId: string, _roomId: string, _userId: string) => {});
  const events: ChatsEvents = {
    onMessage: (cb) => {
      onMessage = cb;
      return () => {};
    },
    onSummary: (cb) => {
      onSummary = cb;
      return () => {};
    },
    onRemoved: () => () => {},
    onState: () => () => {},
    onReset: () => () => {},
  };
  const group = { ...summary('g', 1), channelType: 'channel_private' as const };
  const store = new ChatsStore(
    {
      connect: async () => ({ state: 'live', detail: null }),
      disconnect: async () => {},
      list: async () => [group],
      identity: async () => ({ userId: 'u', tenantId: 't' }),
      timeline: () => ({}) as TimelineApi,
      archive: async () => {},
      delete: async () => {},
      markRead,
      removeMember,
    },
    events
  );
  await store.connect('s1');
  return {
    store,
    push: (chat: ChatSummary) => onSummary({ serverId: 's1', chat }),
    emit: (m: ChatMessage) => onMessage({ serverId: 's1', message: m }),
    markRead,
    removeMember,
    group,
  };
}

describe('ChatsStore membership', () => {
  it('keeps both of two quick agent removals and a feed update in between', async () => {
    const { store, push, group } = await viewer();
    const a = (id: string) => ({ ...group.agents[0], id });
    push({ ...group, agents: [a('a1'), a('a2'), a('a3')] });
    store.dropAgent('g', 'a1');
    push({ ...group, name: 'renamed', agents: [a('a2'), a('a3')] });
    store.dropAgent('g', 'a2');
    expect(store.chat('g')?.agents.map((agent) => agent.id)).toEqual(['a3']);
    expect(store.chat('g')?.name).toBe('renamed');
  });
});

describe('ChatsStore unread counts', () => {
  const from = (roomId: string, seq: number, userId: string) => ({
    ...message(roomId, seq),
    sender: { ...message(roomId, seq).sender, userId },
  });

  it('counts others’ new messages in rooms not being read, and takes the server’s count', async () => {
    const { store, emit, push, group } = await viewer();
    emit(from('g', 2, 'bob'));
    emit(from('g', 3, 'bob'));
    emit(from('g', 3, 'bob'));
    expect(store.unread('g')).toBe(2);
    emit(from('g', 4, 'u'));
    expect(store.unread('g')).toBe(2);
    store.setViewing('g');
    emit(from('g', 5, 'bob'));
    expect(store.unread('g')).toBe(0);
    store.setViewing(null);
    expect(store.unread('g')).toBe(2);
    push({ ...group, unreadCount: 7 });
    expect(store.unread('g')).toBe(7);
  });

  it('marks read at once here and sends the furthest position once, never backwards', async () => {
    vi.useFakeTimers();
    try {
      const { store, push, group, markRead } = await viewer();
      push({ ...group, unreadCount: 3 });
      store.read('g', 5);
      store.read('g', 9);
      expect(store.unread('g')).toBe(0);
      vi.advanceTimersByTime(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledTimes(1);
      expect(markRead).toHaveBeenCalledWith('s1', 'g', 9);
      store.read('g', 4);
      vi.advanceTimersByTime(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChatsStore leave', () => {
  it('removes the viewer and drops the chat from the list', async () => {
    const { store, removeMember } = await viewer();
    await store.leave('s1', 'g');
    expect(removeMember).toHaveBeenCalledWith('s1', 'g', 'u');
    expect(store.chat('g')).toBeUndefined();
    expect(store.removed.has('g')).toBe(true);
  });

  it('keeps the chat as it was when the server refuses', async () => {
    const { store, removeMember } = await viewer();
    removeMember.mockRejectedValueOnce(new Error('You own an agent in this chat.'));
    await expect(store.leave('s1', 'g')).rejects.toThrow('You own an agent in this chat.');
    expect(store.chat('g')).toBeDefined();
    expect(store.removed.has('g')).toBe(false);
  });
});

describe('ChatsStore read progress', () => {
  const from = (roomId: string, seq: number) => ({
    ...message(roomId, seq),
    sender: { ...message(roomId, seq).sender, userId: 'bob' },
  });

  it('counts arrivals while scrolled up, and reads them once back at the bottom', async () => {
    vi.useFakeTimers();
    try {
      const { store, emit, markRead } = await viewer();
      store.setViewing(null);
      emit(from('g', 2));
      expect(store.unread('g')).toBe(1);
      const seq = readThroughSeq({ shown: true, atBottom: false, lastSeq: 2 });
      expect(seq).toBeNull();
      store.setViewing('g');
      store.read('g', readThroughSeq({ shown: true, atBottom: true, lastSeq: 2 })!);
      expect(store.unread('g')).toBe(0);
      vi.advanceTimersByTime(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledWith('s1', 'g', 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries a failed read again the next time the same messages are shown', async () => {
    vi.useFakeTimers();
    try {
      const { store, markRead } = await viewer();
      markRead.mockRejectedValueOnce(new Error('offline'));
      store.read('g', 5);
      await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledTimes(1);
      store.read('g', 5);
      await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledTimes(2);
      store.read('g', 5);
      await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
