import type { ManagedAgentRecord } from '@main/core/agent-migration/managed-agents-store';

/** How long after a move an agent may be missing from the list without being forgotten. */
export const RECENT_MOVE_GRACE_MS = 2 * 60_000;

/**
 * The Console agents moved to management in a workspace that its server no
 * longer lists: deleted there, from another device or while this Console was
 * closed. Only a list the server actually returned counts as proof; an agent
 * moved moments ago may not be listed yet and is left alone.
 */
export function goneManagedRecords(
  records: readonly ManagedAgentRecord[],
  workspaceId: string,
  listedAgentIds: ReadonlySet<string>,
  now: number
): ManagedAgentRecord[] {
  return records.filter(
    (record) =>
      record.workspaceId === workspaceId &&
      !listedAgentIds.has(record.identities[0].switchAgentId) &&
      now - Date.parse(record.movedAt) > RECENT_MOVE_GRACE_MS
  );
}

/**
 * Forgets the moved agents the server no longer lists, so their old Console
 * rows stop showing as agents. A failure to forget one is logged by the caller
 * and leaves the rest to be tried.
 */
export async function forgetDeletedManagedAgents(
  workspaceId: string,
  listedAgentIds: ReadonlySet<string>,
  deps: {
    records: () => Promise<ManagedAgentRecord[]>;
    forget: (consoleAgentId: string) => Promise<void>;
    warn: (message: string, context: Record<string, unknown>) => void;
    now: () => number;
  }
): Promise<void> {
  const gone = goneManagedRecords(await deps.records(), workspaceId, listedAgentIds, deps.now());
  for (const record of gone) {
    try {
      await deps.forget(record.agentId);
    } catch (error) {
      deps.warn('Could not forget an agent its server no longer lists', {
        event: 'managed_agent_forget_failed',
        agentId: record.agentId,
        error: String(error),
      });
    }
  }
}
