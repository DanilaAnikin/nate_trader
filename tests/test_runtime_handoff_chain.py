"""A second approved transfer preserves both earlier execution histories."""

from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace

import execute_trades
import pytest
import restore_paper_runtime as transport
import runtime_handoff as handoff
import strategy_identity
from prepare_runtime_handoff import build_manifest, serialize_manifest

from tests.test_runtime_handoff import SOURCE_IDENTITY, TARGET_SHA, encoded
from tests.test_runtime_handoff import transfer as _transfer_fixture
from tests.test_runtime_restore import FakeGitHub, archive

transfer = _transfer_fixture
NEXT_SHA = "8" * 40
NEXT_IDENTITY = "9" * 64


@pytest.fixture
def chain(transfer):
    files = dict(transfer.files)
    run = handoff.read_object(files["production/last_run.json"])
    run["release_sha"] = TARGET_SHA
    files["production/last_run.json"] = encoded(run)
    files[handoff.MANIFEST_PATH] = transfer.raw
    files.update(
        {
            str(handoff.HANDOFF_DIR / "source" / name): data
            for name, data in transfer.files.items()
        }
    )
    options = {
        "archive_sha256": handoff.digest(archive(files)),
        "source_sha": TARGET_SHA,
        "source_run_id": 321,
        "source_artifact_id": 654,
        "target_sha": NEXT_SHA,
        "target_identity": NEXT_IDENTITY,
        "universe_sha": transfer.universe_sha,
        "account_sha256": transfer.manifest["paper_account_sha256"],
        "prior_manifest_pin": transfer.pin,
        "now": transfer.now,
    }
    manifest = build_manifest(files, **options)
    raw = serialize_manifest(manifest)
    return SimpleNamespace(
        files=files,
        options=options,
        manifest=manifest,
        raw=raw,
        pin=handoff.digest(raw),
        transfer=transfer,
    )


def test_second_hop_is_explicit_and_preserves_original_plan_identity(chain):
    assert chain.manifest["schema_version"] == 2
    assert chain.manifest["source"]["strategy_identity"] == SOURCE_IDENTITY
    assert chain.manifest["source"]["release_sha"] == TARGET_SHA
    assert chain.manifest["target"]["strategy_identity"] == NEXT_IDENTITY
    assert set(chain.manifest["source"]["files"]) == set(handoff.FIRST_HANDOFF_FILES)
    assert handoff.validate_source(chain.manifest, chain.files) == chain.transfer.plan
    assert handoff.prior_source(chain.manifest, chain.files)[1] == chain.transfer.plan


@pytest.mark.parametrize("pin", ["", "0" * 64, "broken"])
def test_prior_pin_is_explicit_external_input_and_cannot_be_self_approved(chain, pin):
    with pytest.raises(handoff.HandoffError):
        build_manifest(chain.files, **{**chain.options, "prior_manifest_pin": pin})


@pytest.mark.parametrize("name", handoff.FIRST_HANDOFF_FILES)
def test_every_source_byte_of_both_generations_is_bound(chain, name):
    files = dict(chain.files)
    files[name] += b"\n"
    with pytest.raises(handoff.HandoffError, match="source_file_integrity"):
        handoff.validate_source(chain.manifest, files)


def _rebind_source(chain, files):
    manifest = deepcopy(chain.manifest)
    manifest["source"]["files"] = {
        name: handoff.digest(raw) for name, raw in files.items()
    }
    return manifest


def test_new_approval_cannot_erase_or_replace_prior_evidence(chain):
    files = dict(chain.files)
    original_path = str(handoff.HANDOFF_DIR / "source" / "performance.json")
    files[original_path] += b"\n"
    with pytest.raises(handoff.HandoffError, match="source_file_integrity"):
        handoff.validate_source(_rebind_source(chain, files), files)


@pytest.mark.parametrize("field", ["paper_account_sha256", "ranking_universe_sha256"])
def test_chained_approval_cannot_change_account_or_universe(chain, field):
    manifest = deepcopy(chain.manifest)
    manifest[field] = "f" * 64
    with pytest.raises(handoff.HandoffError):
        handoff.validate_source(manifest, chain.files)


def test_same_counter_cannot_replace_an_original_broker_id(chain):
    files = dict(chain.files)
    performance = handoff.read_object(files["performance.json"])
    plan = performance["adaptive_rebalance_pending"]
    next(iter(plan["order_attempts"].values()))["order_id"] = "different-broker-order"
    files["performance.json"] = encoded(performance)
    manifest = _rebind_source(chain, files)
    manifest["plan"]["initial_attempts_sha256"] = handoff.canonical_digest(
        plan["order_attempts"]
    )
    with pytest.raises(handoff.HandoffError, match="changed_existing_attempt"):
        handoff.validate_source(manifest, files)


