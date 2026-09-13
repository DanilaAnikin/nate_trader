"""The approved transfer preserves intent; a failed transfer cannot trade."""

import io
import json
import shutil
import stat
import zipfile
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import execute_trades
import pytest
import runtime_handoff as handoff
import strategy_identity
import trade
import universe
import utils

from tests.test_execution_safety import (
    _bind_open_order_to_plan,
    _open_order,
    _patch_adaptive_runtime,
    _pending_plan,
)

SOURCE_SHA = "1" * 40
TARGET_SHA = "2" * 40
SOURCE_IDENTITY = "a" * 64
TARGET_IDENTITY = "b" * 64
ACCOUNT_ID = "12345678-1234-4234-8234-123456789abc"


def encoded(value):
    return json.dumps(value, sort_keys=True, indent=2).encode()


class ReadOnlyBroker:
    _base_url = "https://paper-api.alpaca.markets"

    def __init__(self, orders):
        self.orders = {
            order["client_order_id"]: SimpleNamespace(**deepcopy(order))
            for order in orders
        }
        self.extra = []
        self.account_id = ACCOUNT_ID
        self.gets = []
        self.mutations = []

    def get_account(self):
        self.gets.append("account")
        return SimpleNamespace(
            id=self.account_id,
            status="ACTIVE",
            account_blocked=False,
            trading_blocked=False,
            trade_suspended_by_user=False,
        )

    def get_all_positions(self):
        self.gets.append("positions")
        return []

    def get_orders(self, *, filter):
        self.gets.append("open_orders")
        return [
            order for order in self.orders.values() if order.status in handoff._ACTIVE
        ] + self.extra

    def get_order_by_client_id(self, client_id):
        self.gets.append("known_order")
        return self.orders[client_id]

    def __getattr__(self, name):
        if name in {
            "submit_order",
            "cancel_order_by_id",
            "cancel_orders",
            "close_position",
        }:

            def forbidden(*args, **kwargs):
                self.mutations.append(name)
                raise AssertionError("handoff attempted broker mutation")

            return forbidden
        raise AttributeError(name)


