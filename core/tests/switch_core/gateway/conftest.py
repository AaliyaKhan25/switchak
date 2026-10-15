"""The `/chats` harness: real routes, `ChatService`, `RoomService` and
Postgres provisioning, shared by the chats test modules."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats.service import ChatError, ChatService
from switch_core.db.models import (
    Agent,
    Client,
    Message,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.chats import (
    chat_error_response,
    router,
)
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.room_service import RoomService
from switch_core.session_activity.listener import Change
from switch_core.transport.invites import InviteBus
from tests.switch_core.gateway.agent_route_harness import add_agent

_MESSAGE_STORE = MessageStore()


class _FakeLifecycle:
    """The running-client registry, for agents that have no consumer here."""

    def __init__(self) -> None:
        self.agents: dict[str, SimpleNamespace] = {}

    def get_by_agent_id(self, agent_id: str) -> SimpleNamespace | None:
        return self.agents.get(agent_id)

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


class _FakeListener:
    """Records subscriptions; a test rings a room by hand, or deliberately not."""

    def __init__(self) -> None:
        self.wakers: dict[str, set[Callable[[str], Awaitable[None]]]] = {}

    def subscribe(self, room_id: str, waker: Callable[[str], Awaitable[None]]) -> None:
        self.wakers.setdefault(room_id, set()).add(waker)

    def unsubscribe(
        self, room_id: str, waker: Callable[[str], Awaitable[None]]
    ) -> None:
        self.wakers.get(room_id, set()).discard(waker)

    async def ring(self, room_id: str) -> None:
        for waker in list(self.wakers.get(room_id, ())):
            await waker(room_id)


class _FakeActivityListener:
    """The session-activity listener; a test delivers changes by hand."""

    def __init__(self) -> None:
        self.subscribers: list[tuple[Any, Any]] = []

    def subscribe(self, tenant_id: str, on_change: Any, on_resync: Any) -> Any:
        entry = (on_change, on_resync)
        self.subscribers.append(entry)
        return lambda: self.subscribers.remove(entry)

    async def change(self, change: Change) -> None:
        for on_change, _ in list(self.subscribers):
            await on_change(change)

    async def resync(self) -> None:
        for _, on_resync in list(self.subscribers):
            await on_resync()


class _FakeControllers:
    """The controller presence, as far as warming a chat reads it."""

    def __init__(self) -> None:
        self.bound: set[str] = set()
        self.live = True
        self.warms: list[tuple[str, str]] = []

    def is_bound(self, agent_id: str) -> bool:
        return agent_id in self.bound

    def relay_warm(self, agent_id: str, room_id: str) -> bool:
        if not self.live:
            return False
        self.warms.append((agent_id, room_id))
        return True


class _Harness(SimpleNamespace):
    client: httpx.AsyncClient
    factory: async_sessionmaker[AsyncSession]
    service: ChatService
    room_service: RoomService
    listener: _FakeListener
    activity: _FakeActivityListener
    lifecycle: _FakeLifecycle
    controllers: _FakeControllers
    alice: User
    bob: User
    carol: User
    admin: User

    def as_user(self, user: User) -> dict[str, str]:
        return {"x-user": user.id}

    async def agent(
        self, name: str, *, owner: User, policy: dict | None = None
    ) -> Agent:
        async with self.factory() as session:
            agent = await add_agent(session, name=name, owner_id=owner.id)
            agent.addressing_policy = policy
            client = await session.get(Client, agent.client_id)
            assert client is not None
            self.lifecycle.agents[agent.id] = SimpleNamespace(
                client_id=client.id, transport_user_id=client.transport_user_id
            )
            await session.commit()
            return agent

    async def create_chat(
        self, user: User, agent: Agent, request_id: str, name: str | None = None
    ) -> httpx.Response:
        return await self.client.post(
            "/chats",
            json={"agentId": agent.id, "name": name, "requestId": request_id},
            headers=self.as_user(user),
        )

    async def new_chat(self, user: User, agent: Agent, request_id: str) -> str:
        response = await self.create_chat(user, agent, request_id)
        assert response.status_code == 200, response.text
        return str(response.json()["chat"]["roomId"])

    async def send(
        self, user: User, room_id: str, request_id: str, body: str, **extra: Any
    ) -> httpx.Response:
        return await self.client.post(
            f"/chats/{room_id}/messages",
            json={"requestId": request_id, "body": body, **extra},
            headers=self.as_user(user),
        )

    async def invite(self, manager: User, room_id: str, user: User) -> httpx.Response:
        return await self.client.post(
            f"/chats/{room_id}/members",
            json={"userId": user.id},
            headers=self.as_user(manager),
        )

    async def upload(
        self, user: User, room_id: str, upload_id: str, data: bytes, name: str
    ) -> httpx.Response:
        return await self.client.post(
            f"/chats/{room_id}/attachments",
            data={"uploadId": upload_id},
            files={"file": (name, data, "image/png")},
            headers=self.as_user(user),
        )

    async def message_rows(self, room_id: str) -> list[Message]:
        async with self.factory() as session:
            rows = await session.execute(
                select(Message)
                .where(
                    Message.room_id == room_id, Message.event_type == "m.room.message"
                )
                .order_by(Message.seq)
            )
            return list(rows.scalars().all())


async def _user(session: AsyncSession, name: str, role: str | None) -> User:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    if role is not None:
        await UserStore().add_membership(
            session,
            tenant_id="00000000-0000-0000-0000-000000000000",
            user_id=user.id,
            role=role,
        )
    return user


@pytest.fixture
async def chats(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[_Harness]:
    async with session_factory() as session:
        alice = await _user(session, "alice", "member")
        bob = await _user(session, "bob", "member")
        carol = await _user(session, "carol", None)
        admin = await _user(session, "admin", "admin")
        await session.commit()

    room_store = RoomStore()
    lifecycle = _FakeLifecycle()
    provisioning = PostgresProvisioning(
        session_factory=session_factory,
        room_store=room_store,
        client_store=ClientStore(),
        message_store=_MESSAGE_STORE,
        invites=InviteBus(),
    )
    room_service = RoomService(
        provisioning=provisioning,
        room_store=room_store,
        agent_store=AgentStore(),
        client_lifecycle=lifecycle,  # type: ignore[arg-type]
        collab_lifecycle=None,  # type: ignore[arg-type]
        collab_bridge_store=CollaborationBridgeStore(),
        resource_service=None,  # type: ignore[arg-type]
        session_factory=session_factory,
        room_cache=MagicMock(),
    )
    listener = _FakeListener()
    activity = _FakeActivityListener()
    controllers = _FakeControllers()
    service = ChatService(
        session_factory=session_factory,
        room_service=room_service,
        provisioning=provisioning,
        listener=listener,  # type: ignore[arg-type]
        activity_listener=activity,  # type: ignore[arg-type]
        room_store=room_store,
        agent_store=AgentStore(),
        user_store=UserStore(),
        message_store=_MESSAGE_STORE,
        media_store=MediaStore(),
        usage_store=UsageStore(),
        id_server_name="switch.test",
        media_max_bytes=1024,
        agent_chats_enabled=True,
        controllers=controllers,  # type: ignore[arg-type]
    )
    room_service.on_room_agents_changed(service.sync_room)

    app = FastAPI()
    app.state.chat_service = service
    app.add_exception_handler(ChatError, chat_error_response)
    app.include_router(router, prefix="/chats")

    async def user_from_header(request: Request) -> User:
        async with session_factory() as session:
            user = await session.get(User, request.headers["x-user"])
            assert user is not None
            return user

    app.dependency_overrides[get_current_user] = user_from_header
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://switch.test"
    ) as client:
        yield _Harness(
            client=client,
            factory=session_factory,
            service=service,
            room_service=room_service,
            listener=listener,
            activity=activity,
            lifecycle=lifecycle,
            controllers=controllers,
            alice=alice,
            bob=bob,
            carol=carol,
            admin=admin,
        )