def test_third_hop_is_bounded_and_refused_even_with_recomputed_new_pin(chain):
    files = dict(chain.files)
    old = handoff.read_object(files[handoff.MANIFEST_PATH])
    old["schema_version"] = 2
    files[handoff.MANIFEST_PATH] = encoded(old)
    manifest = _rebind_source(chain, files)
    manifest["prior_handoff"]["manifest_sha256"] = handoff.digest(
        files[handoff.MANIFEST_PATH]
    )
    with pytest.raises(handoff.HandoffError, match="handoff_depth_exceeded"):
        handoff.validate_source(manifest, files)


def test_bootstrap_installs_exact_eleven_bytes_and_native_restore_preserves_them(
    chain, tmp_path
):
    api = FakeGitHub(chain.transfer)
    api.add(TARGET_SHA, chain.files, run_id=321, artifact_id=654, minutes=1)
    assert (
        handoff.digest(api.archives[654]) == chain.manifest["source"]["artifact_sha256"]
    )
    context = transport.Context(
        "owner/private",
        NEXT_SHA,
        NEXT_IDENTITY,
        chain.transfer.universe_sha,
        999,
        chain.pin,
        chain.raw,
    )
    state = tmp_path / "destination"
    now = chain.transfer.now + timedelta(minutes=20)
    assert transport.restore(api, context, state, now=now) == "handoff"
    installed = {
        str(path.relative_to(state)): path.read_bytes()
        for path in state.rglob("*.json")
    }
    assert set(installed) == transport.CHAINED_RUNTIME_FILES
    assert len(installed) == 11
    for name, raw in chain.files.items():
        assert installed[str(handoff.HANDOFF_DIR / "source" / name)] == raw
    assert transport.parse_runtime_zip(archive(installed)) == installed
    assert (
        transport.preserved_handoff(installed, context, now + timedelta(days=10))
        == chain.manifest
    )
    # A genuine target execution changes only its current run, retaining source
    # release/plan/evidence. Subsequent native reads do not expire the bootstrap.
    current_run = handoff.read_object(installed["production/last_run.json"])
    current_run.update(
        release_sha=NEXT_SHA,
        completed_at=(chain.transfer.now + timedelta(minutes=30)).isoformat(),
    )
    installed["production/last_run.json"] = encoded(current_run)
    api.add(NEXT_SHA, installed, run_id=322, artifact_id=655, minutes=30)
    assert (
        transport.restore(api, context, state, now=now + timedelta(days=3)) == "native"
    )
    assert (state / "performance.json").read_bytes() == chain.files["performance.json"]


def test_context_reconciles_both_prior_and_latest_source_before_authorizing(
    chain, monkeypatch
):
    state = chain.transfer.state
    for name in handoff.SOURCE_FILES:
        (state / name).write_bytes(chain.files[name])
    (state / handoff.MANIFEST_PATH).write_bytes(chain.raw)
    for name, raw in chain.files.items():
        path = state / handoff.HANDOFF_DIR / "source" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    monkeypatch.setenv(handoff.MANIFEST_ENV, chain.pin)
    monkeypatch.setenv("APPROVED_RELEASE_SHA", NEXT_SHA)
    monkeypatch.setattr(
        strategy_identity, "build_strategy_identity", lambda: {"value": NEXT_IDENTITY}
    )
    with handoff.paper_handoff_context():
        assert handoff.adoption_matches(
            chain.transfer.plan,
            target_identity=NEXT_IDENTITY,
            universe_sha=chain.transfer.universe_sha,
        )
    assert chain.transfer.broker.gets.count("open_orders") == 4
    assert chain.transfer.broker.mutations == []
    assert not handoff.adoption_matches(
        chain.transfer.plan,
        target_identity=NEXT_IDENTITY,
        universe_sha=chain.transfer.universe_sha,
    )


@pytest.mark.parametrize(
    "name",
    ["performance.json", str(handoff.HANDOFF_DIR / "source" / handoff.MANIFEST_PATH)],
)
def test_partial_eleven_archive_never_falls_back_to_seven(chain, name):
    files = {
        key: value for key, value in chain.files.items() if key in handoff.SOURCE_FILES
    }
    files[handoff.MANIFEST_PATH] = chain.raw
    files.update(
        {
            str(handoff.HANDOFF_DIR / "source" / key): value
            for key, value in chain.files.items()
        }
    )
    del files[name]
    with pytest.raises(transport.RestoreError, match="archive_file_set"):
        transport.parse_runtime_zip(archive(files))


