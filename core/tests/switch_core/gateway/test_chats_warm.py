"""`POST /chats/{room_id}/warm`: Switch Console asks the controller of the
user's own agent to start its session while the user types."""

from __future__ import annotations

import httpx

from switch_core.db.models import Agent, User
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_routes import _code


async def _warm(
    chats: _Harness, user: User, room_id: str, agent: Agent
) -> httpx.Response:
    return await chats.client.post(
        f"/chats/{room_id}/warm",
        json={"agentId": agent.id},
        headers=chats.as_user(user),
    )


async def test_a_warm_reaches_the_agents_controller(chats: _Harness) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    chats.controllers.bound.add(agent.id)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    response = await _warm(chats, chats.alice, room_id, agent)

    assert response.status_code == 202, response.text
    assert chats.controllers.warms == [(agent.id, room_id)]


async def test_a_warm_is_accepted_when_no_controller_takes_it(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")

    unbound = await _warm(chats, chats.alice, room_id, agent)
    chats.controllers.bound.add(agent.id)
    chats.controllers.live = False
    offline = await _warm(chats, chats.alice, room_id, agent)

    assert unbound.status_code == offline.status_code == 202
    assert chats.controllers.warms == []


async def test_a_warm_refuses_non_members_others_agents_and_absent_agents(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    chats.controllers.bound.add(agent.id)
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

    assert chats.controllers.warms == []


async def test_a_warm_refuses_an_owner_the_agents_policy_refuses(
    chats: _Harness,
) -> None:
    agent = await chats.agent("helper", owner=chats.alice)
    chats.controllers.bound.add(agent.id)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    async with chats.factory() as session:
        row = await session.get(Agent, agent.id)
        assert row is not None
        row.addressing_policy = {"rules": [{"users": [], "agents": []}]}
        await session.commit()

    refused = await _warm(chats, chats.alice, room_id, agent)

    assert refused.status_code == 403
    assert _code(refused) == "AGENT_NOT_ALLOWED"
    assert chats.controllers.warms == []
