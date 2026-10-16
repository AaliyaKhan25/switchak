"""A person signing in to a service, for any OAuth/MCP catalog entry.

Switch Console starts a flow with a one-time state, the port of its listener
on 127.0.0.1 and a completion secret. Core keeps the PKCE verifier and
exchanges the code itself, so neither Console nor the browser ever holds a
token. The browser comes back one of two ways, as the catalog allows and this
server can offer:

- **loopback**: the vendor redirects straight to Console's listener.
- **core**: the vendor redirects to Core's callback, which asks the person to
  continue (showing whose Switch account the sign-in will join), then relays
  the code to Console's listener. A cookie set when the browser left through
  Core ties the return to that browser.

Either way Console posts the code back with its completion secret, Core
exchanges it and reads the account, and Console confirms; only then is the
connection written, through `ServiceBroker.connect`.

Flows are rows in `sign_in_flows` (`connections/sign_in_flows.py`), as
GitHub's are, so any switch-core process can take any step: ten minutes each,
at most 256 per workspace, one per person.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from urllib.parse import urlencode

from switch_core.connections.adapters import (
    ConnectionSecret,
    ReauthorizationRequiredError,
    ServiceAdapterError,
)
from switch_core.connections.adapters.oauth import (
    Identity,
    OAuthAdapter,
    SignIn,
    s256,
)
from switch_core.connections.loader import (
    AccessLevel,
    ConnectionDefinition,
    RedirectMode,
)
from switch_core.connections.oauth_clients import core_callback, loopback_redirect
from switch_core.connections.sign_in_flows import (
    FlowGoneError,
    FlowsBusyError,
    FlowUsedError,
    SignInFlows,
    StoredFlow,
    digest,
)

KIND = "service"
# Some vendors issue codes as signed tokens: Atlassian's run past 2,000
# characters.
MAX_CODE_LENGTH = 8192
INTERRUPTED = "Sign-in was interrupted. Start it again from Switch Console."


class FlowError(Exception):
    """The flow cannot go on; the message is for the person."""


@dataclass(frozen=True)
class ServiceFlow:
    """A service sign-in as its row stands.

    Status runs pending → authorizing → (core: returning → delivered) →
    checking → ready | failed.
    """

    stored: StoredFlow

    @property
    def state(self) -> str:
        return self.stored.state

    @property
    def service(self) -> str:
        return self.stored.service

    @property
    def name(self) -> str:
        return str(self.stored.details["name"])

    @property
    def mode(self) -> RedirectMode:
        return "core" if self.stored.mode == "core" else "loopback"

    @property
    def status(self) -> str:
        return self.stored.status

    @property
    def port(self) -> int:
        return self.stored.port

    @property
    def owner_label(self) -> str:
        return self.stored.owner_label

    @property
    def error(self) -> str | None:
        return self.stored.error

    @property
    def account(self) -> Identity | None:
        result = self.stored.result
        if result is None:
            return None
        return Identity(account_id=result["account_id"], label=result["account_label"])

    @property
    def signed_in(self) -> SignIn | None:
        result = self.stored.result
        if result is None:
            return None
        return SignIn(
            secret=ConnectionSecret(dict(result["secret"])),
            granted_scopes=list(result["granted_scopes"]),
        )


class ServiceFlows:
    def __init__(self, public_url: str | None, flows: SignInFlows) -> None:
        self._public_url = public_url
        self._flows = flows

    def mode(self, definition: ConnectionDefinition) -> RedirectMode | None:
        """The first way back the catalog allows that this server can offer."""
        assert definition.auth.oauth is not None
        for mode in definition.auth.oauth.redirect:
            if mode == "loopback" or self._public_url is not None:
                return mode
        return None

    def authorize_url(self, service: str, state: str) -> str:
        """Core's own step in front of the vendor's, in core mode."""
        assert self._public_url is not None
        return (
            f"{self._public_url.rstrip('/')}/gateway/service-connections/"
            f"{service}/flows/authorize?" + urlencode({"state": state})
        )

    async def start(
        self,
        *,
        definition: ConnectionDefinition,
        tenant_id: str,
        user_id: str,
        state: str,
        port: int,
        completion_secret: str,
        owner_label: str,
    ) -> ServiceFlow:
        mode = self.mode(definition)
        if mode is None:
            raise FlowError(
                f"{definition.name} can return a sign-in only to this server, "
                "which has no public address (GATEWAY_PUBLIC_URL)."
            )
        assert definition.auth.oauth is not None
        ports = definition.auth.oauth.loopback_ports
        if mode == "loopback" and ports is not None and port not in ports:
            raise FlowError(
                f"{definition.name} takes a sign-in back only on port "
                f"{', '.join(str(p) for p in ports)} of this computer. Close "
                "whatever is using them, and connect again."
            )
        access = definition.access
        assert access is not None
        # Connecting asks for everything a grant may need: write where the
        # service has it. The grant is then on or off.
        consent: AccessLevel = "write" if access.write is not None else "read"
        level = access.write or access.read
        assert level.scopes is not None and access.read.scopes is not None
        try:
            stored = await self._flows.start(
                kind=KIND,
                service=definition.slug,
                tenant_id=tenant_id,
                user_id=user_id,
                state=state,
                mode=mode,
                port=port,
                redirect_uri=(
                    loopback_redirect(port)
                    if mode == "loopback"
                    else core_callback(self._public_url or "", definition.slug)
                ),
                owner_label=owner_label,
                details={
                    "name": definition.name,
                    "consent": consent,
                    "scopes": list(level.scopes),
                    "read_scopes": list(access.read.scopes),
                    "write_scopes": list(level.scopes) if consent == "write" else [],
                },
                completion_secret=completion_secret,
            )
        except FlowUsedError:
            raise FlowError(
                "This sign-in has already been used. Connect again."
            ) from None
        except FlowsBusyError:
            raise FlowError(
                "Too many sign-ins are under way. Please try again shortly."
            ) from None
        return ServiceFlow(stored)

    async def flow(self, state: str) -> ServiceFlow:
        """The flow under `state`, for the browser's steps."""
        try:
            stored = await self._flows.find(state)
        except FlowGoneError:
            raise FlowError(INTERRUPTED) from None
        if stored.kind != KIND:
            raise FlowError(INTERRUPTED)
        return ServiceFlow(stored)

    async def owned(self, state: str, tenant_id: str, user_id: str) -> ServiceFlow:
        try:
            stored = await self._flows.get(state, tenant_id)
        except FlowGoneError:
            raise FlowError(INTERRUPTED) from None
        if stored.kind != KIND or stored.user_id != user_id:
            raise FlowError(INTERRUPTED)
        return ServiceFlow(stored)

    async def vendor_url(
        self, flow: ServiceFlow, adapter: OAuthAdapter
    ) -> tuple[str, str]:
        """Where the browser signs in at the vendor, and the nonce that marks
        the browser sent there; once per flow."""
        nonce = secrets.token_urlsafe(32)
        taken = await self._flows.advance(
            flow.stored,
            expect=("pending",),
            to="authorizing",
            changes={"browser_nonce_hash": digest(nonce)},
        )
        if taken is None:
            raise FlowError("This sign-in has already been used. Connect again.")
        try:
            url = await adapter.authorization_url(
                redirect_uri=flow.stored.redirect_uri,
                state=flow.state,
                code_challenge=s256(flow.stored.verifier),
                scopes=list(flow.stored.details["scopes"]),
            )
        except BaseException:
            await self._flows.discard(flow.stored)
            raise
        return url, nonce

    async def returning(self, flow: ServiceFlow, code: str, nonce: str) -> None:
        """The browser is back at Core's callback, in core mode."""
        if (
            flow.mode != "core"
            or flow.status not in ("authorizing", "returning")
            or len(code) > MAX_CODE_LENGTH
            or not flow.stored.holds_nonce(nonce)
        ):
            raise FlowError("The sign-in could not be verified.")
        if not code:
            error = f"{flow.name} sign-in was cancelled."
            await self._flows.advance(
                flow.stored,
                expect=("authorizing", "returning"),
                to="failed",
                changes={"error": error},
            )
            raise FlowError(error)
        taken = await self._flows.advance(
            flow.stored, expect=("authorizing", "returning"), to="returning", changes={}
        )
        if taken is None:
            raise FlowError("The sign-in could not be verified.")

    async def deliver(self, flow: ServiceFlow, code: str, nonce: str) -> str:
        """The person continued: where their browser takes the code to Console."""
        if (
            flow.mode != "core"
            or flow.status != "returning"
            or not code
            or len(code) > MAX_CODE_LENGTH
            or not flow.stored.holds_nonce(nonce)
        ):
            raise FlowError("The sign-in could not be verified.")
        taken = await self._flows.advance(
            flow.stored, expect=("returning",), to="delivered", changes={}
        )
        if taken is None:
            raise FlowError("The sign-in could not be verified.")
        return f"{loopback_redirect(flow.port)}?" + urlencode(
            {"code": code, "state": flow.state}
        )

    async def complete(
        self,
        flow: ServiceFlow,
        *,
        completion_secret: str,
        code: str,
        adapter: OAuthAdapter,
    ) -> None:
        """Console hands back the code; Core exchanges it and reads the account."""
        ready_for = "authorizing" if flow.mode == "loopback" else "delivered"
        refused = FlowError(
            f"{flow.name} sign-in could not be verified. Connect again."
        )
        if (
            not flow.stored.holds_secret(completion_secret)
            or flow.status != ready_for
            or not code
            or len(code) > MAX_CODE_LENGTH
        ):
            raise refused
        checking = await self._flows.advance(
            flow.stored, expect=(ready_for,), to="checking", changes={}
        )
        if checking is None:
            raise refused
        try:
            signed_in = await adapter.exchange_code(
                code=code,
                verifier=flow.stored.verifier,
                redirect_uri=flow.stored.redirect_uri,
                scopes=list(flow.stored.details["scopes"]),
            )
            account = await adapter.identify(signed_in.secret.access_token or "")
        except ReauthorizationRequiredError:
            await self._fail(
                checking, f"{flow.name} refused the sign-in. Connect again."
            )
            raise FlowError(
                f"{flow.name} refused the sign-in. Connect again."
            ) from None
        except ServiceAdapterError as error:
            await self._fail(checking, str(error))
            raise FlowError(str(error)) from None
        except BaseException:
            await self._fail(checking, INTERRUPTED)
            raise
        ready = await self._flows.advance(
            checking,
            expect=("checking",),
            to="ready",
            changes={
                "encrypted_result": self._flows.seal(
                    {
                        "secret": signed_in.secret.values,
                        "granted_scopes": list(signed_in.granted_scopes),
                        "account_id": account.account_id,
                        "account_label": account.label,
                    }
                ),
                "account_label": account.label,
            },
        )
        if ready is None:
            # The flow expired or was cancelled while the code was exchanged:
            # what the vendor issued has nowhere to go.
            raise FlowError(INTERRUPTED)

    async def _fail(self, flow: StoredFlow, error: str) -> None:
        await self._flows.advance(
            flow, expect=("checking",), to="failed", changes={"error": error}
        )

    def consent(self, flow: ServiceFlow) -> AccessLevel:
        """What the person consented to, as the vendor granted it."""
        signed_in = flow.signed_in
        assert signed_in is not None
        granted = set(signed_in.granted_scopes)
        write_scopes = set(flow.stored.details["write_scopes"])
        if write_scopes and write_scopes <= granted:
            return "write"
        if set(flow.stored.details["read_scopes"]) <= granted:
            return "read"
        raise FlowError(
            f"{flow.name} granted less than Switch needs to read. Connect again "
            "and allow what it asks for."
        )

    def ready(self, flow: ServiceFlow, completion_secret: str) -> None:
        if not flow.stored.holds_secret(completion_secret):
            raise FlowError(INTERRUPTED)
        if flow.status != "ready":
            raise FlowError(f"Finish signing in to {flow.name} before confirming.")

    async def discard(self, flow: ServiceFlow) -> None:
        await self._flows.discard(flow.stored)