def test_partial_new_generation_cannot_be_restored_as_legacy(chain):
    files = dict(chain.files)
    performance = handoff.read_object(files["performance.json"])
    performance["runtime_generation_id"] = "3ca790db-185d-486c-881a-e0feb5f50f20"
    files["performance.json"] = encoded(performance)
    with pytest.raises(transport.RestoreError, match="runtime_generation_invalid"):
        transport.validate_runtime(files, TARGET_SHA)


@pytest.mark.parametrize(
    "old_status,accepted",
    [("canceled", True), ("expired", True), ("filled", False), ("accepted", False)],
)
def test_second_hop_reconciles_replaced_attempt_and_original_terminal_state(
    chain, old_status, accepted
):
    files = dict(chain.files)
    performance = handoff.read_object(files["performance.json"])
    plan = performance["adaptive_rebalance_pending"]
    intent, record = next(iter(plan["order_attempts"].items()))
    record.update(attempt=2, order_id="second-source-order")
    record["client_order_id"] = execute_trades._execution_client_order_id(
        "adaptive",
        record["symbol"],
        record["side"],
        execution_key=plan["plan_id"],
        intent=f"{intent}|attempt=2",
    )
    files["performance.json"] = encoded(performance)
    manifest = build_manifest(
        files, **{**chain.options, "archive_sha256": handoff.digest(archive(files))}
    )
    original_order = chain.transfer.broker.orders[
        chain.transfer.order["client_order_id"]
    ]
    new_order = deepcopy(original_order)
    original_order.status = old_status
    original_order.filled_qty = original_order.qty if old_status == "filled" else 0
    new_order.id, new_order.client_order_id = (
        record["order_id"],
        record["client_order_id"],
    )
    chain.transfer.broker.orders[new_order.client_order_id] = new_order
    prior, prior_original = handoff.prior_source(manifest, files)
    if accepted:
        handoff.reconcile_broker(chain.transfer.broker, prior, prior_original, plan)
        handoff.reconcile_broker(chain.transfer.broker, manifest, plan, plan)
    else:
        with pytest.raises(handoff.HandoffError):
            handoff.reconcile_broker(chain.transfer.broker, prior, prior_original, plan)
    assert chain.transfer.broker.mutations == []


def test_valid_generation_is_bound_to_owning_source_run_and_raw_bytes(
    chain, monkeypatch
):
    import runtime_generation as generation

    monkeypatch.setenv("APPROVED_RELEASE_SHA", TARGET_SHA)
    monkeypatch.setenv("GITHUB_RUN_ID", "321")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    performance, positions, run = [
        handoff.read_object(chain.files[name]) for name in handoff.SOURCE_FILES
    ]
    performance.update(updated_at="2026-09-14 10:00:00", num_positions=0)
    positions["updated_at"] = performance["updated_at"]
    run["cycle_outcome"] = generation.cycle_outcome("pending", "orders_pending")
    files = {
        **chain.files,
        **generation.prepare_runtime_generation(performance, positions, run),
    }
    manifest = build_manifest(
        files, **{**chain.options, "archive_sha256": handoff.digest(archive(files))}
    )
    assert handoff.validate_source(manifest, files) == chain.transfer.plan
    assert (
        transport.validate_runtime(files, TARGET_SHA)["runtime_generation"][
            "github_run_id"
        ]
        == 321
    )
    transport.generation_run_lineage(files, {"id": 321, "run_attempt": 1})
    with pytest.raises(transport.RestoreError, match="runtime_generation_run"):
        transport.generation_run_lineage(files, {"id": 322, "run_attempt": 1})
    manifest["source"]["run_id"] = 322
    with pytest.raises(handoff.HandoffError, match="source_generation_run"):
        handoff.validate_source(manifest, files)


def test_second_hop_still_refuses_newer_failed_source_attempt(chain, tmp_path):
    api = FakeGitHub(chain.transfer)
    api.add(TARGET_SHA, chain.files, run_id=321, artifact_id=654, minutes=1)
    api.add(
        TARGET_SHA, chain.files, run_id=322, artifact_id=None, failed=True, minutes=10
    )
    context = transport.Context(
        "owner/private",
        NEXT_SHA,
        NEXT_IDENTITY,
        chain.transfer.universe_sha,
        999,
        chain.pin,
        chain.raw,
    )
    state = tmp_path / "unchanged"
    state.mkdir()
    (state / "performance.json").write_bytes(b"sentinel")
    with pytest.raises(
        transport.RestoreError, match="newer_execution_or_unreadable_attempt"
    ):
        transport.restore(
            api, context, state, now=chain.transfer.now + timedelta(minutes=20)
        )
    assert (state / "performance.json").read_bytes() == b"sentinel"
