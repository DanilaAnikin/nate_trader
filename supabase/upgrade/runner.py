#!/usr/bin/env python3
"""Private catalog comparison and atomic, explicitly reviewed legacy upgrade.

Only ``capture`` and ``apply`` connect to a database. A connection file is a
JSON argv array ending in psql and its connection options, never shell code.
No command logs SQL, connection arguments, server error details or row values.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

HERE = Path(__file__).resolve().parent
MIGRATIONS = HERE.parent / "migrations"
CATALOG = HERE / "catalog.sql"
IMAGE = "supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00"
SERVER_VERSION = "170006"
RECONCILIATION = HERE / "baseline_reconciliation.sql"
RECONCILED_OBJECTS = {
    "trigger:auth.users.on_auth_user_created",
    "policy:storage.objects.read backtest results",
    "policy:storage.objects.read research snapshots",
}


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def json_hash(value: Any) -> str:
    return digest(canonical(value))


def private_write(path: Path, contents: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # O_NOFOLLOW refuses a symlink to a less private or unrelated target.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb", closefd=False) as handle:
            handle.write(contents)
    finally:
        os.close(fd)


def load(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


def migration_files() -> list[Path]:
    paths = sorted(MIGRATIONS.glob("*.sql"))
    if [path.name[:4] for path in paths] != [f"{number:04}" for number in range(1, 24)]:
        raise ValueError("This reviewed upgrade supports exactly authored migrations 0001–0023")
    return paths


def file_manifest() -> dict[str, str]:
    return {path.name: digest(path.read_bytes()) for path in migration_files()}


def validate_snapshot(snapshot: dict) -> None:
    catalog = snapshot.get("catalog", {})
    if snapshot.get("schema_version") != 1 or catalog.get("schema_version") != 1:
        raise ValueError("Unsupported catalog snapshot")
    objects = catalog.get("objects")
    if not isinstance(objects, dict) or not objects:
        raise ValueError("An empty catalog cannot establish a legacy baseline")
    if catalog.get("object_count") != len(objects) or catalog.get("unique_object_count") != len(objects):
        raise ValueError("Duplicate or incomplete catalog identities")
    if catalog.get("server", {}).get("version_num") != SERVER_VERSION:
        raise ValueError("The baseline requires the exact reviewed PostgreSQL 17.6 runtime")
    if snapshot.get("catalog_query_sha256") != digest(CATALOG.read_bytes()):
        raise ValueError("Catalog query changed; capture a new snapshot")
    if snapshot.get("migration_sources") != file_manifest():
        raise ValueError("Migration bytes changed; capture/review the matching reference")
    if snapshot.get("catalog_sha256") != json_hash(catalog):
        raise ValueError("Catalog snapshot digest mismatch")


def compare(reference: dict, observed: dict) -> list[dict]:
    validate_snapshot(reference)
    validate_snapshot(observed)
    left, right = reference["catalog"]["objects"], observed["catalog"]["objects"]
    return [
        {"object": key,
         "reference_sha256": json_hash(left[key]) if key in left else None,
         "observed_sha256": json_hash(right[key]) if key in right else None}
        for key in sorted(left.keys() | right.keys()) if left.get(key) != right.get(key)
    ]


def proposed_review(reference: dict, observed: dict) -> dict:
    return {
        "schema_version": 1,
        "status": "UNREVIEWED",
        "reviewer": None,
        "reference_catalog_sha256": reference["catalog_sha256"],
        "observed_catalog_sha256": observed["catalog_sha256"],
        "reference_provenance": "Describe the fresh 0001–0008 build evidence; object presence is insufficient.",
        "deltas": [{**delta, "disposition": None, "reason": ""}
                   for delta in compare(reference, observed)],
    }


def validate_review(reference: dict, observed: dict, review: dict) -> None:
    expected = compare(reference, observed)
    if reference.get("stage") != "reference-0008":
        raise ValueError("The starting reference must be the authored 0001–0008 chain")
    if review.get("schema_version") != 1 or review.get("status") != "REVIEWED":
        raise ValueError("An explicit reviewed baseline is required")
    if not str(review.get("reviewer") or "").strip():
        raise ValueError("The baseline review must identify its reviewer")
    if not str(review.get("reference_provenance") or "").strip() or str(review["reference_provenance"]).startswith("Describe "):
        raise ValueError("Record the reference build provenance")
    for field, snapshot in (("reference_catalog_sha256", reference), ("observed_catalog_sha256", observed)):
        if review.get(field) != snapshot["catalog_sha256"]:
            raise ValueError("Review is not bound to these exact catalogs")
    actual = review.get("deltas")
    if not isinstance(actual, list) or len(actual) != len(expected):
        raise ValueError("Every exact catalog delta must be reviewed")
    for delta, wanted in zip(actual, expected, strict=True):
        if any(delta.get(field) != value for field, value in wanted.items()):
            raise ValueError("Review contains a missing, changed or extra catalog delta")
        if delta.get("disposition") not in {"replaced-by-authored-migrations", "retained-platform-difference", "repaired-by-baseline-reconciliation"}:
            raise ValueError("Every delta needs an explicit disposition")
        if not str(delta.get("reason") or "").strip():
            raise ValueError("Every delta needs a concrete review reason")
    repaired = {item["object"] for item in actual if item["disposition"] == "repaired-by-baseline-reconciliation"}
    if repaired:
        if repaired != RECONCILED_OBJECTS or any(
            item["observed_sha256"] is not None or item["reference_sha256"] is None
            for item in actual if item["object"] in repaired
        ):
            raise ValueError("Reconciliation supports only the exact three demonstrated legacy omissions")
        reconciliation = review.get("reconciliation", {})
        if reconciliation.get("source_sha256") != digest(RECONCILIATION.read_bytes()):
            raise ValueError("Review must bind the exact reconciliation source")
        count = reconciliation.get("expected_missing_profiles")
        if type(count) is not int or count < 0:
            raise ValueError("Reconciliation requires the exact observed missing-profile count")
    elif review.get("reconciliation"):
        raise ValueError("Reconciliation evidence requires the three explicit repaired deltas")


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def top_level_sql(sql: str) -> str:
    """Remove SQL strings/comments/bodies before checking transaction control."""
    output: list[str] = []
    i = 0
    while i < len(sql):
        if sql.startswith("--", i):
            end = sql.find("\n", i)
            i = len(sql) if end < 0 else end
        elif sql.startswith("/*", i):
            depth, i = 1, i + 2
            while depth and i < len(sql):
                if sql.startswith("/*", i): depth, i = depth + 1, i + 2
                elif sql.startswith("*/", i): depth, i = depth - 1, i + 2
                else: i += 1
            if depth: raise ValueError("Unclosed SQL comment")
        elif sql[i] in "'\"":
            quote, i = sql[i], i + 1
            while i < len(sql):
                if sql[i] == quote:
                    if i + 1 < len(sql) and sql[i + 1] == quote: i += 2
                    else: i += 1; break
                elif sql[i] == "\\": i += 2
                else: i += 1
            output.append(" quoted ")
        elif sql[i] == "$" and (match := re.match(r"\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$", sql[i:])):
            marker = match.group()
            end = sql.find(marker, i + len(marker))
            if end < 0: raise ValueError("Unclosed SQL body")
            i = end + len(marker)
            output.append(" body ")
        else:
            output.append(sql[i]); i += 1
    return "".join(output)


def assert_transaction_safe(sql: str) -> None:
    clean = top_level_sql(sql)
    if "\\" in clean:
        raise ValueError("Migration psql commands are forbidden")
    for statement in clean.split(";"):
        if re.match(r"\s*(begin|start\s+transaction|commit|rollback|end|abort|vacuum)\b", statement, re.I):
            raise ValueError("Migration may not escape the enclosing transaction")
        if re.search(r"\bconcurrently\b", statement, re.I):
            raise ValueError("Concurrent operations are outside this atomic upgrade")


def build_bundle(reference: dict, observed: dict, review: dict, *, database: str,
                 role: str, recovery_sha256: str, purpose: str,
                 final_snapshot: dict | None = None, session_role: str | None = None) -> tuple[bytes, dict]:
    validate_review(reference, observed, review)
    if purpose not in {"rehearsal", "production"}:
        raise ValueError("Choose rehearsal or production explicitly")
    if not re.fullmatch(r"[0-9a-f]{64}", recovery_sha256):
        raise ValueError("A verified recovery-evidence digest is required")
    server = observed["catalog"]["server"]
    session_role = session_role or role
    reconciliation = review.get("reconciliation")
    if reconciliation and (session_role != "supabase_admin" or role != "postgres"):
        raise ValueError("Platform reconciliation requires the explicit supabase_admin session and postgres application role")
    sources = {path: path.read_bytes() for path in migration_files()}
    source_hashes = {path.name: digest(source) for path, source in sources.items()}
    catalog_source = CATALOG.read_bytes()
    postconditions_source = (HERE / "postconditions.sql").read_bytes()
    reconciliation_source = RECONCILIATION.read_bytes() if reconciliation else None
    if source_hashes != observed["migration_sources"] or digest(catalog_source) != observed["catalog_query_sha256"]:
        raise ValueError("Release inputs changed while building the bundle")
    if reconciliation and digest(reconciliation_source) != reconciliation["source_sha256"]:
        raise ValueError("Reconciliation source changed while building the bundle")
    if server["database"] != database or server["role"] != role:
        raise ValueError("Explicit database/role do not match the observed baseline")
    if not server.get("vault_references") or not server.get("public_create") or not server.get("database_create"):
        raise ValueError("Migration role lacks Vault REFERENCES, public CREATE or database CREATE")
    if final_snapshot is not None:
        validate_snapshot(final_snapshot)
        if final_snapshot.get("stage") != "rehearsed-0023":
            raise ValueError("Final contract must come from the successful upgrade rehearsal")
    elif purpose == "production":
        raise ValueError("Production requires the exact successfully rehearsed final catalog")
    manifest = {
        "schema_version": 1, "purpose": purpose, "database": database, "role": role, "session_role": session_role,
        "server_version_num": SERVER_VERSION, "reference_image": IMAGE,
        "historical_migrations": "unknown; no historical execution attested",
        "reference_stage": "0008", "reference_catalog_sha256": reference["catalog_sha256"],
        "observed_catalog_sha256": observed["catalog_sha256"],
        "review_sha256": json_hash(review), "recovery_evidence_sha256": recovery_sha256,
        "final_objects_sha256": json_hash(final_snapshot["catalog"]["objects"]) if final_snapshot else None,
        "migration_sources": source_hashes, "catalog_query_sha256": digest(catalog_source),
        "runner_sha256": digest(Path(__file__).read_bytes()),
        "postconditions_sha256": digest(postconditions_source),
        "baseline_reconciliation": reconciliation,
    }
    baseline_id = json_hash(manifest)
    query = catalog_source.decode().strip().rstrip(";")
    expected = sql_literal(canonical(observed["catalog"]["objects"]).decode())
    header = f"""-- Generated atomic upgrade; private catalog definitions are embedded.
