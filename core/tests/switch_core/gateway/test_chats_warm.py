"""`POST /chats/{room_id}/warm`: Switch Console asks the controller of the
user's own agent to start its session while the user types."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

import httpx

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.controller_presence import (
    Binding,
    ControllerConnection,
)
from switch_core.db.models import TENANT_ZERO_ID, Agent, User
from tests.switch_core.gateway.conftest import _Harness, _Process
from tests.switch_core.gateway.test_chats_routes import _code

CONTROLLER = "controller-1"


async def _warm(
    chats: _Harness, user: User, room_id: str, agent: Agent
) -> httpx.Response:
    return await chats.client.post(
        f"/chats/{room_id}/warm",
        json={"agentId": agent.id},
        headers=chats.as_user(user),
    )


def _bind(connections: AgentConnectionRegistry, agent: Agent) -> None:
    """Bind the agent to the controller, as Management does in every process."""
    connections.controllers.bind(
        Binding(
            agent_id=agent.id,
            controller_id=CONTROLLER,
            tenant_id=TENANT_ZERO_ID,
            controller_name="the machine",
            running=True,
        )
    )


def _on_controller(
    connections: AgentConnectionRegistry, agent: Agent
) -> ControllerConnection:
    """Put the agent on a controller whose live stream this registry's process
    holds, and return the controller's connection."""
    _bind(connections, agent)
    controllers = connections.controllers
    conn = controllers.open(
        controller_id=CONTROLLER, tenant_id=TENANT_ZERO_ID, resume_cursors={}
    )
    controllers.attach_stream(conn)
    return conn


async def _eventually(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(10.0):
        while not check():
            await asyncio.sleep(0.02)


async def test_a_warm_reaches_the_agents_controller(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    controller = _on_controller(chats.connections, agent)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    response = await _warm(chats, chats.alice, room_id, agent)

    assert response.status_code == 202, response.text
    assert controller.warms == {(agent.id, room_id)}


async def test_a_warm_is_accepted_when_no_controller_takes_it(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    unbound = await _warm(chats, chats.alice, room_id, agent)
    controller = _on_controller(chats.connections, agent)
    chats.connections.controllers.detach_stream(controller, controller.stream_token)
    offline = await _warm(chats, chats.alice, room_id, agent)

    assert unbound.status_code == offline.status_code == 202
    assert controller.warms == set()


async def test_a_warm_refuses_non_members_others_agents_and_absent_agents(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    controller = _on_controller(chats.connections, agent)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    outsider = await _warm(chats, chats.bob, room_id, agent)
    assert outsider.status_code == 403
    assert _code(outsider) == "NOT_A_MEMBER"

    assert (await chats.invite(chats.alice, room_id, chats.bob)).status_code == 200
    not_owner = await _warm(chats, chats.bob, room_id, agent)
    assert not_owner.status_code == 403
    assert _code(not_owner) == "NOT_AGENT_OWNER"

    elsewhere = await chats.agent("elsewhere", owner=chats.alice)
    absent = await _warm(chats, chats.alice, room_id, elsewhere)
    assert absent.status_code == 422
    assert _code(absent) == "AGENT_NOT_IN_CHAT"

    assert controller.warms == set()


async def test_a_warm_refuses_an_owner_the_agents_policy_refuses(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    controller = _on_controller(chats.connections, agent)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    async with chats.factory() as session:
        row = await session.get(Agent, agent.id)
        assert row is not None
        row.addressing_policy = {"rules": [{"users": [], "agents": []}]}
        await session.commit()

    refused = await _warm(chats, chats.alice, room_id, agent)

    assert refused.status_code == 403
    assert _code(refused) == "AGENT_NOT_ALLOWED"
    assert controller.warms == set()


async def test_a_warm_reaches_a_controller_another_process_holds(
    chats: _Harness, two_processes: tuple[_Process, _Process]
) -> None:
    """The Console's request reaches a process that does not hold the
    controller's socket, which hands the warm to the process that does."""
    here, there = two_processes
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    controller = _on_controller(there.connections, agent)
    # What Management keeps in every process from the controller's rows: the
    # agent's binding, and which process holds the controller's socket.
    _bind(here.connections, agent)
    here.connections.controllers.held_elsewhere(CONTROLLER, there.bus.process_id)

    response = await _warm(chats, chats.alice, room_id, agent)

    assert response.status_code == 202, response.text
    await _eventually(lambda: controller.warms == {(agent.id, room_id)})
