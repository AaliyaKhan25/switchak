import { isConsoleDirectChatSummary } from '@renderer/features/switch-servers/room-filters';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { RemoteAgentRoom } from '@shared/core/switch-servers/switch-servers';

/**
 * An agent's conversations, in two lists that never share a room: its 1-1
 * chats made in Console (see `isConsoleDirectChat`), newest first, and every other room it is in, by name — a messaging-app DM and a
 * chat with several agents included, whether or not its membership lists it.
 */
export function agentConversations(
  agentChats: readonly ChatSummary[],
  agentRooms: readonly RemoteAgentRoom[]
): { direct: ChatSummary[]; rooms: Pick<RemoteAgentRoom, 'roomId' | 'roomName'>[] } {
  const direct = agentChats.filter(isConsoleDirectChatSummary);
  const directIds = new Set(direct.map((chat) => chat.roomId));
  const listed = agentRooms.filter((room) => !room.archived && !directIds.has(room.roomId));
  const listedIds = new Set(agentRooms.map((room) => room.roomId));
  const unlisted = agentChats
    .filter((chat) => !directIds.has(chat.roomId) && !listedIds.has(chat.roomId))
    .map((chat) => ({ roomId: chat.roomId, roomName: chat.name }));
  const rooms = [...listed, ...unlisted].sort((a, b) => a.roomName.localeCompare(b.roomName));
  return { direct, rooms };
}
