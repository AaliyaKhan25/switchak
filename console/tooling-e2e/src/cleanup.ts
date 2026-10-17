/**
 * Remove artefacts a crashed or interrupted run left behind: Switch agents,
 * Switch rooms and Mattermost channels whose names start with `e2e-`.
 *
 * Scoped strictly to that prefix — an operator's real agents and their rooms are
 * never in scope, and the script prints everything it touches. It is also what
 * a scheduled wipe of a deployed environment runs.
 *
 *     SWITCH_E2E_LANE=fast node --experimental-strip-types src/cleanup.ts
 */
import { ARTIFACT_PREFIX } from './core/run.ts';
import { message, resolveLane } from './core/suite.ts';

export async function cleanup(log: (message: string) => void = console.log): Promise<void> {
  const lane = await resolveLane('fast');
  if (!lane.target) throw new Error(`Cannot clean up: ${lane.skip}`);
  const { env, switchClient, mattermost } = lane.target;

  for (const room of await switchClient.listRooms()) {
    if (!room.name.startsWith(ARTIFACT_PREFIX)) continue;
    try {
      await switchClient.deleteRoom(room.id);
      log(`deleted room ${room.name} (${room.id})`);
    } catch (error) {
      log(`could not delete room ${room.name}: ${message(error)}`);
    }
  }

  for (const agent of await switchClient.listAgents()) {
    if (!agent.name.startsWith(ARTIFACT_PREFIX)) continue;
    try {
      await switchClient.deleteAgentByName(agent.name);
      log(`deleted agent ${agent.name} (${agent.id})`);
    } catch (error) {
      log(`could not delete agent ${agent.name}: ${message(error)}`);
    }
  }

  if (!mattermost || !env.mattermost) {
    log('no Mattermost configured — skipping channels');
    return;
  }
  const team = await mattermost.findTeam(env.mattermost.team);
  for (const channel of await mattermost.listTeamChannels(team.id)) {
    if (!channel.name.startsWith(ARTIFACT_PREFIX)) continue;
    try {
      await mattermost.archiveChannel(channel.id);
      log(`archived channel ${channel.name} (${channel.id})`);
    } catch (error) {
      log(`could not archive channel ${channel.name}: ${message(error)}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cleanup().catch((error: unknown) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
