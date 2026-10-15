import { EyeOff, Pencil } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { DropdownMenuItem, DropdownMenuSeparator } from '@renderer/lib/ui/dropdown-menu';
import type { ChatSummary } from '@shared/core/chats/chats';
import { chatsStore } from '../stores/chats';

export type ChatAction = {
  key: string;
  label: string;
  icon: ReactNode;
  separatorBefore?: boolean;
  run: () => void;
};

async function attempt(run: () => Promise<void>, failure: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    toast({ title: failureText(error, failure), variant: 'destructive' });
  }
}

/** Leave the chat view if it shows this room, and close it on an agent's Chats tab. */
function leaveIfOpen(roomId: string): void {
  const navigation = appState.navigation;
  if (navigation.currentViewId === 'chat' && navigation.viewParamsStore.chat?.roomId === roomId)
    navigation.navigate('home');
  if (navigation.viewParamsStore.managedAgent?.roomId === roomId)
    navigation.updateViewParams('managedAgent', { roomId: undefined });
}

/**
 * What can be done to a chat from its row or its header. Rename changes the
 * room for everyone, so it is offered only to its managers; removing it from
 * the list is the person's own and comes back with the next message.
 */
export function chatActions(serverId: string, chat: ChatSummary): ChatAction[] {
  const actions: ChatAction[] = [];
  if (chat.canManage)
    actions.push({
      key: 'rename',
      label: 'Rename',
      icon: <Pencil className="size-4" />,
      run: () =>
        showModal('renameChatModal', { serverId, roomId: chat.roomId, currentName: chat.name }),
    });
  actions.push({
    key: 'hide',
    label: 'Remove from my list',
    icon: <EyeOff className="size-4" />,
    separatorBefore: true,
    run: () =>
      void attempt(async () => {
        await rpc.chats.hide(serverId, chat.roomId);
        chatsStore.hide(chat.roomId);
        leaveIfOpen(chat.roomId);
      }, 'Could not remove the chat from your list.'),
  });
  return actions;
}

/** A chat's actions as dropdown menu items. */
export function ChatActionItems({ actions }: { actions: ChatAction[] }) {
  return actions.map((action, index) => (
    <Fragment key={action.key}>
      {action.separatorBefore && index > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem onClick={action.run}>
        {action.icon}
        {action.label}
      </DropdownMenuItem>
    </Fragment>
  ));
}
