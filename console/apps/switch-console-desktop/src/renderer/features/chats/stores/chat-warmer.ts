import { log } from '@renderer/utils/logger';

/** How long after warming a chat its agent's session is not asked for again. */
export const WARM_INTERVAL_MS = 3 * 60_000;

type Warm = (serverId: string, agentId: string, roomId: string) => Promise<void>;

/**
 * Asks for a chat's session at most once per `WARM_INTERVAL_MS`, and not
 * while an ask is still under way.
 */
export function createChatWarmer(warm: Warm, now: () => number): Warm {
  const last = new Map<string, number>();
  const asking = new Set<string>();
  return async (serverId, agentId, roomId) => {
    const key = JSON.stringify([serverId, agentId, roomId]);
    const at = last.get(key);
    if (asking.has(key) || (at !== undefined && now() - at < WARM_INTERVAL_MS)) return;
    last.set(key, now());
    asking.add(key);
    try {
      await warm(serverId, agentId, roomId);
    } catch (error) {
      log.warn('Could not ask for the agent’s session while typing', { roomId, error });
    } finally {
      asking.delete(key);
    }
  };
}
