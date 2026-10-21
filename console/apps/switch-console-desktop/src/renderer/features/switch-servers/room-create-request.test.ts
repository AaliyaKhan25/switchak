import { describe, expect, it } from 'vitest';
import { CreateRequestIds, canCreate, roomCreateRequest } from './room-create-request';

const form = {
  serverId: 's',
  workspaceId: 'w',
  name: ' Ship review ',
  description: ' Reviews ',
  instructions: '',
  agentIds: ['a1', 'a2'],
  requestId: 'req',
};

describe('roomCreateRequest', () => {
  it('creates a Switch Console chat when no messaging app is chosen', () => {
    expect(roomCreateRequest({ ...form, bridgeId: null })).toEqual({
      kind: 'chat',
      params: {
        serverId: 's',
        name: 'Ship review',
        agentIds: ['a1', 'a2'],
        memberUserIds: [],
        requestId: 'req',
        greeting: null,
      },
    });
  });

  it('creates a bridged room as before when an app is chosen', () => {
    expect(roomCreateRequest({ ...form, bridgeId: 'b1', agentIds: [] })).toEqual({
      kind: 'room',
      params: {
        workspaceId: 'w',
        name: 'Ship review',
        description: 'Reviews',
        instructions: undefined,
        bridgeId: 'b1',
        agentIds: [],
      },
    });
  });
});

describe('canCreate', () => {
  it('asks a chat only for a name, a bridged room for a description too', () => {
    expect(canCreate({ bridgeId: null, name: 'x', description: '' })).toBe(true);
    expect(canCreate({ bridgeId: 'b1', name: 'x', description: '' })).toBe(false);
    expect(canCreate({ bridgeId: 'b1', name: 'x', description: 'd' })).toBe(true);
    expect(canCreate({ bridgeId: null, name: ' ', description: 'd' })).toBe(false);
  });
});

describe('CreateRequestIds', () => {
  it('reuses the id for an unchanged form and takes a new one on a change or a success', () => {
    let n = 0;
    const ids = new CreateRequestIds(() => `id-${++n}`);
    const chatForm = { bridgeId: null, name: 'Ship review', agentIds: ['a1', 'a2'] };
    const first = ids.for(chatForm);
    expect(ids.for({ ...chatForm, name: ' Ship review ' })).toBe(first);
    expect(ids.for({ ...chatForm, name: 'Ship reviews' })).not.toBe(first);
    expect(ids.for({ ...chatForm, name: 'Ship reviews', agentIds: ['a1'] })).toBe('id-3');
    ids.succeeded();
    expect(ids.for({ ...chatForm, name: 'Ship reviews', agentIds: ['a1'] })).toBe('id-4');
  });
});
