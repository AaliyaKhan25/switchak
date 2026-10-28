"""A channel renamed on the platform renames the room linked to it, unless the
room was given a title of its own; another channel's rename touches nothing."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.tenant_context import current_tenant_id


class _FakeSession:
    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _RoomStore:
    def __init__(self, rooms: dict[str, SimpleNamespace]) -> None:
        self._rooms = rooms

    async def get_by_external_channel(
        self, session: Any, bridge_id: str, external_channel_id: str
    ) -> SimpleNamespace | None:
        assert bridge_id == "bridge-1"
        return self._rooms.get(external_channel_id)


class _RoomService:
    def __init__(self) -> None:
        self.renamed: list[tuple[str, str, str | None]] = []

    async def update_room(self, room_id: str, *, name: str) -> None:
        self.renamed.append((room_id, name, current_tenant_id()))


def _bridge(rooms: dict[str, SimpleNamespace]) -> SimpleNamespace:
    session = _FakeSession()
    return SimpleNamespace(
        _session_factory=lambda: session,
        _room_store=_RoomStore(rooms),
        _room_service=_RoomService(),
        _bridge_id="bridge-1",
        _bridge_tenant_id="tenant-1",
        _bridge_type="discord",
        _bridge_display_name="Discord",
    )


async def _rename(bridge: SimpleNamespace, channel_id: str, old: str, new: str) -> None:
    await CollaborationCore._handle_channel_renamed(bridge, channel_id, old, new)  # type: ignore[arg-type]


async def test_the_linked_room_takes_the_channels_new_name() -> None:
    bridge = _bridge(
        {
            "c-1": SimpleNamespace(id="room-1", name="Discord: qa-overnight-adopted"),
            "c-2": SimpleNamespace(id="room-2", name="Discord: other"),
        }
    )
    await _rename(bridge, "c-1", "qa-overnight-adopted", "qa-adopted-renamed")
    await _rename(bridge, "c-9", "unlinked", "still-unlinked")
    assert bridge._room_service.renamed == [
        ("room-1", "Discord: qa-adopted-renamed", "tenant-1")
    ]


async def test_a_room_with_its_own_title_keeps_it() -> None:
    bridge = _bridge({"c-1": SimpleNamespace(id="room-1", name="Launch planning")})
    await _rename(bridge, "c-1", "launch", "launch-2026")
    assert bridge._room_service.renamed == []


async def test_the_adapter_reports_only_a_rename_in_its_own_guild() -> None:
    reported: list[tuple[str, str, str]] = []

    async def renamed(channel_id: str, old: str, new: str) -> None:
        reported.append((channel_id, old, new))

    adapter = SimpleNamespace(_guild_id=1, _on_channel_renamed=renamed)

    def channel(guild_id: int, name: str) -> SimpleNamespace:
        return SimpleNamespace(id=42, name=name, guild=SimpleNamespace(id=guild_id))

    for before, after in (
        (channel(1, "old"), channel(1, "new")),
        (channel(2, "old"), channel(2, "new")),
        (channel(1, "same"), channel(1, "same")),
    ):
        await DiscordAdapter.dispatch_channel_update(adapter, before, after)  # type: ignore[arg-type]
    assert reported == [("42", "old", "new")]