@pytest.fixture
def transfer(monkeypatch, tmp_path):
    now = datetime.now(timezone.utc)
    monkeypatch.setattr(universe, "load_universe_symbols", lambda **kwargs: ["AAA"])
    universe_sha = strategy_identity.hash_symbol_universe(["AAA"])
    monkeypatch.setattr(
        strategy_identity, "build_strategy_identity", lambda: {"value": SOURCE_IDENTITY}
    )
    plan = _pending_plan({"AAA": 0.09})
    order = _open_order(
        order_id="original-order", symbol="AAA", side="buy", quantity=90
    )
    _bind_open_order_to_plan(plan, order, target_weight=0.09)
    performance = {
        "adaptive_rebalance_pending": plan,
        "risk_history": ["unchanged sentinel"],
    }
    last_run = {
        "schema_version": 1,
        "kind": "v11_paper_production_run",
        "paper_only": True,
        "status": "PASS",
        "release_sha": SOURCE_SHA,
        "completed_at": now.isoformat(),
    }
    files = {
        "performance.json": encoded(performance),
        "positions.json": encoded({"positions": []}),
        "production/last_run.json": encoded(last_run),
    }
    manifest = {
        "schema_version": 1,
        "kind": "v11_paper_runtime_handoff",
        "source": {
            "release_sha": SOURCE_SHA,
            "strategy_identity": SOURCE_IDENTITY,
            "run_id": 123,
            "artifact_id": 456,
            "artifact_sha256": "e" * 64,
            "files": {name: handoff.digest(raw) for name, raw in files.items()},
        },
        "target": {"release_sha": TARGET_SHA, "strategy_identity": TARGET_IDENTITY},
        "paper_account_sha256": handoff.account_digest(ACCOUNT_ID),
        "ranking_universe_sha256": universe_sha,
        "plan": {
            "plan_id": plan["plan_id"],
            "immutable_sha256": handoff.immutable_plan_digest(plan),
            "initial_attempts_sha256": handoff.canonical_digest(plan["order_attempts"]),
            "rebalance_month": plan["rebalance_month"],
        },
        "issued_at": (now - timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
        "expires_at": (now + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
    }
    raw = encoded(manifest)
    pin = handoff.digest(raw)
    for name, content in files.items():
        for base in (tmp_path, tmp_path / handoff.HANDOFF_DIR / "source"):
            path = base / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    (tmp_path / handoff.HANDOFF_DIR / "manifest.json").write_bytes(raw)
    monkeypatch.setenv(handoff.MANIFEST_ENV, pin)
    monkeypatch.setenv("APPROVED_RELEASE_SHA", TARGET_SHA)
    monkeypatch.setenv("TRADING_MODE", "paper")
    monkeypatch.setattr(utils, "STATE_DIR", tmp_path)
    monkeypatch.setattr(
        strategy_identity, "build_strategy_identity", lambda: {"value": TARGET_IDENTITY}
    )
    broker = ReadOnlyBroker([order])
    monkeypatch.setattr(trade, "_client", broker)
    return SimpleNamespace(
        manifest=manifest,
        raw=raw,
        pin=pin,
        files=files,
        plan=plan,
        performance=performance,
        order=order,
        broker=broker,
        state=tmp_path,
        universe_sha=universe_sha,
        now=now,
    )


def validated(fixture, raw=None, **overrides):
    options = {
        "target_sha": TARGET_SHA,
        "target_identity": TARGET_IDENTITY,
        "universe_sha": fixture.universe_sha,
        "bootstrap": True,
        "now": fixture.now,
    }
    options.update(overrides)
    return handoff.validate_manifest(raw or fixture.raw, fixture.pin, **options)


def test_pinned_transfer_preserves_every_original_byte_and_provenance(transfer):
    manifest = validated(transfer)
    assert (
        handoff.validate_source(manifest, transfer.files, bootstrap=True)
        == transfer.plan
    )
    before = {path: path.read_bytes() for path in transfer.state.rglob("*.json")}
    assert not execute_trades._valid_adaptive_pending_plan(transfer.plan)
    with handoff.paper_handoff_context():
        assert execute_trades._valid_adaptive_pending_plan(transfer.plan)
    assert not execute_trades._valid_adaptive_pending_plan(transfer.plan)
    assert {
        path: path.read_bytes() for path in transfer.state.rglob("*.json")
    } == before
    assert transfer.broker.mutations == []
    assert transfer.broker.gets.count("open_orders") == 2
    assert (
        handoff.read_object(transfer.files["production/last_run.json"])["release_sha"]
        == SOURCE_SHA
    )


@pytest.mark.parametrize(
    "invalid",
    ["pin", "target_sha", "target_identity", "universe_sha", "expired", "future"],
)
def test_external_approval_and_exact_target_are_required(transfer, invalid):
    options = {}
    raw = transfer.raw
    if invalid == "pin":
        raw += b"\n"
    elif invalid in {"target_sha", "target_identity", "universe_sha"}:
        options[invalid] = "f" * (40 if invalid == "target_sha" else 64)
    else:
        options["now"] = transfer.now + timedelta(
            days=2 if invalid == "expired" else -2
        )
    with pytest.raises(handoff.HandoffError):
        validated(transfer, raw, **options)


@pytest.mark.parametrize(
    "invalid",
    ["performance.json", "positions.json", "production/last_run.json", "missing"],
)
def test_source_bytes_cannot_be_rewritten_or_omitted(transfer, invalid):
    files = dict(transfer.files)
    if invalid == "missing":
        del files["positions.json"]
    else:
        files[invalid] += b"\n"
    with pytest.raises(handoff.HandoffError):
        handoff.validate_source(transfer.manifest, files)


def test_bootstrap_deadline_does_not_expire_an_already_adopted_plan(transfer):
    validated(transfer, now=transfer.now + timedelta(days=2), bootstrap=False)
    with pytest.raises(handoff.HandoffError, match="source_run_stale"):
        handoff.validate_source(
            transfer.manifest,
            transfer.files,
            bootstrap=True,
            now=transfer.now + timedelta(days=5),
        )


@pytest.mark.parametrize(
    "invalid",
    [
        "missing_pin",
        "missing_manifest",
        "missing_source",
        "missing_runtime",
        "live",
        "plan_tamper",
        "attempt_removed",
    ],
)
def test_rejected_handoff_cannot_enter_any_execution_branch(
    monkeypatch, transfer, invalid
):
    if invalid == "missing_pin":
        monkeypatch.delenv(handoff.MANIFEST_ENV)
    elif invalid == "missing_manifest":
        (transfer.state / handoff.HANDOFF_DIR / "manifest.json").unlink()
    elif invalid == "missing_source":
        (transfer.state / handoff.HANDOFF_DIR / "source/positions.json").unlink()
    elif invalid == "missing_runtime":
        (transfer.state / "performance.json").unlink()
    elif invalid == "live":
        # No live credentials are needed: this test must refuse before broker reads.
        monkeypatch.setenv("TRADING_MODE", "live")
    else:
        perf = deepcopy(transfer.performance)
        if invalid == "plan_tamper":
            perf["adaptive_rebalance_pending"]["target_weights"]["AAA"] = 0.08
        else:
            perf["adaptive_rebalance_pending"]["order_attempts"] = {}
        (transfer.state / "performance.json").write_bytes(encoded(perf))
    entered = []
    monkeypatch.setattr(
        execute_trades,
        "_capture_execution_risk_snapshot",
        lambda: entered.append("risk"),
    )
    monkeypatch.setattr(
        execute_trades,
        "_run_execution_with_risk_snapshot",
        lambda **kwargs: entered.append("execute"),
    )
    with pytest.raises(RuntimeError):
        execute_trades.run_execution(dry_run=True)
    assert entered == []
    assert transfer.broker.mutations == []


@pytest.mark.parametrize(
    "invalid",
    [
        "account",
        "endpoint",
        "unknown_order",
        "missing_order",
        "qty",
        "side",
        "symbol",
        "broker_id",
        "client_id",
        "pending_cancel",
        "pending_replace",
        "unknown_status",
        "fill_race",
        "positions_race",
        "short",
    ],
)
def test_broker_ambiguity_is_read_only_refusal(transfer, invalid):
    broker = transfer.broker
    order = broker.orders[transfer.order["client_order_id"]]
    if invalid == "account":
        broker.account_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    elif invalid == "endpoint":
        broker._base_url = "https://api.alpaca.markets"
    elif invalid == "unknown_order":
        extra = deepcopy(order)
        extra.id = "unbound-broker-id"
        extra.client_order_id = "unbound-client-id"
        broker.extra.append(extra)
    elif invalid == "missing_order":
        broker.get_order_by_client_id = lambda key: None
    elif invalid in {"qty", "side", "symbol", "broker_id", "client_id"}:
        field, value = {
            "qty": ("qty", 91),
            "side": ("side", "sell"),
            "symbol": ("symbol", "OTHER"),
            "broker_id": ("id", "wrong-order"),
            "client_id": ("client_order_id", "wrong-client"),
        }[invalid]
        setattr(order, field, value)
    elif invalid == "fill_race":
        original_get = broker.get_orders

        def changed(*, filter):
            if broker.gets.count("open_orders") == 1:
                order.status, order.filled_qty = "filled", order.qty
            return original_get(filter=filter)

        broker.get_orders = changed
    elif invalid == "short":
        broker.get_all_positions = lambda: [
            SimpleNamespace(symbol="AAA", qty=-1, side="short")
        ]
    elif invalid == "positions_race":
        positions = iter([[], [SimpleNamespace(symbol="AAA", qty=1, side="long")]])
        broker.get_all_positions = lambda: next(positions)
    else:
        order.status = invalid
    with pytest.raises(handoff.HandoffError), handoff.paper_handoff_context():
        pytest.fail("ambiguous broker state authorized execution")
    assert broker.mutations == []


def test_early_buy_preflight_and_later_manager_keep_same_adopted_plan(
    monkeypatch, transfer
):
    import adaptive_momentum

    _patch_adaptive_runtime(monkeypatch, perf=transfer.performance)
    monkeypatch.setattr(trade, "list_open_orders", lambda: [transfer.order])
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda *a: pytest.fail("adopted BUY was cancelled")
    )
    monkeypatch.setattr(
        trade, "place_limit_order", lambda *a, **k: pytest.fail("duplicate order")
    )
    monkeypatch.setattr(
        adaptive_momentum,
        "build_target_portfolio",
        lambda *a, **k: pytest.fail("frozen plan was reranked"),
    )
    frozen = deepcopy(transfer.plan)
    with handoff.paper_handoff_context():
        assert (
            execute_trades._reconcile_v11_open_buys_preflight(
                dry_run=False, allow_new_exposure=True
            )
            == []
        )
        result = execute_trades._manage_adaptive_momentum_picks(
            dry_run=False, allow_new_exposure=True
        )
    assert any(item["action"] == "REBALANCE_PENDING_BUYS" for item in result)
    assert transfer.performance["adaptive_rebalance_pending"] == frozen
    assert "last_momentum_rebal_ym" not in transfer.performance


def test_filled_original_order_completes_without_reranking_or_resubmission(
    monkeypatch, transfer
):
    import adaptive_momentum

    original = transfer.broker.orders[transfer.order["client_order_id"]]
    original.status, original.filled_qty = "filled", original.qty
    position = {"symbol": "AAA", "qty": 90, "current_price": 100, "market_value": 9000}
    _patch_adaptive_runtime(
        monkeypatch, perf=transfer.performance, positions=[position]
    )
    monkeypatch.setattr(trade, "list_open_orders", list)
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: pytest.fail("duplicate filled order"),
    )
    monkeypatch.setattr(
        adaptive_momentum,
        "build_target_portfolio",
        lambda *a, **k: pytest.fail("reranked"),
    )
    with handoff.paper_handoff_context():
        result = execute_trades._manage_adaptive_momentum_picks(
            dry_run=False, allow_new_exposure=True
        )
    assert result[-1]["action"] == "ADAPTIVE_REBALANCE_COMPLETE"
    assert (
        transfer.performance["last_momentum_rebal_ym"]
        == transfer.plan["rebalance_month"]
    )
    assert (
        transfer.performance["last_momentum_signal_date"]
        == transfer.plan["signal_date"]
    )
    assert (
        transfer.performance["last_momentum_targets"] == transfer.plan["target_weights"]
    )
    for name, original_bytes in transfer.files.items():
        assert (
            transfer.state / handoff.HANDOFF_DIR / "source" / name
        ).read_bytes() == original_bytes


