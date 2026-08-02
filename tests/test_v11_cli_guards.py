from __future__ import annotations

from types import SimpleNamespace

import pytest

from backtest import run


@pytest.mark.parametrize(
    ("command", "handler"),
    [
        ("sweep", run.cmd_sweep),
        ("walk-forward", run.cmd_walk_forward),
        ("compare", run.cmd_compare),
    ],
)
def test_legacy_optimizers_refuse_to_claim_v11_results(command, handler, capsys):
    with pytest.raises(SystemExit) as exc:
        handler(SimpleNamespace())

    assert exc.value.code == 2
    output = capsys.readouterr().err
    assert command in output
    assert "validate_v11.py" in output
