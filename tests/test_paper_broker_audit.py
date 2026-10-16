from __future__ import annotations

from types import SimpleNamespace

import paper_broker_audit


def test_audit_is_sanitized_and_read_only(monkeypatch):
    calls = []
    monkeypatch.setattr(
        paper_broker_audit,
        "resolve_broker_mode",
        lambda: SimpleNamespace(is_paper=True),
    )
    client = SimpleNamespace(
        _base_url="https://paper-api.alpaca.markets",
        get_account=lambda: SimpleNamespace(status="ACTIVE"),
        get_clock=lambda: SimpleNamespace(
            is_open=False, timestamp="2026-10-16T12:00:00Z"
        ),
        get_all_positions=lambda: [
            SimpleNamespace(symbol="SECRET", qty="2", side="long")
        ],
        get_orders=lambda: [
            SimpleNamespace(
                id="order-secret",
                client_order_id="client-secret",
                symbol="SECRET",
                side="buy",
                status="new",
                qty="2",
            )
        ],
    )
    monkeypatch.setattr(paper_broker_audit, "_client", lambda: client)

    result = paper_broker_audit.audit()

    assert result["result"] == "PASS"
    assert result["position_count"] == 1
    assert result["open_order_count"] == 1
    assert "SECRET" not in str(result)
    assert "order-secret" not in str(result)
    assert "client-secret" not in str(result)
    assert not calls


def test_workflow_is_main_only_and_uses_paper_environment():
    from pathlib import Path

    workflow = Path(".github/workflows/paper-recovery-audit.yml").read_text()
    assert "if: github.ref == 'refs/heads/main'" in workflow
    assert "environment: paper-production" in workflow
    assert "python scripts/paper_broker_audit.py" in workflow
    assert "gh api" not in workflow
