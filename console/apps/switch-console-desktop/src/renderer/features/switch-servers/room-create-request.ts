/** What the New room dialog asks the server for: a Switch Console chat when no messaging app is chosen, else a room bridged to the chosen one. */
export type RoomCreateRequest =
  | {
      kind: 'chat';
      params: {
        serverId: string;
        name: string;
        agentIds: string[];
        memberUserIds: string[];
        requestId: string;
        greeting: null;
      };
    }
  | {
      kind: 'room';
      params: {
        workspaceId: string;
        name: string;
        description: string;
        instructions: string | undefined;
        bridgeId: string;
        agentIds: string[];
      };
    };

export function roomCreateRequest(form: {
  serverId: string;
  workspaceId: string;
  /** Null for Switch Console. */
  bridgeId: string | null;
  name: string;
  description: string;
  instructions: string;
  agentIds: string[];
  requestId: string;
}): RoomCreateRequest {
  const name = form.name.trim();
  if (form.bridgeId === null)
    return {
      kind: 'chat',
      params: {
        serverId: form.serverId,
        name,
        agentIds: form.agentIds,
        memberUserIds: [],
        requestId: form.requestId,
        greeting: null,
      },
    };
  return {
    kind: 'room',
    params: {
      workspaceId: form.workspaceId,
      name,
      description: form.description.trim(),
      instructions: form.instructions.trim() || undefined,
      bridgeId: form.bridgeId,
      agentIds: form.agentIds,
    },
  };
}

/** A chat needs only a name; a bridged room also needs a description. */
export function canCreate(form: { bridgeId: string | null; name: string; description: string }) {
  return form.name.trim() !== '' && (form.bridgeId === null || form.description.trim() !== '');
}
