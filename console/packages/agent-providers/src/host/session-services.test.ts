import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServiceGrant } from './service-access';
import {
  recordedServicesShape,
  recordSessionServices,
  servicesChanged,
  servicesShape,
} from './session-services';

const grant = (service: string, overrides: Partial<ServiceGrant> = {}): ServiceGrant => ({
  service,
  access: 'read',
  tool_mode: 'allow',
  tools: [],
  resources: {},
  revision: 1,
  skill: { name: service, content: `# ${service}` },
  mcp_servers: [],
  cli_tools: [],
  ...overrides,
});

describe('the shape of a session’s grants', () => {
  it('changes when a service is granted or taken away', () => {
    const before = servicesShape({ grants: [grant('github')], unavailable: null });
    const after = servicesShape({
      grants: [grant('github'), grant('google-workspace')],
      unavailable: null,
    });
    expect(after).not.toBe(before);
    expect(servicesShape({ grants: [], unavailable: null })).not.toBe(before);
  });

  it('leaves out what tokens carry: access, resources and revision', () => {
    const before = servicesShape({ grants: [grant('github')], unavailable: null });
    const widened = grant('github', {
      access: 'write',
      resources: { repository_ids: [1] },
      revision: 2,
    });
    expect(servicesShape({ grants: [widened], unavailable: null })).toBe(before);
  });

  it('follows which tools may be called, whatever order the grants come in', () => {
    const a = grant('atlassian', { tool_mode: 'deny', tools: ['b', 'a'] });
    const g = grant('github');
    const shape = servicesShape({ grants: [a, g], unavailable: null });
    expect(servicesShape({ grants: [g, { ...a, tools: ['a', 'b'] }], unavailable: null })).toBe(
      shape
    );
    expect(servicesShape({ grants: [g, { ...a, tools: ['a'] }], unavailable: null })).not.toBe(
      shape
    );
  });

  it('is unknown when the grants could not be read', () => {
    expect(servicesShape({ grants: [], unavailable: 'HTTP 503' })).toBeNull();
  });
});

describe('a session’s recorded grants', () => {
  it('reads back what its host recorded, and nothing for a host that recorded none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-services-'));
    expect(await recordedServicesShape(root)).toBeUndefined();
    await recordSessionServices(root, { grants: [grant('github')], unavailable: null });
    expect(await recordedServicesShape(root)).toBe(
      servicesShape({ grants: [grant('github')], unavailable: null })
    );
    await recordSessionServices(root, { grants: [], unavailable: 'HTTP 503' });
    expect(await recordedServicesShape(root)).toBeNull();
  });

  it('refuses a record it cannot read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-services-'));
    await writeFile(join(root, 'services.json'), '{"shape": 1}');
    await expect(recordedServicesShape(root)).rejects.toThrow();
  });
});

describe('whether a session’s grants changed', () => {
  it('is a change when both sides are known and differ', () => {
    expect(servicesChanged('[]', '[1]')).toBe(true);
    expect(servicesChanged('[1]', '[1]')).toBe(false);
  });

  it('is a change for a host that started without its grants, once they can be read', () => {
    expect(servicesChanged(null, '[]')).toBe(true);
  });

  it('is never a change on a guess', () => {
    expect(servicesChanged(undefined, '[1]')).toBe(false);
    expect(servicesChanged('[]', null)).toBe(false);
  });
});
