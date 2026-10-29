import type { ChatSummary } from '@shared/core/chats/chats';

/** Prefix of the id a direct chat goes by on screen until its room exists. */
export const UNSAVED_CHAT_PREFIX = 'unsaved-chat:';

/** What an unsaved chat is called: the name the server gives a chat made without one. */
export const UNSAVED_CHAT_NAME = 'New Chat';

export type UnsavedChat = {
  serverId: string;
  agentId: string;
  /** The id it goes by on screen until its room exists. */
  roomId: string;
  /** One per unsaved chat: every attempt to make its room is the same request, so the server makes one room. */
  requestId: string;
};

export type DirectChatStarterDeps = {
  create: (input: {
    serverId: string;
    agentIds: string[];
    name: null;
    requestId: string;
    greeting: null;
  }) => Promise<ChatSummary>;
  /** The unsaved chat is being opened, new or again; `create` makes its room, on its first send. */
  opened: (chat: UnsavedChat, create: () => Promise<string>) => void;
  /** Its room exists: the chat moves from its unsaved id to the room's. */
  created: (unsaved: UnsavedChat, chat: ChatSummary) => void;
  newId: () => string;
};

/**
 * Starts an unnamed direct chat with one agent. Nothing is asked of the server
 * until the first message: the chat opens at once under an unsaved id, and its
 * room is made as that message is sent. Starting again for the same agent
 * before then opens the same unsaved chat, with whatever was typed in it.
 */
export class DirectChatStarter {
  private readonly unsaved = new Map<string, UnsavedChat>();
  private readonly byRoomId = new Map<string, UnsavedChat>();
  private readonly creating = new Map<string, Promise<string>>();

  constructor(private readonly deps: DirectChatStarterDeps) {}

  /** The id of the chat to open: the agent's unsaved one, made now if it has none. */
  start(serverId: string, agentId: string): string {
    const key = `${serverId}:${agentId}`;
    let chat = this.unsaved.get(key);
    if (!chat) {
      const requestId = this.deps.newId();
      chat = { serverId, agentId, roomId: `${UNSAVED_CHAT_PREFIX}${requestId}`, requestId };
      this.unsaved.set(key, chat);
      this.byRoomId.set(chat.roomId, chat);
    }
    const opened = chat;
    this.deps.opened(opened, () => this.create(opened));
    return chat.roomId;
  }

  /** The unsaved chat shown under `roomId`, while its room does not exist yet. */
  unsavedChat(roomId: string): UnsavedChat | undefined {
    return this.byRoomId.get(roomId);
  }

  /** Make the chat's room, once however often asked; a failure lets the next ask try again under the same request id. */
  private create(chat: UnsavedChat): Promise<string> {
    let creating = this.creating.get(chat.roomId);
    if (!creating) {
      creating = this.deps
        .create({
          serverId: chat.serverId,
          agentIds: [chat.agentId],
          name: null,
          requestId: chat.requestId,
          greeting: null,
        })
        .then(
          (created) => {
            this.unsaved.delete(`${chat.serverId}:${chat.agentId}`);
            this.byRoomId.delete(chat.roomId);
            this.deps.created(chat, created);
            return created.roomId;
          },
          (error: unknown) => {
            this.creating.delete(chat.roomId);
            throw error;
          }
        );
      this.creating.set(chat.roomId, creating);
    }
    return creating;
  }
}
