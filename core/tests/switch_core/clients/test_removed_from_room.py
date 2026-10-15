"""What an agent client does when it is taken out of a room while running.

Dropping the transport's subscription governs only what has not been read yet.
Everything already read is in the event buffer, which is keyed by agent and
knows nothing about who is in what: it holds each event for the retention
window and serves it to a long poll, to the notification stream, and to an SSE
reader resuming from an old cursor. So the removal has to reach the things
holding the events, not only the reader that would have fetched more.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.clients.actor import Actor
from switch_core.clients.agent_consumer import AgentConsumer, RoomMeta
from switch_core.clients.consumer import Consumer
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.transport import InboundMembership, RoomRef
from tests.db_buffer import seed_agent

AGENT = "agent-1"
LEFT = "room-left"
KEPT = "room-kept"


@pytest.fixture(autouse=True)
async def _agent_row(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent whose events are retained, so they have a row to belong to."""
    await seed_agent(session_factory, AGENT)


def _message(room_id: str, body: str) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room_id,
        payload=MessagePayload(
            addressed=True,
            sender="@someone:test",
            sender_name="someone",
            message_id=f"$m-{body}",
            body=body,
            timestamp=0,
        ),
    )


async def _keep(buffer: EventBuffer, room_id: str, body: str) -> None:
    """A message addressed to the agent in `room_id`, kept as one of its own."""
    await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        room_id,
        _message(room_id, body),
        room_seq=1,
        message_key=f"$m-{body}",
    )


def _leave(transport_room_id: str) -> InboundMembership:
    return InboundMembership(
        room_id=transport_room_id,
        event_id="$leave",
        sender="@agent:test",
        timestamp=0,
        state_key="@agent:test",
        membership="leave",
        display_name="agent",
    )


def _client(
    buffer: EventBuffer, connections: AgentConnectionRegistry
) -> SimpleNamespace:
    """A minimal fake `self` for the unbound `AgentConsumer.on_removed`."""
    meta = {
        "!left:test": RoomMeta(
            room_id=LEFT,
            name="left",
            bridge_id=None,
            channel_type="channel_public",
        ),
    }

    async def _resolve_room_meta(transport_room_id: str) -> RoomMeta | None:
        return meta.get(transport_room_id)

    return SimpleNamespace(
        _event_buffer=buffer,
        _connections=connections,
        agent=SimpleNamespace(id=AGENT),
        tenant_id=TENANT_ZERO_ID,
        _resolve_room_meta=_resolve_room_meta,
    )


async def _removed(stub: SimpleNamespace, transport_room_id: str) -> None:
    await AgentConsumer.on_removed(
        stub,  # type: ignore[arg-type]
        RoomRef(room_id=transport_room_id),
        _leave(transport_room_id),
    )


async def test_the_rooms_retained_events_are_forgotten(db_buffer: EventBuffer) -> None:
    buffer = db_buffer
    await _keep(buffer, LEFT, "said in the old room")
    await _keep(buffer, KEPT, "said in this one")

    await _removed(_client(buffer, AgentConnectionRegistry()), "!left:test")

    # Read at the level every reader is built on, filter or no filter: this is
    # what closes it for the stream, which has no membership of its own to
    # apply and would otherwise replay the room on every resume.
    assert [
        item.room_id for item in await buffer.read_from(TENANT_ZERO_ID, AGENT, 0)
    ] == [KEPT]


async def test_the_rooms_claim_is_released(db_buffer: EventBuffer) -> None:
    connections = AgentConnectionRegistry()
    conn = connections.open(
        agent_id=AGENT,
        connection_id="c1",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    connections.claim_room(conn, LEFT)

    await _removed(_client(db_buffer, connections), "!left:test")

    assert conn.rooms == set()


async def test_a_room_that_cannot_be_resolved_drops_nothing(
    db_buffer: EventBuffer,
) -> None:
    """Rather than guessing which room was meant and emptying the wrong one."""
    buffer = db_buffer
    await _keep(buffer, LEFT, "still here")

    await _removed(_client(buffer, AgentConnectionRegistry()), "!unknown:test")

    assert [
        item.room_id for item in await buffer.read_from(TENANT_ZERO_ID, AGENT, 0)
    ] == [LEFT]


class _CapturingTransport:
    def __init__(self) -> None:
        self.handlers: object | None = None

    def register_handlers(self, handlers: object) -> None:
        self.handlers = handlers


class _BareClient(Consumer):
    """Enough of a consumer for `setup` to run and a hook to be observed."""

    def __init__(self, transport: _CapturingTransport) -> None:
        actor = Actor.__new__(Actor)
        actor.transport_user_id = "@agent:test"
        # `_transport` is a property over this, and raises until it is set.
        actor.transport = transport
        self.actor = actor
        self._self_join_dispatched: set[str] = set()
        self.removed: list[str] = []

    async def on_removed(self, room: RoomRef, event: InboundMembership) -> None:
        self.removed.append(room.room_id)


async def test_setup_wires_the_removal_hook_to_the_transport() -> None:
    """The seam the whole eviction path hangs off.

    Everything else here calls `on_removed` directly, and the transport tests
    prove it dispatches `on_removed` — but nothing joined the two. Severing
    this one line left every other test in the suite green while a kick
    reached nobody, which is the leak with an extra step.
    """
    transport = _CapturingTransport()
    client = _BareClient(transport)

    client.setup()

    handlers = transport.handlers
    assert handlers is not None
    assert handlers.on_removed is not None, (  # type: ignore[attr-defined]
        "the transport was given no removal handler, so a kick reaches nothing"
    )

    await handlers.on_removed(  # type: ignore[attr-defined]
        RoomRef(room_id="!left:test"), _leave("!left:test")
    )
    assert client.removed == ["!left:test"]


async def test_being_removed_ends_the_visit_so_a_return_is_a_fresh_arrival() -> None:
    """The same bookkeeping a `leave` delivered as a member event does.

    Otherwise an agent added back to a room it had been removed from would
    rejoin in silence, because the join it already announced is remembered.
    """
    transport = _CapturingTransport()
    client = _BareClient(transport)
    client._self_join_dispatched.add("!left:test")
    client.setup()

    await transport.handlers.on_removed(  # type: ignore[attr-defined, union-attr]
        RoomRef(room_id="!left:test"), _leave("!left:test")
    )

    assert client._self_join_dispatched == set()