-- purpose={purpose}; manifest_sha256={baseline_id}
\\set ON_ERROR_STOP on
\\set VERBOSITY terse
begin;
set local standard_conforming_strings=on;
set local role {sql_literal(role)};
set local statement_timeout='120s';
set local lock_timeout='10s';
set local search_path=pg_catalog;
do $nt_guard$ begin
  if current_database()<>{sql_literal(database)} or current_user<>{sql_literal(role)}
     or session_user<>{sql_literal(session_role)}
     or current_setting('server_version_num')<>{sql_literal(SERVER_VERSION)} then
    raise exception 'Upgrade target identity does not match the reviewed plan';
  end if;
  if not pg_try_advisory_xact_lock(783461,923) then
    raise exception 'Another Nate database upgrade holds the deployment lock';
  end if;
  if to_regnamespace('nate_migrations') is not null
     or to_regclass('supabase_migrations.schema_migrations') is not null then
    raise exception 'Existing migration history requires a different reviewed plan';
  end if;
  if not has_table_privilege(current_user,'vault.secrets','REFERENCES')
     or not has_schema_privilege(current_user,'public','CREATE')
     or not has_database_privilege(current_user,current_database(),'CREATE') then
    raise exception 'Migration role lacks required privileges';
  end if;
end $nt_guard$;
create temp view nt_upgrade_catalog as {query};
do $nt_baseline$ begin
  if (select nt_upgrade_catalog.jsonb_build_object->'objects' from nt_upgrade_catalog)<>{expected}::jsonb then
    raise exception 'Observed catalog drifted from the exact reviewed baseline';
  end if;
