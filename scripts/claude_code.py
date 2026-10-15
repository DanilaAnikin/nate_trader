"""Small, non-agent Claude Code adapter for optional research helpers.

The trader must never depend on a hosted LLM API key.  Optional legacy research
commands use the authenticated ``claude -p`` CLI on the homelab instead.  The
CLI is constrained to one turn with tools and settings disabled, so a research
prompt cannot read files, place orders, or mutate the repository.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any


class ClaudeCodeError(RuntimeError):
    """Raised when the authenticated local Claude CLI cannot answer safely."""


def _decode_output(raw: str) -> str:
    text = raw.strip()
    if not text:
        raise ClaudeCodeError("claude_empty_response")
    try:
        value: Any = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(value, dict):
        result = value.get("result")
        if isinstance(result, str) and result.strip():
            return result.strip()
        # Some CLI versions return a plain text field in JSON mode.
        result = value.get("text")
        if isinstance(result, str) and result.strip():
            return result.strip()
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise ClaudeCodeError("claude_unexpected_response")


def query_claude_code(
    prompt: str,
    *,
    system: str = "",
    timeout: int = 120,
) -> str:
    """Run one constrained local Claude Code prompt and return text only."""

    if not isinstance(prompt, str) or not prompt.strip():
        raise ClaudeCodeError("claude_prompt_required")
    binary = shutil.which(os.getenv("CLAUDE_BIN", "claude"))
    if not binary:
        raise ClaudeCodeError("claude_cli_unavailable")
    if type(timeout) is not int or timeout < 1 or timeout > 600:
        raise ClaudeCodeError("claude_timeout_invalid")

    args = [
        binary,
        "-p",
        prompt,
        "--output-format",
        "json",
        "--max-turns",
        "1",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
    ]
    if system:
        args.extend(("--append-system-prompt", system))
    env = os.environ.copy()
    # Never let an unrelated Anthropic API key override the authenticated CLI.
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_BASE_URL", None)
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    try:
        completed = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ClaudeCodeError("claude_cli_failed") from exc
    if completed.returncode != 0:
        raise ClaudeCodeError("claude_cli_failed")
    return _decode_output(completed.stdout)
