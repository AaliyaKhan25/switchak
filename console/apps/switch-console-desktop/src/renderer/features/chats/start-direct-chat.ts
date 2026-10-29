import { runInAction } from 'mobx';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { focusComposerWhenOpened } from './components/chat-composer';
import { chatDraftKey, moveChatDraft } from './stores/chat-drafts';
import { chatsStore, chatTitler } from './stores/chats';
import { DirectChatStarter } from './stores/direct-chat-starter';

/** Starts a direct chat with one agent, made on its first message and named from it. */
export const directChats = new DirectChatStarter({
  create: (input) => rpc.chats.create(input),
  opened: (chat, create) => {
    if (!chatsStore.timelines.peek(chat.serverId, chat.roomId))
      chatsStore.timelines.unsaved(chat.serverId, chat.roomId, create);
    focusComposerWhenOpened(chat.roomId);
  },
  created: ({ serverId, roomId: from }, chat) => {
    const draftKey = (roomId: string) =>
      chatDraftKey({
        serverId,
        userId: switchServersStore.statusFor(serverId)?.user?.id ?? null,
        workspaceId: workspacesStore.idOnServerInScope(serverId),
        roomId,
      });
    moveChatDraft(draftKey(from), draftKey(chat.roomId));
    if (document.activeElement?.closest('[data-chat-panel]')) focusComposerWhenOpened(chat.roomId);
    runInAction(() => {
      chatsStore.timelines.rekey(serverId, from, chat.roomId);
      chatsStore.add(serverId, chat);
      for (const entry of appState.history.entries)
        if (entry.kind === 'view' && (entry.params as { roomId?: string }).roomId === from)
          entry.params = { ...entry.params, roomId: chat.roomId };
      for (const viewId of ['chat', 'managedAgent'] as const)
        if (appState.navigation.viewParamsStore[viewId]?.roomId === from)
          appState.navigation.updateViewParams(viewId, { roomId: chat.roomId });
    });
    chatTitler.created(chat, false);
    const first = chatsStore.timelines.peek(serverId, chat.roomId)?.pending[0];
    if (first) void chatTitler.sent(serverId, chat.roomId, first.body);
  },
  newId: () => crypto.randomUUID(),
});