@pytest.mark.parametrize("gate", ["closed", "CAUTIOUS", "HALT"])
def test_adoption_never_overrides_closed_exposure_gate(monkeypatch, transfer, gate):
    _patch_adaptive_runtime(
        monkeypatch,
        perf=transfer.performance,
        risk_tier="NORMAL" if gate == "closed" else gate,
    )
    snapshots = iter([[transfer.order], []])
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots, []))
    cancelled = []
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda value: cancelled.append(value)
    )
    with handoff.paper_handoff_context():
        result = execute_trades._reconcile_v11_open_buys_preflight(
            dry_run=False, allow_new_exposure=gate != "closed"
        )
    assert cancelled == [transfer.order["id"]]
    assert result


def test_pin_cannot_authorize_different_plan_or_changed_universe(transfer):
    with handoff.paper_handoff_context():
        changed = deepcopy(transfer.plan)
        changed["signal_date"] = "2000-01-01"
        assert not handoff.adoption_matches(
            changed, target_identity=TARGET_IDENTITY, universe_sha=transfer.universe_sha
        )
        assert not handoff.adoption_matches(
            transfer.plan, target_identity="c" * 64, universe_sha=transfer.universe_sha
        )
        assert not handoff.adoption_matches(
            transfer.plan, target_identity=TARGET_IDENTITY, universe_sha="c" * 64
        )


