"""Baseline review, atomic bundle and evidence contracts for database upgrades."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

PATH = Path(__file__).resolve().parents[1] / "supabase/upgrade/runner.py"
SPEC = importlib.util.spec_from_file_location("database_upgrade_runner", PATH)
upgrade = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upgrade)


def snapshot(objects=None, stage="reference-0008"):
    objects = objects or {"routine:public.subject()": {"definition": "known", "acl": []}}
    catalog = {"schema_version": 1, "objects": objects,
        "object_count": len(objects), "unique_object_count": len(objects),
        "server": {"database": "postgres", "role": "postgres", "version_num": "170006",
                   "vault_references": True, "public_create": True, "database_create": True}}
    return {"schema_version": 1, "stage": stage, "catalog": catalog,
        "catalog_sha256": upgrade.json_hash(catalog),
        "catalog_query_sha256": upgrade.digest(upgrade.CATALOG.read_bytes()),
        "migration_sources": upgrade.file_manifest()}


def reviewed(reference, observed):
    result = upgrade.proposed_review(reference, observed)
    result.update(status="REVIEWED", reviewer="fixture-reviewer",
                  reference_provenance="Fixture reference; deliberately non-production")
    for delta in result["deltas"]:
        delta.update(disposition="replaced-by-authored-migrations", reason="Fixture ACL change replaced by 0015")
    return result


def test_catalog_review_detects_definition_and_acl_drift_without_publishing_them():
    ref = snapshot()
    changed = snapshot({"routine:public.subject()": {"definition": "embedded-sensitive-canary", "acl": ["anon"]}}, "observed")
    review = upgrade.proposed_review(ref, changed)
    assert len(review["deltas"]) == 1
    assert "embedded-sensitive-canary" not in json.dumps(review)
    assert review["status"] == "UNREVIEWED"
    with pytest.raises(ValueError, match="reviewed"):
        upgrade.validate_review(ref, changed, review)


@pytest.mark.parametrize("tamper", ["omit", "wrong-hash", "reason", "disposition"])
def test_review_requires_every_exact_delta_and_its_reason(tamper):
    ref = snapshot()
    changed = snapshot({"routine:public.subject()": {"definition": "changed"}}, "observed")
    review = reviewed(ref, changed)
    if tamper == "omit": review["deltas"] = []
    elif tamper == "wrong-hash": review["deltas"][0]["observed_sha256"] = "0" * 64
    elif tamper == "reason": review["deltas"][0]["reason"] = ""
    else: review["deltas"][0]["disposition"] = "allow-all"
    with pytest.raises(ValueError):
        upgrade.validate_review(ref, changed, review)


@pytest.mark.parametrize("statement", ["COMMIT;", "BEGIN;", "rollback;", "vacuum accounts;", "\\i other.sql", "create index concurrently example on accounts(id);"])
def test_authored_migrations_cannot_escape_the_atomic_transaction(statement):
    with pytest.raises(ValueError):
        upgrade.assert_transaction_safe(statement)


def test_sql_bodies_and_comments_do_not_look_like_transaction_escape():
    upgrade.assert_transaction_safe("-- COMMIT;\ndo $body$ begin raise notice 'COMMIT'; end $body$; /* BEGIN; */")
    for path in upgrade.migration_files():
        upgrade.assert_transaction_safe(path.read_text())


def test_bundle_records_only_actual_new_migrations_and_unknown_history():
    ref = snapshot()
    observed = snapshot(stage="observed")
    bundle, manifest = upgrade.build_bundle(ref, observed, reviewed(ref, observed),
        database="postgres", role="postgres", recovery_sha256="a" * 64, purpose="rehearsal")
    text = bundle.decode()
    assert "unknown; no historical execution attested" in text
    assert "create schema supabase_migrations" not in text
    assert text.count("insert into nate_migrations.applied_migrations(") == 15
    assert text.index("begin;") < text.index("create schema nate_migrations") < text.rindex("commit;")
    assert "pg_try_advisory_xact_lock" in text
    assert text.index("end $nt_ledger$;") < text.index("notify pgrst,'reload schema';") < text.rindex("commit;")
    assert "Catalog changed while acquiring the deployment locks" in text
    assert manifest["bundle_sha256"] == upgrade.digest(bundle)
    assert manifest["postconditions_sha256"] == upgrade.digest((upgrade.HERE / "postconditions.sql").read_bytes())
    for path in upgrade.migration_files()[8:]:
        assert path.read_bytes() in bundle
        assert manifest["migration_sources"][path.name] == upgrade.digest(path.read_bytes())


def test_production_bundle_requires_rehearsed_final_catalog():
    ref = snapshot()
    with pytest.raises(ValueError, match="rehearsed final"):
        upgrade.build_bundle(ref, ref, reviewed(ref, ref), database="postgres", role="postgres",
                             recovery_sha256="a" * 64, purpose="production")


def test_snapshot_files_are_private_and_symlinks_are_refused(tmp_path):
    target = tmp_path / "private.json"
    target.write_text("old")
    target.chmod(0o644)
    upgrade.private_write(target, b"private")
    assert target.stat().st_mode & 0o777 == 0o600
    link = tmp_path / "link"
    link.symlink_to(target)
    with pytest.raises(OSError):
        upgrade.private_write(link, b"overwrite")
    assert target.read_bytes() == b"private"


def reconciliation_review():
    objects = {"routine:public.subject()": {"definition": "known"}}
    ref = snapshot({**objects, **{key: {"definition": "authored"} for key in upgrade.RECONCILED_OBJECTS}})
    observed = snapshot(objects, "observed")
    review = reviewed(ref, observed)
    for delta in review["deltas"]:
        delta["disposition"] = "repaired-by-baseline-reconciliation"
    review["reconciliation"] = {"source_sha256": upgrade.digest(upgrade.RECONCILIATION.read_bytes()),
                                "expected_missing_profiles": 1}
    return ref, observed, review


def test_reconciliation_has_explicit_session_role_and_separate_actual_ledger():
    ref, observed, review = reconciliation_review()
    with pytest.raises(ValueError, match="supabase_admin session"):
        upgrade.build_bundle(ref, observed, review, database="postgres", role="postgres",
                             recovery_sha256="a" * 64, purpose="rehearsal")
    bundle, manifest = upgrade.build_bundle(ref, observed, review, database="postgres", role="postgres",
        session_role="supabase_admin", recovery_sha256="a" * 64, purpose="rehearsal")
    text = bundle.decode()
    assert "session_user<>'supabase_admin'" in text
    assert "set local role 'postgres';" in text
    assert upgrade.RECONCILIATION.read_bytes() in bundle
    assert text.index("insert into nate_migrations.baseline_reconciliations(") < text.index("-- Authored file 0009")
    assert text.count("insert into nate_migrations.applied_migrations(") == 15
    assert manifest["baseline_reconciliation"] == review["reconciliation"]


@pytest.mark.parametrize("tamper", ["hash", "count", "partial", "additional"])
def test_reconciliation_rejects_unbound_or_broader_repairs(tamper):
    ref, observed, review = reconciliation_review()
    if tamper == "hash": review["reconciliation"]["source_sha256"] = "0" * 64
    elif tamper == "count": review["reconciliation"]["expected_missing_profiles"] = -1
    elif tamper == "partial": review["deltas"][0]["disposition"] = "retained-platform-difference"
    else: review["deltas"][0]["observed_sha256"] = "0" * 64
    with pytest.raises(ValueError):
        upgrade.validate_review(ref, observed, review)
