import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { ChatSummary } from '@shared/core/chats/chats';
import { chatsStore } from './stores/chats';

/**
 * The query for a chat's members, keyed on who the live summary says is in it,
 * so an add, a removal or a swap by anyone reads the list again.
 */
export function chatMembersQueryKey(serverId: string, chat: ChatSummary) {
  return ['chat-members', serverId, chat.roomId, chat.memberUserIds.join(',')] as const;
}

/** The workspace roster, the people a chat can hold; shared with Add participants. */
export function workspaceRosterQuery(serverId: string, tenantId: string | null) {
  return {
    queryKey: ['workspace-members', serverId, tenantId] as const,
    queryFn: () => rpc.chats.workspaceMembers({ serverId, tenantId: tenantId as string }),
    enabled: tenantId !== null,
  };
}

/** The other people in a chat, with their email from the roster when it has one. */
export function useChatPeople(
  serverId: string,
  chat: ChatSummary | undefined
): { userId: string; name: string; email: string | null }[] {
  const members = useQuery({
    queryKey: chat ? chatMembersQueryKey(serverId, chat) : ['chat-members', serverId, null],
    queryFn: () => rpc.chats.members(serverId, (chat as ChatSummary).roomId),
    enabled: chat !== undefined,
  });
  const roster = useQuery(workspaceRosterQuery(serverId, chatsStore.tenantId));
  const emails = new Map((roster.data ?? []).map((person) => [person.userId, person.email]));
  return (members.data ?? [])
    .filter((member) => member.userId !== chatsStore.userId)
    .map((member) => ({
      userId: member.userId,
      name: member.name,
      email: emails.get(member.userId) ?? null,
    }));
}
