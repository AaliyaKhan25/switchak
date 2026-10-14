"""Templates that come with Switch: served on every workspace from the
package, the document chosen by the agent_management flag, never changed."""

from __future__ import annotations

from pathlib import Path

import yaml

from switch_core.official_templates import (
    official_template,
    official_templates,
)
from switch_core.template_lint import lint_template

_REPO = Path(__file__).resolve().parents[3]
_PACKAGED = _REPO / "core" / "switch_core" / "official_templates"


def test_the_switch_expert_copies_match_the_repository():
    """The package carries copies of switch-expert/ at the repository root;
    an edit to one side must reach the other."""
    for name in ("template.yaml", "template.console.yaml", "AGENT.md"):
        assert (_PACKAGED / "switch-expert" / name).read_text() == (
            _REPO / "switch-expert" / name
        ).read_text(), (
            f"core/switch_core/official_templates/switch-expert/{name} is stale"
        )


def test_the_flag_picks_the_document():
    managed = official_template("official:switch-expert", agent_management=True)
    console = official_template("official:switch-expert", agent_management=False)
    assert managed is not None and console is not None
    assert yaml.safe_load(managed.content)["version"] == 2
    assert yaml.safe_load(console.content)["version"] == 1


def test_the_instructions_are_written_in_and_the_documents_are_clean():
    for flag in (True, False):
        (template,) = official_templates(flag)
        data = yaml.safe_load(template.content)
        agent = data["resources"]["expert"] if "resources" in data else data["agent"]
        assert len(agent["instructions"]) > 1000
        result = lint_template(template.content)
        assert result.errors == [] and result.warnings == []


def test_an_unknown_official_id_is_none():
    assert official_template("official:nope", agent_management=True) is None
