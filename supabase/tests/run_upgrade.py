#!/usr/bin/env python3
"""Exercise the upgrade on a disposable, network-isolated PG17 reference image.

The verified base is built by the existing catalogue-classify harness. This
test refuses a stale/missing base instead of changing any existing container.
All database rows in that base are the harness's synthetic fixtures.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("nt_upgrade", ROOT / "supabase/upgrade/runner.py")
upgrade = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upgrade)


def run(argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f"Disposable upgrade test command failed: exit={result.returncode}, stderr_sha256={upgrade.digest(result.stderr)}")
    return result.stdout


def main() -> None:
    context = run(["docker", "context", "show"]).decode().strip()
    endpoint = run(["docker", "context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"]).decode().strip()
    if not endpoint.startswith("unix://"):
        raise RuntimeError("Disposable tests require an explicitly local Docker socket")
    source_digest = run(["bash", str(ROOT / ".github/containment/catalogue-classify.sh"),
                         "--generation", "0008", "--print-base-digest"]).decode().strip()
    image = f"nt-catalogue-classify-base:g0008-{source_digest[:16]}"
    labels = json.loads(run(["docker", "image", "inspect", image, "--format", "{{json .Config.Labels}}"]))
    if labels.get("nt.catalogue-classify.base-inputs-sha256") != source_digest:
        raise RuntimeError("The cached reference does not match all authored migration/bootstrap/fixture bytes")
    name = "nt-upgrade-test-" + uuid.uuid4().hex[:12]
    owned = []

    def start(container):
        run(["docker", "run", "-d", "--network", "none", "--log-driver", "none",
             "--name", container, "--label", "nate.audit=pg17-upgrade",
             "-e", "POSTGRES_PASSWORD=upgrade-fixture-only", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", image])
        owned.append(container)

    start(name)
    command = ["docker", "exec", "-i", name, "psql", "-U", "postgres", "-d", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]

    def sql(payload, *, succeed=True, admin=False):
        argv = command[:]
        if admin: argv[argv.index("-U") + 1] = "supabase_admin"
        result = subprocess.run(argv, input=payload.encode(), capture_output=True)
        if (result.returncode == 0) != succeed:
            raise RuntimeError(f"Unexpected test SQL outcome: exit={result.returncode}, stderr_sha256={upgrade.digest(result.stderr)}")
        return result.stdout

    def snapshot(stage):
        catalog = json.loads(sql("begin read only; set local search_path=pg_catalog;\n" + upgrade.CATALOG.read_text() + "; rollback;"))
        return {"schema_version": 1, "stage": stage, "catalog": catalog,
            "catalog_sha256": upgrade.json_hash(catalog),
            "catalog_query_sha256": upgrade.digest(upgrade.CATALOG.read_bytes()),
            "migration_sources": upgrade.file_manifest()}

    def ready():
        for _ in range(60):
            result = subprocess.run(command + ["-c", "select current_setting('server_version_num')"], capture_output=True)
            if result.returncode == 0 and result.stdout.strip() == b"170006": break
            time.sleep(1)
        else: raise RuntimeError("Disposable reference did not become ready")

    def legacy_drift():
        sql("""grant execute on function public.get_account_credentials(uuid),
          public.vault_create_secret(text,text), public.vault_update_secret(uuid,text),
          public.vault_delete_secret(uuid) to anon,authenticated;
          revoke supabase_storage_admin from postgres;
          insert into auth.users(id,email,raw_user_meta_data)
            values('99990000-0000-0000-0000-000000000099','upgrade-profile-fixture@example.invalid',
                   '{"display_name":"Upgrade fixture"}'::jsonb);
          delete from public.profiles where id='99990000-0000-0000-0000-000000000099';
          drop trigger on_auth_user_created on auth.users;
          drop policy "read backtest results" on storage.objects;
          drop policy "read research snapshots" on storage.objects;""", admin=True)

    def inspect(prefix=""):
        payload = (ROOT / "supabase/production_inspection.sql").read_text()
        if prefix:
            payload = payload.replace("begin isolation level repeatable read read only;", "begin;\n" + prefix)
        return {row["section"]: row for row in (json.loads(line) for line in sql(payload).splitlines())}

    try:
        ready()
        reference = snapshot("reference-0008")
        assert "unavailable" in inspect()["nate_migration_baseline"]["status"]
        legacy_drift()
        observed = snapshot("observed")
        assert observed["catalog"]["server"]["storage_admin_member"] is False
        review = upgrade.proposed_review(reference, observed)
        assert len(review["deltas"]) == 8
        review.update(status="REVIEWED", reviewer="synthetic-test",
                      reference_provenance="Immutable synthetic reference base verified against " + source_digest)
        for delta in review["deltas"]:
            disposition = ("repaired-by-baseline-reconciliation" if delta["object"] in upgrade.RECONCILED_OBJECTS
                           else "retained-platform-difference" if delta["object"].startswith("membership:")
                           else "replaced-by-authored-migrations")
            delta.update(disposition=disposition,
                         reason="Known, explicitly injected synthetic ACL/membership mutation; not a production baseline approval")
        review["reconciliation"] = {"source_sha256": upgrade.digest(upgrade.RECONCILIATION.read_bytes()),
                                    "expected_missing_profiles": 1}
        bundle, _ = upgrade.build_bundle(reference, observed, review, database="postgres", role="postgres",
            session_role="supabase_admin", recovery_sha256="a" * 64, purpose="rehearsal")

        # The baseline guard sees more than names: a changed RLS flag aborts
        # before any ledger is created, and never silently expands the review.
        sql("alter table public.accounts disable row level security")
        sql(bundle.decode(), succeed=False, admin=True)
        assert sql("select to_regnamespace('nate_migrations') is null").strip() == b"t"
        sql("alter table public.accounts enable row level security")
        assert snapshot("observed")["catalog_sha256"] == observed["catalog_sha256"]
        print("PASS: baseline RLS drift refused without ledger", flush=True)

        # Fail after all migration statements, not merely before the first DDL.
        # PostgreSQL must restore every changed definition, ACL and ledger row.
        broken = bundle.decode().replace("\ncommit;\n", "\nselect 1/0;\ncommit;\n")
        sql(broken, succeed=False, admin=True)
        assert sql("select to_regnamespace('nate_migrations') is null").strip() == b"t"
        assert snapshot("observed")["catalog_sha256"] == observed["catalog_sha256"]
        assert sql("select count(*) from public.profiles where id='99990000-0000-0000-0000-000000000099'").strip() == b"0"
        print("PASS: late failure rolls back all 15 migrations and attestation", flush=True)

        sql(bundle.decode(), admin=True)
        assert sql("select count(*) from nate_migrations.applied_migrations").strip() == b"15"
        assert sql("select to_regclass('supabase_migrations.schema_migrations') is null").strip() == b"t"
        assert sql("select repaired_objects=3 and repaired_profiles=1 from nate_migrations.baseline_reconciliations").strip() == b"t"
        assert sql("select display_name='Upgrade fixture' and default_account_id is null from public.profiles where id='99990000-0000-0000-0000-000000000099'").strip() == b"t"
        final = snapshot("rehearsed-0023")
        production, _ = upgrade.build_bundle(reference, observed, review, database="postgres", role="postgres",
            session_role="supabase_admin", recovery_sha256="a" * 64, purpose="production", final_snapshot=final)
        assert b"Final catalog differs from the rehearsed deployment contract" in production
        sql(bundle.decode(), succeed=False, admin=True)
        assert sql("select count(*) from nate_migrations.applied_migrations").strip() == b"15"
        print("PASS: upgrade committed 0009–0023, unknown history preserved, repeat refused", flush=True)
        inspected = inspect()
        assert inspected["nate_migration_baseline"]["historical_execution_unknown"] is True
        assert inspected["nate_applied_migrations"]["exact_upgrade_versions"] is True
        assert inspected["nate_applied_migrations"]["source_hashes_match_recorded_manifest"] is True
        assert inspected["nate_baseline_reconciliation"]["source_hashes_match_recorded_manifest"] is True
        assert inspected["nate_baseline_reconciliation"]["repaired_profiles"] == 1
        damaged = inspect("update nate_migrations.baseline_attestations set manifest = manifest - 'migration_sources';")
        assert damaged["nate_applied_migrations"]["source_hashes_match_recorded_manifest"] is False
        assert inspect()["nate_applied_migrations"]["source_hashes_match_recorded_manifest"] is True
        print("PASS: read-only inspector distinguishes legacy history, applied ledger and missing hash evidence", flush=True)

        # Rehearsal is only useful if a new equivalent target can satisfy the
        # full final production contract, including exact ACLs and definitions.
        second = "nt-upgrade-test-" + uuid.uuid4().hex[:12]
        start(second)
        command[3] = second
        ready()
        legacy_drift()
        assert snapshot("observed")["catalog_sha256"] == observed["catalog_sha256"]
        bad_final = json.loads(json.dumps(final))
        bad_final["catalog"]["objects"]["invalid:final-contract"] = {"synthetic": True}
        bad_final["catalog"]["object_count"] += 1
        bad_final["catalog"]["unique_object_count"] += 1
        bad_final["catalog_sha256"] = upgrade.json_hash(bad_final["catalog"])
        bad_bundle, _ = upgrade.build_bundle(reference, observed, review, database="postgres", role="postgres",
            session_role="supabase_admin", recovery_sha256="a" * 64, purpose="production", final_snapshot=bad_final)
        sql(bad_bundle.decode(), succeed=False, admin=True)
        assert sql("select to_regnamespace('nate_migrations') is null").strip() == b"t"
        assert snapshot("observed")["catalog_sha256"] == observed["catalog_sha256"]
        sql(production.decode(), admin=True)
        assert snapshot("rehearsed-0023")["catalog"]["objects"] == final["catalog"]["objects"]
        print("PASS: production final-contract drift rolls back; matching rehearsed contract commits", flush=True)
        print("ALL ATOMIC UPGRADE INTEGRATION CHECKS PASSED")
    finally:
        for container in reversed(owned):
            run(["docker", "rm", "-f", container])


if __name__ == "__main__":
    main()