def test_context_is_cleared_after_failed_execution(transfer):
    with (
        pytest.raises(RuntimeError, match="simulated execution failure"),
        handoff.paper_handoff_context(),
    ):
        assert execute_trades._valid_adaptive_pending_plan(transfer.plan)
        raise RuntimeError("simulated execution failure")
    assert not execute_trades._valid_adaptive_pending_plan(transfer.plan)


def test_private_broker_error_is_not_exposed(transfer):
    def failed(*args, **kwargs):
        raise ValueError("credential/account/financial sentinel")

    transfer.broker.get_account = failed
    with pytest.raises(handoff.HandoffError) as error, handoff.paper_handoff_context():
        pass
    assert "sentinel" not in str(error.value)
    assert error.value.__suppress_context__


@pytest.mark.parametrize("status", ["accepted", "filled", "absent"])
def test_restart_reconciles_new_reserved_attempt_without_rewriting_or_resubmitting(
    monkeypatch, transfer, status
):
    # The source attempt was canceled. The target run reserved attempt #2,
    # then crashed before recording a response. Its original snapshot stays #1.
    source = transfer.broker.orders[transfer.order["client_order_id"]]
    source.status = "canceled"
    current = deepcopy(transfer.performance)
    plan = current["adaptive_rebalance_pending"]
    intent, record = next(iter(plan["order_attempts"].items()))
    record.update(attempt=2, status="reserved")
    record.pop("order_id")
    record["client_order_id"] = execute_trades._execution_client_order_id(
        "adaptive",
        record["symbol"],
        record["side"],
        execution_key=plan["plan_id"],
        intent=f"{intent}|attempt=2",
    )
    new_order = deepcopy(source)
    new_order.id, new_order.client_order_id = "new-order", record["client_order_id"]
    new_order.status = "filled" if status == "filled" else "accepted"
    new_order.filled_qty = new_order.qty if status == "filled" else 0
    transfer.broker.orders[new_order.client_order_id] = new_order
    (transfer.state / "performance.json").write_bytes(encoded(current))
    if status == "absent":
        del transfer.broker.orders[new_order.client_order_id]
        original_get = transfer.broker.get_order_by_client_id

        def get_order(key):
            if key == new_order.client_order_id:
                error = RuntimeError("not found")
                error.status_code = 404
                raise error
            return original_get(key)

        transfer.broker.get_order_by_client_id = get_order
    before = (transfer.state / "performance.json").read_bytes()
    with handoff.paper_handoff_context():
        assert execute_trades._valid_adaptive_pending_plan(plan)
        if status != "absent":
            monkeypatch.setattr(
                trade,
                "get_order_by_client_order_id",
                lambda key: trade._order_lifecycle_view(new_order),
            )
            # Existing executor semantics consume the preserved reservation.
            client_id, disposition = execute_trades._reserve_adaptive_client_order_id(
                current,
                plan,
                symbol=record["symbol"],
                side=record["side"],
                quantity=record["quantity"],
                target_weight=record["target_weight"],
            )
            assert client_id is None
            assert disposition == (
                "FILLED_AWAITING_POSITION_REFRESH"
                if status == "filled"
                else "PENDING_ORDER"
            )
    assert (transfer.state / "performance.json").read_bytes() == before
    assert transfer.broker.mutations == []
    assert (
        transfer.state / handoff.HANDOFF_DIR / "source/performance.json"
    ).read_bytes() == transfer.files["performance.json"]


