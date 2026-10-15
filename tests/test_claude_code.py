from __future__ import annotations

import json

import claude_code


def test_query_uses_constrained_authenticated_cli_without_api_keys(monkeypatch):
    calls = {}

    class Completed:
        returncode = 0
        stdout = json.dumps({"result": "answer"})
        stderr = ""

    monkeypatch.setattr(claude_code.shutil, "which", lambda _: "/usr/local/bin/claude")

    def fake_run(args, **kwargs):
        calls["args"] = args
        calls["env"] = kwargs["env"]
        return Completed()

    monkeypatch.setattr(claude_code.subprocess, "run", fake_run)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-not-be-forwarded")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://example.invalid")

    assert claude_code.query_claude_code("research AAPL") == "answer"
    assert "--tools" in calls["args"]
    assert calls["args"][calls["args"].index("--tools") + 1] == ""
    assert "--strict-mcp-config" in calls["args"]
    assert "ANTHROPIC_API_KEY" not in calls["env"]
    assert "ANTHROPIC_BASE_URL" not in calls["env"]


def test_query_rejects_empty_or_failed_cli(monkeypatch):
    monkeypatch.setattr(claude_code.shutil, "which", lambda _: "/usr/local/bin/claude")
    with __import__("pytest").raises(claude_code.ClaudeCodeError, match="prompt_required"):
        claude_code.query_claude_code(" ")

    class Failed:
        returncode = 1
        stdout = ""
        stderr = "permission denied"

    monkeypatch.setattr(claude_code.subprocess, "run", lambda *args, **kwargs: Failed())
    with __import__("pytest").raises(claude_code.ClaudeCodeError, match="cli_failed"):
        claude_code.query_claude_code("research")