end $nt_baseline$;
-- Keep application rows stable throughout the DDL and legacy-data guards.
do $nt_locks$ declare item record; begin
  for item in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') order by c.relname loop
    execute format('lock table %I.%I in access exclusive mode',item.nspname,item.relname);
  end loop;
end $nt_locks$;
-- Recheck after taking row-table locks, closing concurrent application DDL
-- changes between the first baseline read and the lock acquisition.
do $nt_locked_baseline$ begin
  if (select nt_upgrade_catalog.jsonb_build_object->'objects' from nt_upgrade_catalog)<>{expected}::jsonb then
    raise exception 'Catalog changed while acquiring the deployment locks';
  end if;
end $nt_locked_baseline$;
create schema nate_migrations;
revoke all on schema nate_migrations from public,anon,authenticated,service_role;
create table nate_migrations.baseline_attestations (
  id text primary key, recorded_at timestamptz not null default current_timestamp,
  historical_migrations text not null, reference_stage text not null,
  reference_catalog_sha256 text not null, observed_catalog_sha256 text not null,
  review_sha256 text not null, recovery_evidence_sha256 text not null,
  manifest jsonb not null
);
create table nate_migrations.applied_migrations (
  version text primary key, filename text not null, source_sha256 text not null,
  baseline_id text not null references nate_migrations.baseline_attestations(id),
  applied_at timestamptz not null default current_timestamp
);
create table nate_migrations.baseline_reconciliations (
  baseline_id text primary key references nate_migrations.baseline_attestations(id),
  filename text not null, source_sha256 text not null,
  repaired_objects integer not null, repaired_profiles integer not null,
  applied_at timestamptz not null default current_timestamp
);
revoke all on all tables in schema nate_migrations from public,anon,authenticated,service_role;
insert into nate_migrations.baseline_attestations values (
  {sql_literal(baseline_id)},current_timestamp,'unknown; no historical execution attested','0008',
  {sql_literal(reference['catalog_sha256'])},{sql_literal(observed['catalog_sha256'])},
  {sql_literal(json_hash(review))},{sql_literal(recovery_sha256)},
  {sql_literal(canonical(manifest).decode())}::jsonb
);
set local search_path=public,extensions;
"""
    parts = [header]
    if reconciliation:
        source = reconciliation_source.decode()
        assert_transaction_safe(source)
        parts.extend([
            f"set local nate_upgrade.expected_missing_profiles={sql_literal(str(reconciliation['expected_missing_profiles']))};\n",
            source,
            "\ninsert into nate_migrations.baseline_reconciliations(baseline_id,filename,source_sha256,repaired_objects,repaired_profiles) values "
            f"({sql_literal(baseline_id)},{sql_literal(RECONCILIATION.name)},{sql_literal(reconciliation['source_sha256'])},3,{reconciliation['expected_missing_profiles']});\n",
        ])
    for path, source in list(sources.items())[8:]:
        text = source.decode()
        assert_transaction_safe(text)
        source_hash = digest(source)
        parts.extend([
            f"\n-- Authored file {path.name}; sha256={source_hash}\n",
            text,
            f"\ninsert into nate_migrations.applied_migrations(version,filename,source_sha256,baseline_id) values "
            f"({sql_literal(path.name[:4])},{sql_literal(path.name)},{sql_literal(source_hash)},{sql_literal(baseline_id)});\n",
        ])
    parts.append("\nset local search_path=pg_catalog;\n")
    parts.append(postconditions_source.decode())
    if final_snapshot:
        final = sql_literal(canonical(final_snapshot["catalog"]["objects"]).decode())
        parts.append(f"""
