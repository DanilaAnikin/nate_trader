"""Exercise the live workflow's operator input and configuration boundary."""

from pathlib import Path
import re
import subprocess

import pytest


WORKFLOW = (
    Path(__file__).resolve().parents[1]
    / ".github/workflows/live-production.yml"
).read_text(encoding="utf-8")


def _step(name: str) -> str:
    """Read a named step without adding a YAML dependency to production."""
    start = WORKFLOW.index(f"      - name: {name}\n")
    end = WORKFLOW.find("\n      - name:", start + 1)
    return WORKFLOW[start:] if end < 0 else WORKFLOW[start:end]


@pytest.mark.parametrize(
    "confirmation, accepted",
    [
        ("TRADE REAL MONEY", True),
        ("", False),
        ("trade real money", False),
        ("TRADE REAL MONEY\n", False),
        ('$(touch injected)', False),
        ('`touch injected`', False),
        ('\" ]; then touch injected; fi; #', False),
    ],
)
def test_confirmation_is_literal_data_not_shell_code(tmp_path, confirmation, accepted):
    step = _step("Require the typed confirmation for an execution")
    assert "LIVE_EXECUTION_CONFIRMATION: ${{ inputs.confirmation }}" in step
    script = step.split("        run: |\n", 1)[1]
    script = "\n".join(line[10:] for line in script.splitlines())
    assert "${{ inputs." not in script
    result = subprocess.run(
        ["/bin/bash", "-c", script],
        cwd=tmp_path,
        env={"LIVE_EXECUTION_CONFIRMATION": confirmation},
        capture_output=True,
        text=True,
        check=False,
    )
    assert (result.returncode == 0) is accepted
    assert not (tmp_path / "injected").exists()


def test_live_offline_sanity_receives_the_same_required_configuration_as_preflight():
    """sanity_check resolves live mode before a broker step ever executes."""
    offline = _step("Verify offline release contract")
    broker = _step("Verify live broker and deployment health")
    expected = {
        "ALPACA_LIVE_API_KEY": "secrets.ALPACA_LIVE_API_KEY",
        "ALPACA_LIVE_SECRET_KEY": "secrets.ALPACA_LIVE_SECRET_KEY",
        "LIVE_TRADING_ENABLED": "vars.LIVE_TRADING_ENABLED",
        "LIVE_TRADING_ACCOUNT_NUMBER": "vars.LIVE_TRADING_ACCOUNT_NUMBER",
        "LIVE_CAPITAL_BUDGET_USD": "vars.LIVE_CAPITAL_BUDGET_USD",
        "LIVE_RUNTIME_KEY": "secrets.LIVE_RUNTIME_KEY",
        "LIVE_MAX_ORDER_NOTIONAL_USD": "vars.LIVE_MAX_ORDER_NOTIONAL_USD",
        "LIVE_MAX_CYCLE_NOTIONAL_USD": "vars.LIVE_MAX_CYCLE_NOTIONAL_USD",
    }
    for key, source in expected.items():
        binding = f"{key}: ${{{{ {source} }}}}"
        assert binding in offline
        assert binding in broker
    assert "run: python scripts/live_runtime_crypto.py run-step sanity" in offline
    assert re.search(r"^  TRADING_MODE: live$", WORKFLOW, re.MULTILINE)


def test_live_execution_remains_manual_and_shares_paper_concurrency():
    assert re.search(r"^  workflow_dispatch:$", WORKFLOW, re.MULTILINE)
    assert not re.search(r"^  (schedule|push|pull_request):", WORKFLOW, re.MULTILINE)
    assert "environment: live-production" in WORKFLOW
    execution = _step("Execute one guarded real-money cycle")
    assert "if: inputs.operation == 'execute'" in execution
    paper = (Path(__file__).resolve().parents[1] / ".github/workflows/paper-production.yml").read_text()
    group = re.search(r"^  group: (.+)$", WORKFLOW, re.MULTILINE).group(1)
    assert f"  group: {group}\n" in paper


def test_live_restore_uses_verified_contract_without_repository_seed(tmp_path):
    step = _step("Restore latest private live runtime-state artifact")
    assert "id: restore_runtime" in step
    assert "LIVE_RUNTIME_BOOTSTRAP: ${{ vars.LIVE_RUNTIME_BOOTSTRAP }}" in step
    assert "LIVE_RUNTIME_KEY: ${{ secrets.LIVE_RUNTIME_KEY }}" in step
    assert "python scripts/restore_live_runtime.py" in step
    assert "unzip" not in step
    assert "release seed" not in step
    script = step.split("        run: |\n", 1)[1]
    script = "\n".join(line[10:] for line in script.splitlines())
    result = subprocess.run(["/bin/bash", "-c", script], cwd=tmp_path,
                            capture_output=True, text=True, check=False)
    assert result.returncode != 0
    assert not (tmp_path / "state").exists()


def test_live_public_outputs_are_encrypted_and_preflight_cannot_upload_runtime():
    for name, command in [
        ("Verify offline release contract", "sanity"),
        ("Verify live broker and deployment health", "preflight"),
        ("Read-only strategy preview", "preview"),
        ("Execute one guarded real-money cycle", "execute"),
    ]:
        step = _step(name)
        assert f"python scripts/live_runtime_crypto.py run-step {command}" in step
        assert "| tee" not in step
        assert "LIVE_RUNTIME_KEY: ${{ secrets.LIVE_RUNTIME_KEY }}" in step
    pack = _step("Encrypt executed live runtime state")
    assert "steps.restore_runtime.outcome == 'success'" in pack
    assert "steps.execute.outcome == 'success'" in pack
    assert "steps.execute.outcome == 'failure'" in pack
    assert "steps.execute.outcome == 'cancelled'" in pack
    assert "!= 'skipped'" not in pack
    upload = _step("Preserve private live runtime state")
    assert "steps.pack_runtime.outcome == 'success'" in upload
    assert "path: live-private/runtime.aesgcm" in upload
    assert "state/performance.json" not in upload
    diagnostics = _step("Preserve encrypted preflight diagnostics")
    assert "path: live-private/diagnostics/*.aesgcm" in diagnostics
    assert "production-preflight.json" not in diagnostics


def test_live_preflight_failure_does_not_create_an_execution_incident():
    incident = _step("Open one operational incident on failure")
    assert "if: failure() && inputs.operation == 'execute'" in incident
