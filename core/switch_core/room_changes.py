"""Telling people a room of theirs changed, so their Console reads its room
list again (`switch_core.user_changes`, kind `room`).

Whoever a room concerns is told: its owner, the people in it (through their
Switch Console member client or a platform account they claimed) and the
owners of its agents. A room is reported when it is created or archived or
unarchived, when its agents change, and when anyone joins or leaves it; the
client that left is named so the person who lost the room is told too.

The notice is a "read again", so it is sent from a task of its own after the
change has committed, and a lost one costs only a delay: Console still reads
its lists every few minutes.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from sqlalchemy import Result, or_, select, union

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    Agent,
    Client,
    ClientRoom,
    ExternalUser,
    ExternalUserClaim,
    Room,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.user_changes import ROOM

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.user_changes import UserChangePublisher

logger = logging.getLogger(__name__)


class RoomChanges:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        publisher: UserChangePublisher,
    ) -> None:
        self._session_factory = session_factory
        self._publisher = publisher
        self._tasks: set[asyncio.Task[None]] = set()

    def room_changed(self, tenant_id: str, room_id: str, client_ids: list[str]) -> None:
        """Tell everyone the room concerns, and the people behind `client_ids`
        (who may just have left it), that it changed. Returns at once."""
        task = asyncio.create_task(self._publish(tenant_id, room_id, client_ids))
        self._tasks.add(task)
        task.add_done_callback(self._finished)

    def _finished(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.error(
                "Could not tell people a room changed; their Console reads it "
                "again on its next poll",
                exc_info=task.exception(),
            )

    async def _publish(
        self, tenant_id: str, room_id: str, client_ids: list[str]
    ) -> None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            user_ids = await people_concerned(session, room_id, client_ids)
        for user_id in user_ids:
            self._publisher.publish(tenant_id, user_id, ROOM, room_id)


async def people_concerned(
    session: AsyncSession, room_id: str, client_ids: list[str]
) -> list[str]:
    """The room's owner, the people in it and behind `client_ids`, and the
    owners of its agents."""
    present = set(client_ids) | set(
        (
            await session.execute(
                select(ClientRoom.client_id).where(ClientRoom.room_id == room_id)
            )
        ).scalars()
    )
    found: Result[tuple[str | None]] = await session.execute(
        union(
            select(Room.owner_id).where(Room.id == room_id),
            select(Client.user_id).where(
                Client.id.in_(present), Client.type == MEMBER_CLIENT_TYPE
            ),
            select(ExternalUserClaim.user_id)
            .join(ExternalUser, ExternalUser.id == ExternalUserClaim.external_user_id)
            .where(ExternalUser.client_id.in_(present)),
            select(Agent.owner_id).where(
                or_(
                    Agent.id.in_(
                        select(room_agents.c.agent_id).where(
                            room_agents.c.room_id == room_id
                        )
                    ),
                    Agent.client_id.in_(present),
                )
            ),
        )
    )
    return sorted({user_id for user_id in found.scalars() if user_id is not None})
