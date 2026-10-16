import { USER_DATA_DIR_NAME } from '@shared/app-identity';

/**
 * The folder under the system's app-data directory this run keeps its data in.
 *
 * Several dev builds can run side by side on one machine (one per worktree)
 * when each keeps its own: the server list, sessions, the local database and
 * the managed local server's files live there. Dev-only, so a packaged app
 * never reads it.
 */
export function userDataDirName(): string {
  return (import.meta.env.DEV && process.env.SWITCH_CONSOLE_USER_DATA_DIR) || USER_DATA_DIR_NAME;
}