def test_original_404_is_never_treated_as_unsubmitted_reservation(transfer):
    def missing(key):
        error = RuntimeError("not found")
        error.status_code = 404
        raise error

    transfer.broker.get_order_by_client_id = missing
    with pytest.raises(handoff.HandoffError), handoff.paper_handoff_context():
        pytest.fail("lost original order authorized")


def test_prepare_derives_manifest_without_changing_history(transfer):
    from prepare_runtime_handoff import build_manifest, serialize_manifest

    manifest = build_manifest(
        transfer.files,
        archive_sha256="e" * 64,
        source_sha=SOURCE_SHA,
        source_run_id=123,
        source_artifact_id=456,
        target_sha=TARGET_SHA,
        target_identity=TARGET_IDENTITY,
        universe_sha=transfer.universe_sha,
        account_sha256=handoff.account_digest(ACCOUNT_ID),
        now=transfer.now,
    )
    raw = serialize_manifest(manifest)
    assert not raw.endswith(b"\n")
    assert manifest["source"]["files"] == transfer.manifest["source"]["files"]
    assert manifest["plan"] == transfer.manifest["plan"]
    # Weekend approval remains usable for the next scheduled cycle, with a
    # distinct bounded source freshness check still required at restore time.
    handoff.validate_manifest(
        raw,
        handoff.digest(raw),
        target_sha=TARGET_SHA,
        target_identity=TARGET_IDENTITY,
        universe_sha=transfer.universe_sha,
        bootstrap=True,
        now=transfer.now + timedelta(hours=36),
    )
    with pytest.raises(handoff.HandoffError, match="bootstrap_expired"):
        handoff.validate_manifest(
            raw,
            handoff.digest(raw),
            target_sha=TARGET_SHA,
            target_identity=TARGET_IDENTITY,
            universe_sha=transfer.universe_sha,
            bootstrap=True,
            now=transfer.now + timedelta(hours=49),
        )


