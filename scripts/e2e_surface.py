#!/usr/bin/env python3
"""Write, or check, the server surface the end-to-end coverage gate reads.

The gate (`console/tooling-e2e/src/gate/`) holds every agent operation and
every gateway route to account: a scenario that covers it, or an exemption
that says why not. The gate is TypeScript and must not need a running server,
so the surface it reads is a committed snapshot:

* every declared agent operation, gated groups included — one definition
  serves both the MCP server and the HTTP front door, so this is the agent
  surface whichever door an agent uses;
* every gateway route as `METHOD /gateway/path`, with every feature flag on and
  agent management mounted, and what it authenticates with: a signed-in
  session (`session`), the hosted controller's operator token
  (`operator-token`), or nothing (`none`). The gate requires each route that
  takes nothing to be listed with a reason, and the fast lane checks that each
  `session` route refuses a request without one.

Usage:
    uv run --project core python scripts/e2e_surface.py           # write it
    uv run --project core python scripts/e2e_surface.py --check   # verify it

`--check` builds the snapshot in memory and compares, so CI catches both a
route added without regenerating and a hand-edited snapshot.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute
from starlette.routing import Route

from switch_core.bridges.agent.operations import declared_operations
from switch_core.config import SwitchConfig
from switch_core.feature_flags import KNOWN_FEATURE_FLAGS
from switch_core.gateway.app import create_gateway_app
from switch_core.gateway.auth import (
    get_authenticated_caller,
    get_authenticated_session,
    get_authenticated_user_id,
    get_current_user,
    get_current_user_in_transaction,
)
from switch_core.gateway.hosted_controller import controller_session
from switch_core.management.gateway_routes import router as management_router
from switch_core.management.wiring import GATEWAY_PREFIX

REPO_ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = REPO_ROOT / "console" / "tooling-e2e" / "surface" / "server-surface.json"

# Every dependency that reads the `switch_auth` session cookie and refuses a
# request without a valid one. A route that depends on any of them, however
# deep, takes a signed-in session.
SESSION_DEPENDENCIES: frozenset[Callable[..., Any]] = frozenset(
    {
        get_current_user,
        get_current_user_in_transaction,
        get_authenticated_user_id,
        get_authenticated_session,
        get_authenticated_caller,
    }
)

# The app's collaborators are never called: building the app only mounts its
# routers. Its configuration is real, so whatever routes a setting gates are
# decided as a deployment would decide them, and fixed here rather than read
# from the environment, so every machine writes the same snapshot.
_COLLABORATORS = (
    "agent_store",
    "room_store",
    "room_group_store",
    "room_service",
    "chat_service",
    "bridge_store",
    "client_lifecycle",
    "collab_lifecycle",
    "connector_lifecycle",
    "connector_store",
    "event_buffer",
    "session_factory",
    "user_store",
    "external_user_store",
    "api_key_store",
    "invitation_store",
    "join_domain_store",
    "template_store",
    "usage_store",
    "budget_store",
    "resource_service",
    "protocol",
)


def _config() -> SwitchConfig:
    return SwitchConfig(
        _env_file=None,  # type: ignore[call-arg]
        db_host="db",
        db_port="5432",
        db_user="switch",
        db_password="placeholder",
        db_name="switch",
        id_server_name="switch.local",
        agent_registration_token="placeholder",
        secret_keys="surface:" + "0" * 64,
        gateway_admin_email="admin@example.com",
        gateway_admin_password="placeholder",
        controller_token_secret="0" * 64,
        feature_flags_enabled=",".join(sorted(KNOWN_FEATURE_FLAGS)),
    )


def gateway_app() -> FastAPI:
    app = create_gateway_app(
        **{name: MagicMock() for name in _COLLABORATORS},
        install_service=None,
        invite_mailer=None,
        config=_config(),
    )
    # What `Management.install` mounts when the agent_management flag is on.
    app.include_router(management_router, prefix=GATEWAY_PREFIX)
    return app


def _dependency_calls(dependant: Dependant) -> Iterator[Callable[..., Any]]:
    for dependency in dependant.dependencies:
        if dependency.call is not None:
            yield dependency.call
        yield from _dependency_calls(dependency)


# The hosted controller's machine routes take the operator controller's bearer
# token instead, and are never reachable with a session.
OPERATOR_TOKEN_DEPENDENCIES: frozenset[Callable[..., Any]] = frozenset(
    {controller_session}
)


def _auth(route: Route) -> str:
    if not isinstance(route, APIRoute):
        return "none"
    calls = set(_dependency_calls(route.dependant))
    if calls & SESSION_DEPENDENCIES:
        return "session"
    if calls & OPERATOR_TOKEN_DEPENDENCIES:
        return "operator-token"
    return "none"


def gateway_routes(app: FastAPI) -> list[dict[str, str]]:
    routes: dict[str, str] = {}
    for route in app.routes:
        if not isinstance(route, Route):
            raise TypeError(
                f"Gateway route {route!r} is a {type(route).__name__}, which this "
                "snapshot cannot enumerate. Teach scripts/e2e_surface.py about it."
            )
        for method in sorted(route.methods or ()):
            if method == "HEAD":
                continue
            key = f"{method} /gateway{route.path}"
            if key in routes:
                raise ValueError(f"Gateway route {key} is mounted twice.")
            routes[key] = _auth(route)
    return [{"route": key, "auth": routes[key]} for key in sorted(routes)]


def render() -> str:
    surface = {
        "_generated": "by scripts/e2e_surface.py; do not edit. Run `just e2e-surface`.",
        "operations": sorted(declared_operations()),
        "gatewayRoutes": gateway_routes(gateway_app()),
    }
    return json.dumps(surface, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify, write nothing")
    args = parser.parse_args()

    expected = render()
    relative = SNAPSHOT.relative_to(REPO_ROOT)
    if args.check:
        actual = SNAPSHOT.read_text() if SNAPSHOT.exists() else None
        if actual != expected:
            print(
                f"{relative} is out of date: the server's operations or gateway "
                "routes changed without regenerating it, or it was edited by "
                "hand.\nRun `just e2e-surface` and commit the result; the "
                "end-to-end coverage gate then says what the change needs.",
                file=sys.stderr,
            )
            return 1
        print(f"{relative} is current.")
        return 0
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(expected)
    print(f"wrote {relative}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
