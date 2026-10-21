import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@shared/core/chats/chats';
import { ChatTimeline, type TimelineApi } from './chat-timeline-store';

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: 'msg-1',
  seq: 1,
  roomId: 'room-1',
  sentAt: '2024-01-01T00:00:00Z',
  sender: {
    clientId: 'client-1',
    name: 'User',
    kind: 'human',
    agentId: null,
    userId: 'user-1',
  },
  source: 'text',
  body: 'Test message',
  format: null,
  threadRootId: null,
  attachments: [],
  clientTxn: null,
  namedAgentIds: [],
  threadReplyCount: 0,
  threadLastReplySeq: null,
  ...overrides,
});

const makeApi = (): TimelineApi => ({
  messages: vi.fn().mockResolvedValue({ messages: [], headSeq: 0, hasMore: false }),
  threadMessages: vi.fn().mockResolvedValue([]),
  upload: vi.fn().mockResolvedValue({ uploadId: '', uri: '', filename: '', mimetype: '', size: 0 }),
  send: vi.fn().mockResolvedValue([]),
  newId: () => crypto.randomUUID(),
});

describe('ChatTimeline thread reply counts', () => {
  it('increments thread reply count when a reply arrives', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    const root = makeMessage({ messageId: 'root-1', seq: 1 });
    const reply = makeMessage({ messageId: 'reply-1', seq: 2, threadRootId: 'root-1' });

    timeline.apply(root);
    timeline.apply(reply);

    expect(timeline.threadReplyCount('root-1')).toBe(1);
  });

  it('tracks multiple replies to the same root', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    const root = makeMessage({ messageId: 'root-1', seq: 1 });
    const reply1 = makeMessage({ messageId: 'reply-1', seq: 2, threadRootId: 'root-1' });
    const reply2 = makeMessage({ messageId: 'reply-2', seq: 3, threadRootId: 'root-1' });

    timeline.apply(root);
    timeline.apply(reply1);
    timeline.apply(reply2);

    expect(timeline.threadReplyCount('root-1')).toBe(2);
  });

  it('tracks counts even if root is not loaded', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    const reply = makeMessage({ messageId: 'reply-1', seq: 2, threadRootId: 'unloaded-root' });

    timeline.apply(reply);

    expect(timeline.threadReplyCount('unloaded-root')).toBe(1);
  });

  it('prefers server threadReplyCount if root message has it', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    const root = makeMessage({ messageId: 'root-1', seq: 1, threadReplyCount: 5 });

    timeline.apply(root);

    expect(timeline.threadReplyCount('root-1')).toBe(5);
  });

  it('returns 0 for a root with no replies', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    expect(timeline.threadReplyCount('nonexistent-root')).toBe(0);
  });

  it('calls threadMessages API when loading a thread', async () => {
    const api = makeApi();
    const timeline = new ChatTimeline('room-1', api);

    await timeline.loadThread('root-1');

    expect(api.threadMessages).toHaveBeenCalledWith('room-1', 'root-1', null, 50);
  });

  it('calls threadMessages with beforeSeq for pagination', async () => {
    const api = makeApi();
    const timeline = new ChatTimeline('room-1', api);

    await timeline.loadThread('root-1', 100);

    expect(api.threadMessages).toHaveBeenCalledWith('room-1', 'root-1', 100, 50);
  });
});