def test_removing_pin_and_evidence_cannot_replan_an_old_identity(monkeypatch, transfer):
    monkeypatch.delenv(handoff.MANIFEST_ENV)
    shutil.rmtree(transfer.state / handoff.HANDOFF_DIR)
    monkeypatch.setattr(
        execute_trades,
        "_capture_execution_risk_snapshot",
        lambda: pytest.fail("execution entered"),
    )
    with pytest.raises(handoff.HandoffError, match="unapproved_carried_plan"):
        execute_trades.run_execution(dry_run=True)


def test_fifteen_attempts_and_ten_targets_survive_read_only_adoption(
    monkeypatch, transfer
):
    from prepare_runtime_handoff import build_manifest, serialize_manifest

    symbols = [f"STOCK{i}" for i in range(10)]
    monkeypatch.setattr(universe, "load_universe_symbols", lambda **kwargs: symbols)
    universe_sha = strategy_identity.hash_symbol_universe(symbols)
    monkeypatch.setattr(
        strategy_identity, "build_strategy_identity", lambda: {"value": SOURCE_IDENTITY}
    )
    plan = _pending_plan({symbol: 0.09 for symbol in symbols})
    orders = []
    for index in range(15):
        buy = index < 10
        order = _open_order(
            order_id=f"broker-{index}",
            symbol=symbols[index] if buy else f"OLD{index}",
            side="buy" if buy else "sell",
            quantity=10,
            status="accepted" if buy else "filled",
            filled=0 if buy else 10,
        )
        _bind_open_order_to_plan(plan, order, target_weight=0.09 if buy else 0.0)
        orders.append(order)
    files = {
        **transfer.files,
        "performance.json": encoded(
            {
                "adaptive_rebalance_pending": plan,
                "performance_baseline": {"epoch": "historical-epoch-unchanged"},
            }
        ),
    }
    manifest = build_manifest(
        files,
        archive_sha256="e" * 64,
        source_sha=SOURCE_SHA,
        source_run_id=123,
        source_artifact_id=456,
        target_sha=TARGET_SHA,
        target_identity=TARGET_IDENTITY,
        universe_sha=universe_sha,
        account_sha256=handoff.account_digest(ACCOUNT_ID),
    )
    raw = serialize_manifest(manifest)
    for name, data in files.items():
        (transfer.state / name).write_bytes(data)
        (transfer.state / handoff.HANDOFF_DIR / "source" / name).write_bytes(data)
    (transfer.state / handoff.HANDOFF_DIR / "manifest.json").write_bytes(raw)
    monkeypatch.setenv(handoff.MANIFEST_ENV, handoff.digest(raw))
    monkeypatch.setattr(
        strategy_identity, "build_strategy_identity", lambda: {"value": TARGET_IDENTITY}
    )
    broker = ReadOnlyBroker(orders)
    monkeypatch.setattr(trade, "_client", broker)
    before = {path: path.read_bytes() for path in transfer.state.rglob("*.json")}
    with handoff.paper_handoff_context():
        assert execute_trades._valid_adaptive_pending_plan(plan)
    assert len(plan["order_attempts"]) == 15
    assert len(plan["target_weights"]) == 10
    assert broker.gets.count("known_order") == 15
    assert {
        path: path.read_bytes() for path in transfer.state.rglob("*.json")
    } == before
    assert broker.mutations == []


