import type { SwitchClient } from '../clients/switch-client.ts';
import type { ServerSurface } from '../gate/gate.ts';

/**
 * A check derived from the surface snapshot rather than written per route:
 * every gateway route that takes a signed-in session answers 401 to a request
 * that carries none.
 *
 * It covers nothing in the coverage gate's sense — a 401 says nothing about
 * what the route does — but it is free for every route the server adds, and
 * catches a session check that a refactor dropped, which the snapshot would
 * only show as a route moving to `none` in a diff.
 *
 * Only routes the deployment mounts are probed, read from its own OpenAPI
 * document: a route behind a feature flag it has off answers 404 for that
 * reason alone. Path parameters get a well-formed id that names nothing: the
 * session check runs before the route ever looks the id up.
 */

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

export function probePath(route: string): { method: string; path: string } {
  const [method, template] = route.split(' ', 2) as [string, string];
  return { method, path: template.replace(/\{[^}]+\}/g, PLACEHOLDER_ID) };
}

export interface SessionProbe {
  probed: number;
  /** Session routes in the snapshot this deployment does not mount. */
  notMounted: number;
  /** Each probed route that did not answer 401, with what it answered. */
  wrong: string[];
}

export async function probeSessionRoutes(
  switchClient: SwitchClient,
  surface: ServerSurface
): Promise<SessionProbe> {
  const mounted = await switchClient.mountedGatewayRoutes();
  const result: SessionProbe = { probed: 0, notMounted: 0, wrong: [] };
  for (const { route, auth } of surface.gatewayRoutes) {
    if (auth !== 'session') continue;
    if (!mounted.has(route)) {
      result.notMounted += 1;
      continue;
    }
    const { method, path } = probePath(route);
    const status = await switchClient.statusWithoutCredentials(method, path);
    result.probed += 1;
    if (status !== 401) result.wrong.push(`${route} -> ${status}`);
  }
  return result;
}
