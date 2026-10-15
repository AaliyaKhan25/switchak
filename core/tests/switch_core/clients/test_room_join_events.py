from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, RoomJoinPayload
from switch_core.clients.agent_consumer import AgentConsumer, RoomMeta
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.transport import InboundMembership, RoomRef
from tests.db_buffer import seed_agent

AGENT = "agent-1"


@pytest.fixture(autouse=True)
async def _agent_row(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agent the consumer queues for, so its events have a row to belong to."""
    await seed_agent(session_factory, AGENT)


async def _enqueued(client: SimpleNamespace) -> list[tuple[str, AgentEvent]]:
    """What the consumer queued for its agent, read back from the db-buffer as
    (room, event). Reading under the agent's id is what checks which agent it
    was queued for."""
    buffer: EventBuffer = client._event_buffer
    return [
        (item.room_id, item.event)
        for item in await buffer.read_from(TENANT_ZERO_ID, AGENT, 0)
    ]


class _FakeClientStore:
    """Resolves a matrix id to the Switch client that owns it, or nothing."""

    def __init__(self, names: dict[str, str]) -> None:
        self._names = names

    async def get_by_transport_user_id(
        self, _session: object, transport_user_id: str
    ) -> object | None:
        name = self._names.get(transport_user_id)
        return SimpleNamespace(display_name=name) if name else None


class _FakeRoomStore:
    def __init__(self, receives: bool) -> None:
        self._receives = receives

    async def get_receives_join_events(
        self, _session: object, _room_id: str, _agent_id: str
    ) -> bool:
        return self._receives


def _client(
    buffer: EventBuffer,
    meta: RoomMeta | None = None,
    *,
    receives: bool = True,
    known: dict[str, str] | None = None,
) -> SimpleNamespace:
    """A minimal fake `self` for the unbound AgentConsumer.on_member_event.

    Queues on the db-buffer; stubs agent identity, room-meta resolution, and the room
    store / session factory so the handler can run without a DB or live Matrix
    client. `receives` is what the stubbed store reports for this agent's
    per-room join-event setting.
    """
    resolved = meta or RoomMeta(
        room_id="room-1",
        name="Room",
        bridge_id="bridge-1",
        channel_type="channel_public",
    )

    async def _resolve_room_meta(_transport_room_id: str) -> RoomMeta | None:
        return resolved

    @asynccontextmanager
    async def _session_factory():
        yield SimpleNamespace()

    stub = SimpleNamespace(
        _event_buffer=buffer,
        agent=SimpleNamespace(id=AGENT),
        tenant_id=TENANT_ZERO_ID,
        _resolve_room_meta=_resolve_room_meta,
        _room_store=_FakeRoomStore(receives),
        client_store=_FakeClientStore(
            {"@alice:switch.local": "Alice"} if known is None else known
        ),
        session_factory=_session_factory,
    )
    # Bound, so the handler resolves the name through the real implementation.
    stub._member_name = lambda session, event: AgentConsumer._member_name(
        stub, session, event
    )
    return stub


def _member_event(
    *,
    membership: str = "join",
    prev_membership: str | None = "leave",
    state_key: str = "@alice:switch.local",
    displayname: str | None = "Alice",
    timestamp: int = 123,
) -> InboundMembership:
    content: dict[str, object] = {}
    if displayname is not None:
        content["displayname"] = displayname
    return InboundMembership(
        room_id="!matrix:switch.local",
        event_id="$member",
        sender=state_key,
        timestamp=timestamp,
        content=content,
        state_key=state_key,
        membership=membership,
        prev_membership=prev_membership,
        display_name=displayname,
    )


async def _run(client: SimpleNamespace, event: InboundMembership) -> None:
    await AgentConsumer.on_member_event(client, RoomRef("!matrix:switch.local"), event)


class TestRoomJoinEnqueue:
    async def test_join_enqueues_room_join_event(self, db_buffer: EventBuffer) -> None:
        client = _client(db_buffer)
        await _run(client, _member_event())

        assert len(await _enqueued(client)) == 1
        room_id, event = (await _enqueued(client))[0]
        assert room_id == "room-1"
        assert event.type == "room_join"
        assert event.bridge_id == "bridge-1"
        assert event.channel_type == "channel_public"
        assert isinstance(event.payload, RoomJoinPayload)
        assert event.payload.member == "@alice:switch.local"
        assert event.payload.member_name == "Alice"
        assert event.payload.timestamp == 123
        # Stubbed store opts this agent in → listening is True.
        assert event.payload.listening is True

    async def test_listening_reflects_store_setting(
        self, db_buffer: EventBuffer
    ) -> None:
        # The per-room, per-agent receives_join_events setting (off here)
        # decides whether the arrival is one of the agent's own events. Off, it
        # is the room's conversation: nothing is queued, and a reader that
        # wants the conversation reads the arrival from the room's log, with
        # `listening` False.
        client = _client(db_buffer, receives=False)
        await _run(client, _member_event())

        assert await _enqueued(client) == []

    async def test_the_member_is_named_the_way_switch_knows_them(
        self, db_buffer: EventBuffer
    ) -> None:
        """A profile carries the source platform's spelling of a name; the log
        records the Switch one. Delivering the profile name would make live
        events and history disagree about the same person."""
        client = _client(db_buffer, known={"@alice:switch.local": "alice"})
        await _run(client, _member_event(displayname="Alice \U0001f495"))

        _, event = (await _enqueued(client))[0]
        assert event.payload.member_name == "alice"

    async def test_a_member_no_switch_client_owns_falls_back_to_the_event(
        self, db_buffer: EventBuffer
    ) -> None:
        client = _client(db_buffer, known={})
        await _run(
            client, _member_event(displayname=None, state_key="@bob:switch.local")
        )

        assert len(await _enqueued(client)) == 1
        _, event = (await _enqueued(client))[0]
        assert event.payload.member_name == "bob"

    async def test_leave_does_not_enqueue(self, db_buffer: EventBuffer) -> None:
        client = _client(db_buffer)
        await _run(client, _member_event(membership="leave", prev_membership="join"))
        assert await _enqueued(client) == []

    async def test_profile_update_does_not_enqueue(
        self, db_buffer: EventBuffer
    ) -> None:
        # membership-preserving update (e.g. display-name change): join -> join.
        client = _client(db_buffer)
        await _run(client, _member_event(membership="join", prev_membership="join"))
        assert await _enqueued(client) == []

    async def test_no_room_meta_does_not_enqueue(self, db_buffer: EventBuffer) -> None:
        async def _none(_transport_room_id: str) -> RoomMeta | None:
            return None

        client = _client(db_buffer)
        client._resolve_room_meta = _none
        await _run(client, _member_event())
        assert await _enqueued(client) == []


class TestRoomJoinPayloadRegistry:
    def test_agent_event_parses_room_join_payload(self) -> None:
        event = AgentEvent.model_validate(
            {
                "type": "room_join",
                "room_id": "room-1",
                "bridge_id": None,
                "channel_type": "channel_public",
                "payload": {
                    "member": "@alice:switch.local",
                    "member_name": "Alice",
                    "timestamp": 123,
                    "listening": True,
                },
            }
        )
        assert isinstance(event.payload, RoomJoinPayload)
        assert event.payload.member_name == "Alice"
        assert event.payload.listening is True
