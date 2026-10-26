"""What a template sets on the agents it creates, and how to tell, later,
whether anyone has changed it since.

A template install (``db.models.TemplateInstall``) keeps, for each agent a
run created, a fingerprint of every value the template set on it. A value
whose fingerprint still matches is one nobody has changed, which a newer
revision of the template may replace; one that no longer matches was changed
by someone, and is theirs.

Only these fields are the template's to update. Who may address an agent,
whether it can manage agents, its provider, machine and directory are
settled when it is created and never touched by an update.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from switch_core.agent_templates import plan_template
from switch_core.providers.registry import provider_ids
from switch_core.template_runs import NewAgentPlan
from switch_core.template_v2 import compile_v2, is_v2_text

AGENT_FIELDS: tuple[str, ...] = (
    "instructions",
    "description",
    "icon_url",
    "display_name",
)


def fingerprint(value: str | None) -> str:
    """A value's fingerprint: equal for equal values, and short."""
    return hashlib.sha256(json.dumps(value).encode()).hexdigest()[:32]


def agent_fields(plan: NewAgentPlan) -> dict[str, str | None]:
    """The values a template sets on an agent that an update may change."""
    return {
        "instructions": plan.instructions,
        "description": plan.description,
        "icon_url": plan.icon_url,
        "display_name": plan.display_name,
    }


def fingerprints(fields: dict[str, str | None]) -> dict[str, str]:
    return {name: fingerprint(value) for name, value in fields.items()}


def resource_keys(
    text: str, inputs: dict[str, Any], builtins: dict[str, str]
) -> dict[str, str]:
    """Each agent's name as a run creates it, with the key the template gives
    it: a version 2 resource's key, or for an older document the agent's own
    name."""
    if not is_v2_text(text):
        return {}
    compiled = compile_v2(text, inputs, builtins)
    return {name: key for key, name in compiled.names.items()}


def key_of(plan: NewAgentPlan, keys: dict[str, str]) -> str:
    return keys.get(plan.name, plan.name)


def render_agents(
    text: str, inputs: dict[str, Any], builtins: dict[str, str]
) -> dict[str, dict[str, str | None]]:
    """The values `text` sets on each agent it creates, by key, rendered with
    the inputs and builtins a run used.

    Where an agent runs does not change what it is told, so the run's machine
    stands in as the only one, ready for every provider: a machine since
    removed or offline must not stop a later revision from being read.
    """
    machine = str(inputs.get("machine") or "machine")
    machines = [
        {
            "id": machine,
            "name": machine,
            "state": "online",
            "providers": [
                {"provider": provider, "installed": True, "auth": "ok"}
                for provider in provider_ids()
            ],
        }
    ]
    plan = plan_template(text, {}, inputs, builtins=builtins, machines=machines)
    keys = resource_keys(text, inputs, builtins)
    return {key_of(agent, keys): agent_fields(agent) for agent in plan.new_agents}
