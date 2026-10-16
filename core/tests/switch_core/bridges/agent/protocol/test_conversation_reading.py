"""A room's conversation, read for an agent from the room's own log.

What a reader that wants everything (`filter=all`, the legacy polls) is sent
besides the agent's own events. Three properties are pinned here, each found
running the stream end to end:

- a row is read once the agent's consumer has decided it is not the agent's
  own, and no sooner, so it is never sent twice;
- the agent's own event for a message stands for that message up to the row it
  was delivered through, so a file that arrives after its group was delivered
  is still read;
- a place in a room past the room's newest row is from a history the room no
  longer has, and is brought back to the room's end.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.bridges.agent.protocol.event_buffer import BufferedEvent, EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS, room_source
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID, Agent, Message, MessageAttachment
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from tests.db_buffer import db_buffer_on, say, seed_member, seed_room

AGENT = "agent-1"
ROOM = "room-1"
EMPTY_ROOM = "room-2"

SessionFactory = async_sessionmaker[AsyncSession]


@pytest.fixture(autouse=True)
async def _rows(session_factory: SessionFactory) -> None:
    await seed_member(session_factory, AGENT, ROOM)
    await seed_room(session_factory, EMPTY_ROOM)


def _unsettling(session_factory: SessionFactory) -> EventBuffer:
    """A buffer that takes a minute to settle a row on its own, so a test row
    is read only when the agent's own events say it was decided."""
    return db_buffer_on(session_factory, settle_seconds=60.0)


async def _keep(buffer: EventBuffer, room_seq: int, message_key: str) -> None:
    """The agent's own event for a message addressed to it, as its consumer
    keeps it."""
    await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        ROOM,
        AgentEvent(
            type="message",
            room_id=ROOM,
            payload=MessagePayload(
                addressed=True,
                sender="@alice:test",
                sender_name="Alice",
                message_id=message_key,
                body="@agent over to you",
                timestamp=0,
            ),
        ),
        room_seq=room_seq,
        message_key=message_key,
    )


async def _file(
    session_factory: SessionFactory,
    group: str,
    index: int,
    name: str,
    sent_at: datetime,
    *,
    caption: str | None = None,
) -> Message:
    """One file of a two-file message, as the bridge stores it: a row of its
    own, numbered within its attachment group."""
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        row = await MessageStore().create(
            session,
            Message(
                room_id=ROOM,
                transport_event_id=f"${group}-{index}",
                sender_id="@alice:test",
                sender_name="Alice",
                event_type="m.room.message",
                msgtype="m.file",
                body=caption or name,
                formatted_body=None,
                content={
                    "body": caption or name,
                    ATTACHMENT_GROUP_KEY: {"id": group, "index": index, "total": 2},
                },
                sent_at=sent_at,
            ),
            [MessageAttachment(uri=f"mxc://s/{name}", filename=name)],
        )
        await session.commit()
    return row


def _files(item: BufferedEvent) -> set[str]:
    attachments = getattr(item.event.payload, "attachments", None) or []
    return {ref.filename for ref in attachments}


def _bodies(items: list[BufferedEvent]) -> list[str | None]:
    return [getattr(item.event.payload, "body", None) for item in items]


async def test_what_came_before_the_agents_own_event_is_read_at_once(
    session_factory: SessionFactory,
) -> None:
    """The consumer takes a room's rows one at a time, in order, so once it has
    kept a row as the agent's own, every row before it is decided. Waiting for
    them to settle would send the agent its mention before the conversation
    that led up to it."""
    buffer = _unsettling(session_factory)
    await say(session_factory, ROOM, "before")
    asked = await say(session_factory, ROOM, "@agent over to you")
    await _keep(buffer, asked.seq, asked.transport_event_id)
    await say(session_factory, ROOM, "after")

    read = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    assert _bodies(read.events) == ["before"]
    # Looked through the agent's own row, and no further: "after" is not
    # decided yet.
    assert read.through == {ROOM: asked.seq}


async def test_a_row_not_yet_decided_holds_back_the_rows_after_it(
    session_factory: SessionFactory,
) -> None:
    """Rows are read as an unbroken run from the reader's place. A settled row
    after an unsettled one waits for it, or the reader's place would move past
    the unsettled row and it would never be read."""
    buffer = db_buffer_on(session_factory, settle_seconds=30.0)
    now = datetime.now(UTC)
    await say(session_factory, ROOM, "settled", sent_at=now - timedelta(minutes=5))
    await say(session_factory, ROOM, "fresh", sent_at=now)
    await say(session_factory, ROOM, "stamped late", sent_at=now - timedelta(minutes=5))

    read = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    assert _bodies(read.events) == ["settled"]


