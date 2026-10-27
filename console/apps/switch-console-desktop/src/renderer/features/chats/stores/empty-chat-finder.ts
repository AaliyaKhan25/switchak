import { isConsoleDirectChatSummary } from '@renderer/features/switch-servers/room-filters';
import type { ChatMessage, ChatSummary } from '@shared/core/chats/chats';

export type LoadedTimeline = {
  messages: ChatMessage[];
  loaded: boolean;
};

export type EmptyChatFinderDeps = {
  chatsOfAgent: (agentId: string) => ChatSummary[];
  userId: () => string | null;
  timeline: (roomId: string) => LoadedTimeline | undefined;
};

/**
 * Finds the most recent empty chat for an agent, where "empty" means the
 * current user has sent no messages. Agent greetings don't count as use.
 * Only the viewer's own 1:1 with that agent qualifies: a group, even one that
 * began as a direct chat, or a bridged room would carry a private message to
 * others.
 */
export class EmptyChatFinder {
  constructor(private readonly deps: EmptyChatFinderDeps) {}

  find(agentId: string): ChatSummary | null {
    const userId = this.deps.userId();
    if (!userId) return null;

    const chats = this.deps.chatsOfAgent(agentId);
    const empty = chats.filter(
      (chat) => isOwnDirectChat(chat, agentId, userId) && this.isEmpty(chat, userId)
    );
    return empty[0] ?? null;
  }

  private isEmpty(chat: ChatSummary, userId: string): boolean {
    const timeline = this.deps.timeline(chat.roomId);

    if (timeline?.loaded) {
      return timeline.messages.every((msg) => msg.sender.userId !== userId);
    }

    if (chat.lastMessage === null) return true;

    const lastMessageFromAgent = chat.agents.some(
      (agent) =>
        chat.lastMessage?.senderName === agent.name ||
        chat.lastMessage?.senderName === agent.displayName
    );

    return this.hasDefaultName(chat) && lastMessageFromAgent;
  }

  /** "New Chat" now; "New chat" and "Chat with <agents>" for chats made before. */
  private hasDefaultName(chat: ChatSummary): boolean {
    const agentNames = chat.agents.map((agent) => agent.displayName || agent.name).join(', ');
    return (
      chat.name === 'New Chat' ||
      chat.name === 'New chat' ||
      chat.name === `Chat with ${agentNames}`
    );
  }
}

/**
 * A Switch Console 1:1 between the viewer and this one agent: direct, unbridged,
 * that agent alone, and nobody else in it (where the server says who is).
 */
export function isOwnDirectChat(chat: ChatSummary, agentId: string, userId: string): boolean {
  return (
    isConsoleDirectChatSummary(chat) &&
    chat.agents[0]?.id === agentId &&
    chat.memberUserIds.every((member) => member === userId)
  );
}
