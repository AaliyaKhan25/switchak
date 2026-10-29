import { describe, expect, it, vi } from 'vitest';
import {
  ChatTimelines,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';
import { DirectChatStarter } from '@renderer/features/chats/stores/direct-chat-starter';
import type { ChatMessage, ChatSummary } from '@shared/core/chats/chats';

const chat = { roomId: 'r1', channelType: 'direct' } as ChatSummary;

/** The starter wired to real timelines, as the app wires it, over fake RPCs. */
function setup() {
  let id = 0;
  const api = {
    messages: vi.fn(async () => ({ messages: [], headSeq: 0, hasMore: false })),
    threadMessages: vi.fn(),
    upload: vi.fn(),
    send: vi.fn(
      async (roomId: string, input: { requestId: string; body: string }) =>
        [
          {
            roomId,
            seq: 1,
            messageId: 'm1',
            body: input.body,
            clientTxn: `${input.requestId}:0`,
          },
        ] as unknown as ChatMessage[]
    ),
    newId: () => `id-${++id}`,
  } satisfies Partial<TimelineApi>;
  const timelines = new ChatTimelines(() => api as unknown as TimelineApi);
  const create = vi.fn(async (_input: { requestId: string }): Promise<ChatSummary> => chat);
  const created = vi.fn((unsaved: { serverId: string; roomId: string }, made: ChatSummary) =>
    timelines.rekey(unsaved.serverId, unsaved.roomId, made.roomId)
  );
  const starter = new DirectChatStarter({
    create,
    opened: (unsaved: { serverId: string; roomId: string }, make: () => Promise<string>) => {
      if (!timelines.peek(unsaved.serverId, unsaved.roomId))
        timelines.unsaved(unsaved.serverId, unsaved.roomId, make);
    },
    created,
    newId: () => `req-${++id}`,
  });
  return { api, timelines, create, created, starter };
}

const message = (body: string) => ({
  body,
  threadRootId: null,
  mentionAgentIds: [],
  mentionUserIds: [],
  mentionSpans: [],
  files: [],
  requestId: null,
});

describe('DirectChatStarter', () => {
  it('opens a chat at once, asking the server for nothing until the first send', async () => {
    const { api, timelines, create, starter } = setup();
    const roomId = starter.start('s1', 'a1');
    const timeline = timelines.get('s1', roomId);
    expect(timeline.loaded).toBe(true);
    await timeline.load();
    expect(create).not.toHaveBeenCalled();
    expect(api.messages).not.toHaveBeenCalled();
    expect(timeline.messages).toEqual([]);
  });

  it('opens the same unsaved chat on every New chat before its first send, never another', () => {
    const { create, starter } = setup();
    const first = starter.start('s1', 'a1');
    expect(starter.start('s1', 'a1')).toBe(first);
    expect(starter.start('s1', 'a2')).not.toBe(first);
    expect(create).not.toHaveBeenCalled();
  });

  it('never reuses an existing chat, whatever it holds', () => {
    const { starter } = setup();
    expect(starter.start('s1', 'a1')).not.toBe(chat.roomId);
  });

  it('makes the room on the first send, then sends to it alone, under the same timeline', async () => {
    const { api, timelines, create, created, starter } = setup();
    const roomId = starter.start('s1', 'a1');
    const timeline = timelines.get('s1', roomId);
    timeline.send(message('hello'));
    expect(timeline.pending.map((send) => send.state)).toEqual(['sending']);
    await vi.waitFor(() => expect(timeline.messages).toHaveLength(1));
    expect(create).toHaveBeenCalledWith({
      serverId: 's1',
      agentIds: ['a1'],
      name: null,
      requestId: expect.stringMatching(/^req-/),
      greeting: null,
    });
    expect(created).toHaveBeenCalledOnce();
    expect(api.send).toHaveBeenCalledOnce();
    expect(api.send.mock.calls[0]![0]).toBe('r1');
    expect(timeline.roomId).toBe('r1');
    expect(timelines.get('s1', 'r1')).toBe(timeline);
    expect(timeline.pending).toEqual([]);
    expect(starter.unsavedChat(roomId)).toBeUndefined();
    // The next New chat is a new chat.
    expect(starter.start('s1', 'a1')).not.toBe(roomId);
  });

  it('makes one room for two sends made while it is being made', async () => {
    const { api, timelines, create, starter } = setup();
    const timeline = timelines.get('s1', starter.start('s1', 'a1'));
    timeline.send(message('one'));
    timeline.send(message('two'));
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledOnce();
    expect(api.send.mock.calls.map((call) => call[0])).toEqual(['r1', 'r1']);
  });

  it('keeps a message whose room could not be made, with its error, and retries under the same request id', async () => {
    const { api, timelines, create, starter } = setup();
    create.mockRejectedValueOnce(new Error('Switch cannot be reached right now.'));
    const roomId = starter.start('s1', 'a1');
    const timeline = timelines.get('s1', roomId);
    const requestId = timeline.send(message('hello'));
    await vi.waitFor(() => expect(timeline.pending[0]?.state).toBe('failed'));
    expect(timeline.pending[0]).toMatchObject({ body: 'hello', requestId });
    expect(timeline.pending[0]?.error).toContain('Switch cannot be reached');
    expect(api.send).not.toHaveBeenCalled();
    // Still the same unsaved chat: a New chat now opens it again rather than another.
    expect(starter.start('s1', 'a1')).toBe(roomId);

    timeline.retry(requestId);
    await vi.waitFor(() => expect(timeline.messages).toHaveLength(1));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].requestId).toBe(create.mock.calls[0]![0].requestId);
    expect(api.send).toHaveBeenCalledWith('r1', expect.objectContaining({ requestId }));
  });

  it('retries a first send that failed after its room was made into that room, under its own request id', async () => {
    const { api, timelines, create, starter } = setup();
    const send = api.send.getMockImplementation()!;
    api.send.mockRejectedValueOnce(new Error('The message was not sent.'));
    const timeline = timelines.get('s1', starter.start('s1', 'a1'));
    const requestId = timeline.send(message('hello'));
    await vi.waitFor(() => expect(timeline.pending[0]?.state).toBe('failed'));
    expect(timeline.pending[0]?.body).toBe('hello');
    expect(timeline.roomId).toBe('r1');

    api.send.mockImplementationOnce(send);
    timeline.retry(requestId);
    await vi.waitFor(() => expect(timeline.messages).toHaveLength(1));
    expect(create).toHaveBeenCalledOnce();
    expect(api.send.mock.calls.map((call) => [call[0], call[1].requestId])).toEqual([
      ['r1', requestId],
      ['r1', requestId],
    ]);
    expect(requestId).not.toBe(create.mock.calls[0]![0].requestId);
  });
});