def test_prepare_writes_only_private_manifest_and_never_approves(
    monkeypatch, transfer, tmp_path
):
    import prepare_runtime_handoff as prepare

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zipped:
        for name, content in transfer.files.items():
            zipped.writestr(name, content)
    calls = []
    monkeypatch.setattr(prepare, "_private_tmpfs", lambda path, **kwargs: None)
    monkeypatch.setattr(
        prepare.subprocess, "check_output", lambda *args, **kwargs: TARGET_SHA
    )
    monkeypatch.setattr(
        prepare.subprocess, "run", lambda args, **kwargs: calls.append(args)
    )
    monkeypatch.setattr(
        execute_trades, "_v11_validation_gate", lambda: {"passed": True}
    )
    args = SimpleNamespace(
        source_zip="-",
        source_sha=SOURCE_SHA,
        source_run_id=123,
        source_artifact_id=456,
        target_sha=TARGET_SHA,
        output=tmp_path / "prepared.json",
    )
    result = prepare.prepare(args, stdin=io.BytesIO(archive.getvalue()))
    raw = args.output.read_bytes()
    assert result["result"] == "PASS"
    assert result["manifest_sha256"] == handoff.digest(raw)
    assert stat.S_IMODE(args.output.stat().st_mode) == 0o600
    assert all(command[0] == "git" for command in calls)
    assert ACCOUNT_ID.encode() not in raw
    assert b"unchanged sentinel" not in raw
    assert transfer.broker.mutations == []
    with pytest.raises(FileExistsError):
        prepare.prepare(args, stdin=io.BytesIO(archive.getvalue()))
    assert args.output.read_bytes() == raw


@pytest.mark.parametrize(
    "case,accepted",
    [
        ("arbitrary", False),
        ("identity_rewrite", False),
        ("missing_run", False),
        ("HALT", True),
        ("CAUTIOUS", True),
        ("completed", True),
        ("completed_then_failed", True),
        ("disappeared", False),
    ],
)
def test_native_successor_requires_real_transition_evidence(transfer, case, accepted):
    # A target SHA record proves the target ran, but alone cannot authorize a
    # different ranking in the source plan's still-unfinished month.
    performance = deepcopy(transfer.performance)
    original = transfer.plan
    weights = {} if case == "HALT" else {"AAA": 0.045 if case == "CAUTIOUS" else 0.09}
    current = execute_trades._new_adaptive_pending_plan(
        rebalance_month=original["rebalance_month"],
        signal_date="2000-01-01" if case == "arbitrary" else original["signal_date"],
        target_weights=weights,
        sector_by_symbol={symbol: "Technology" for symbol in weights},
        risk_off=case == "HALT",
        eligible_count=len(weights),
        construction_risk_tier="CAUTIOUS" if case == "CAUTIOUS" else "NORMAL",
    )
    performance["adaptive_rebalance_pending"] = current
    if case == "HALT":
        performance["adaptive_risk_off_latched"] = True
    if case in {"completed", "completed_then_failed"}:
        performance.update(
            last_momentum_rebal_ym=original["rebalance_month"],
            last_momentum_signal_date=original["signal_date"],
            last_momentum_targets=original["target_weights"],
        )
    if case in {"completed_then_failed", "disappeared"}:
        performance.pop("adaptive_rebalance_pending")
    (transfer.state / "performance.json").write_bytes(encoded(performance))
    last_run_path = transfer.state / "production/last_run.json"
    last_run = handoff.read_object(transfer.files["production/last_run.json"])
    last_run.update(
        release_sha=TARGET_SHA,
        status="FAIL" if case == "completed_then_failed" else "PASS",
    )
    last_run_path.write_bytes(encoded(last_run))
    if case == "missing_run":
        last_run_path.unlink()
    if accepted:
        with handoff.paper_handoff_context():
            # Native successors use the ordinary identity rule; they do not
            # receive an authorization to resurrect the original risk-on plan.
            assert not handoff.adoption_matches(
                original,
                target_identity=TARGET_IDENTITY,
                universe_sha=transfer.universe_sha,
            )
    else:
        with pytest.raises(handoff.HandoffError), handoff.paper_handoff_context():
            pytest.fail("unfinished plan was silently replaced")
    assert transfer.broker.mutations == []


def test_native_month_rollover_is_bounded_by_current_month(transfer):
    current_month = datetime.now(timezone.utc).strftime("%Y-%m")
    first_day = datetime.now(timezone.utc).replace(day=1)
    previous_month = (first_day - timedelta(days=1)).strftime("%Y-%m")
    original, current = deepcopy(transfer.plan), deepcopy(transfer.plan)
    original["rebalance_month"] = previous_month
    current["rebalance_month"] = current_month
    assert handoff._native_successor_allowed(current, original, {})
    current["rebalance_month"] = "2100-01"
    assert not handoff._native_successor_allowed(current, original, {})