async def test_a_backlog_longer_than_one_read_keeps_its_order(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A read takes at most `limit` rows of a room. The agent's own event for a
    message posted after the rows left over waits for them, rather than going
    out ahead of conversation that came before it."""
    buffer = db_buffer
    long_ago = datetime.now(UTC) - timedelta(minutes=1)
    for index in range(3):
        await say(session_factory, ROOM, f"chatter {index}", sent_at=long_ago)
    asked = await say(session_factory, ROOM, "@agent over to you")
    await _keep(buffer, asked.seq, asked.transport_event_id)

    position: dict[str, int] = {room_source(ROOM): 0}
    sent: list[list[str | None]] = []
    for _ in range(2):
        events, looked = await buffer.read(
            TENANT_ZERO_ID, AGENT, position, conversation_rooms={ROOM}, limit=2
        )
        sent.append(_bodies(events))
        for item in events:
            position[item.source] = max(position.get(item.source, -1), item.seq)
        for source, seq in looked.items():
            position[source] = max(position.get(source, -1), seq)

    assert sent == [
        ["chatter 0", "chatter 1"],
        ["chatter 2", "@agent over to you"],
    ]


async def test_a_file_that_arrives_after_its_group_was_delivered_is_still_read(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """The consumer delivers several files posted as one once they are all in,
    or when it stops waiting for the rest. A file arriving after that is past
    the row the group was delivered through: it is conversation, and the files
    already delivered are not sent again."""
    buffer = db_buffer
    long_ago = datetime.now(UTC) - timedelta(minutes=1)

    def part(index: int) -> dict[str, object]:
        return {ATTACHMENT_GROUP_KEY: {"id": "grp", "index": index, "total": 3}}

    await say(session_factory, ROOM, "first", content=part(0), sent_at=long_ago)
    second = await say(
        session_factory, ROOM, "second", content=part(1), sent_at=long_ago
    )
    await _keep(buffer, second.seq, "grp")
    await say(session_factory, ROOM, "late", content=part(2), sent_at=long_ago)

    read = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    assert _bodies(read.events) == ["late"]


async def test_a_message_posted_between_the_files_of_a_group_goes_out_first(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A multi-file message goes out once, at its last file. A message posted
    between its files goes out before it, so the room's events go out in rising
    order and a client that disconnects after the group has not been moved past
    the message in between."""
    buffer = db_buffer
    long_ago = datetime.now(UTC) - timedelta(minutes=1)

    await _file(session_factory, "g1", 0, "one.pdf", long_ago)
    between = await say(session_factory, ROOM, "in between", sent_at=long_ago)
    last = await _file(session_factory, "g1", 1, "two.pdf", long_ago)

    read = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    assert [item.seq for item in read.events] == [between.seq, last.seq]
    assert _bodies(read.events)[0] == "in between"


async def test_a_group_held_back_by_another_keeps_its_first_file(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Two people post two files each and the files interleave: A's first, B's
    first, A's second. B is still waiting for its second file, so it holds the
    read at its first file. A goes out at its last file, which is past the
    hold, so the read must not move past A's first file either, or the next
    read would send A with only its second file."""
    buffer = db_buffer
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        now = await session.scalar(select(func.now()))
    assert now is not None
    # Past the settle time (0.2 s for `db_buffer`) and within the group grace
    # time (5 s), so B, missing its second file, is held.
    recent = now - timedelta(seconds=3)
    a_first = await _file(
        session_factory, "A", 0, "a-one.pdf", recent, caption="see these"
    )
    await _file(session_factory, "B", 0, "b-one.pdf", recent)
    await _file(session_factory, "A", 1, "a-two.pdf", recent)

    first = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    assert first.events == []
    place = first.through.get(ROOM, 0)
    assert place < a_first.seq

    # B's grace time runs out without its second file.
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(Message)
            .where(Message.room_id == ROOM)
            .values(sent_at=Message.sent_at - timedelta(minutes=1))
        )
        await session.commit()

    second = await buffer.read_conversation(
        TENANT_ZERO_ID, AGENT, {ROOM: place}, limit=100
    )

    assert [_files(item) for item in second.events] == [
        {"b-one.pdf"},
        {"a-one.pdf", "a-two.pdf"},
    ]


async def test_a_place_past_the_end_of_a_room_is_brought_back_to_it(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A position never moves back, so a place a room's log does not reach (a
    restored database) would pass over that many of its next messages. The
    agent's own events are left to their own checks."""
    buffer = db_buffer
    await say(session_factory, ROOM, "one")
    await say(session_factory, ROOM, "two")

    within, past = await buffer.within_rooms(
        TENANT_ZERO_ID,
        {OWN_EVENTS: 99, room_source(ROOM): 9, room_source(EMPTY_ROOM): 3},
    )

    assert within == {OWN_EVENTS: 99, room_source(ROOM): 2, room_source(EMPTY_ROOM): 0}
    assert past == [ROOM, EMPTY_ROOM]


async def test_a_poll_for_an_agent_deleted_meanwhile_saves_nothing(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A long poll can be waiting when its agent is deleted. The place it would
    save goes with the agent rather than failing the request."""
    buffer = db_buffer
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(delete(Agent).where(Agent.id == AGENT))
        await session.commit()

    assert await buffer.poll(TENANT_ZERO_ID, AGENT, rooms={ROOM}, timeout=0) == []