do $nt_final$ begin
  if (select nt_upgrade_catalog.jsonb_build_object->'objects' from nt_upgrade_catalog)<>{final}::jsonb then
    raise exception 'Final catalog differs from the rehearsed deployment contract';
  end if;
end $nt_final$;
""")
    parts.append(f"""
do $nt_ledger$ begin
  if (select array_agg(version order by version) from nate_migrations.applied_migrations)
      <> array['0009','0010','0011','0012','0013','0014','0015','0016','0017','0018','0019','0020','0021','0022','0023'] then
    raise exception 'Atomic migration ledger is incomplete';
  end if;
end $nt_ledger$;
-- PostgreSQL delivers this only if the entire upgrade commits successfully.
notify pgrst,'reload schema';
commit;
select jsonb_build_object('event','upgrade_committed','manifest_sha256',{sql_literal(baseline_id)},
  'purpose',{sql_literal(purpose)},'applied_versions',15,'historical_versions_attested',false);
""")
    bundle = "".join(parts).encode()
    return bundle, {**manifest, "manifest_sha256": baseline_id, "bundle_sha256": digest(bundle)}


def connection(path: Path) -> list[str]:
    command = json.loads(path.read_text())
    if not isinstance(command, list) or not command or not all(isinstance(arg,str) and arg for arg in command):
        raise ValueError("Connection file must contain a nonempty JSON argv array")
    return command + ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"]


def capture(args: argparse.Namespace) -> None:
    sql = "begin isolation level repeatable read read only; set local search_path=pg_catalog; set local statement_timeout='30s';\n" + CATALOG.read_text() + ";\nrollback;\n"
    result = subprocess.run(connection(args.connection), input=sql.encode(), capture_output=True)
    if result.returncode:
        raise RuntimeError(f"Catalog capture failed (exit={result.returncode}, stderr_sha256={digest(result.stderr)})")
    catalog = json.loads(result.stdout)
    snapshot = {"schema_version":1, "stage":args.stage,
        "captured_at":datetime.now(timezone.utc).isoformat(), "catalog":catalog,
        "catalog_sha256":json_hash(catalog), "catalog_query_sha256":digest(CATALOG.read_bytes()),
        "migration_sources":file_manifest()}
    validate_snapshot(snapshot)
    private_write(args.output, canonical(snapshot)+b"\n")
    print(json.dumps({"event":"catalog_captured", "sha256":snapshot["catalog_sha256"],
                      "objects":catalog["object_count"]}))


def apply(args: argparse.Namespace) -> None:
    bundle = args.bundle.read_bytes()
    if digest(bundle) != args.expected_sha256:
        raise ValueError("Bundle digest differs from the explicitly selected release input")
    result = subprocess.run(connection(args.connection), input=bundle, capture_output=True)
    events = []
    for line in result.stdout.splitlines():
        try: event = json.loads(line)
        except (ValueError, UnicodeError): continue
        if isinstance(event,dict) and event.get("event") == "upgrade_committed":
            events.append(event)
    succeeded = result.returncode == 0 and len(events)==1
    evidence = {"schema_version":1,"completed_at":datetime.now(timezone.utc).isoformat(),
        "status":"COMMITTED" if succeeded else "NOT_CONFIRMED",
        "bundle_sha256":digest(bundle),"exit_code":result.returncode,
        "stdout_sha256":digest(result.stdout),"stderr_sha256":digest(result.stderr),"events":events}
    private_write(args.evidence,canonical(evidence)+b"\n")
    print(json.dumps(evidence))
    if not succeeded:
        raise RuntimeError("Upgrade was not confirmed; inspect database ledger before retrying. Raw server output was not logged.")


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest="command",required=True)
    read=commands.add_parser("capture")
    read.add_argument("--connection",type=Path,required=True)
    read.add_argument("--stage",choices=["observed","reference-0008","reference-0023","rehearsed-0023"],required=True)
    read.add_argument("--output",type=Path,required=True)
    diff=commands.add_parser("compare")
    diff.add_argument("--reference",type=Path,required=True)
    diff.add_argument("--observed",type=Path,required=True)
    diff.add_argument("--output",type=Path,required=True)
    build=commands.add_parser("build")
    for name in ("reference","observed","review","output","manifest"):
        build.add_argument("--"+name,type=Path,required=True)
    build.add_argument("--database",required=True)
    build.add_argument("--role",required=True)
    build.add_argument("--session-role")
    build.add_argument("--recovery-sha256",required=True)
    build.add_argument("--purpose",choices=["rehearsal","production"],required=True)
    build.add_argument("--final-snapshot",type=Path)
    run=commands.add_parser("apply")
    run.add_argument("--connection",type=Path,required=True)
    run.add_argument("--bundle",type=Path,required=True)
    run.add_argument("--expected-sha256",required=True)
    run.add_argument("--evidence",type=Path,required=True)
    args=parser.parse_args()
    try:
        if args.command=="capture": capture(args)
        elif args.command=="compare":
            review=proposed_review(load(args.reference),load(args.observed))
            private_write(args.output,canonical(review)+b"\n")
            print(json.dumps({"event":"review_required","deltas":len(review["deltas"])}))
        elif args.command=="build":
            bundle,manifest=build_bundle(load(args.reference),load(args.observed),load(args.review),
                database=args.database,role=args.role,recovery_sha256=args.recovery_sha256,
                purpose=args.purpose,final_snapshot=load(args.final_snapshot) if args.final_snapshot else None,
                session_role=args.session_role)
            private_write(args.output,bundle)
            private_write(args.manifest,canonical(manifest)+b"\n")
            print(json.dumps({"event":"bundle_created","purpose":args.purpose,
                              "bundle_sha256":manifest["bundle_sha256"]}))
        elif args.command=="apply": apply(args)
    except (ValueError,RuntimeError,OSError) as exc:
        print(str(exc),file=sys.stderr)
        return 1
    return 0


if __name__=="__main__":
    raise SystemExit(main())
