"""Contract tests for the Supabase account lockdown migration.

The dashboard's production binding trusts `accounts.owner_id`, `accounts.mode`
and the Vault secret references. Those must not be writable by an end user, so
the migration that removes client write access is itself part of the security
contract and is checked here — the release gate runs pytest, but not a
database.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATION = REPO_ROOT / "supabase" / "migrations" / "0009_accounts_server_managed.sql"
GUARD_FIX = (
    REPO_ROOT / "supabase" / "migrations" / "0010_accounts_guard_authz_fix.sql"
)
RLS_TEST = REPO_ROOT / "supabase" / "tests" / "accounts_server_managed.test.sql"
INTEGRATION_RUNNER = REPO_ROOT / "supabase" / "tests" / "run_integration.sh"
RELEASE_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "v11-release.yml"

SERVER_MANAGED_COLUMNS = (
    "owner_id",
    "mode",
    "status",
    "alpaca_account_number",
    "alpaca_key_secret_id",
    "alpaca_secret_secret_id",
    "last_verified_at",
    "last_synced_at",
    "deleted_at",
)


@pytest.fixture(scope="module")
def migration_sql() -> str:
    assert MIGRATION.is_file(), f"missing migration: {MIGRATION}"
    return MIGRATION.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def guard_fix_sql() -> str:
    assert GUARD_FIX.is_file(), f"missing migration: {GUARD_FIX}"
    return GUARD_FIX.read_text(encoding="utf-8")


def test_permissive_for_all_policy_is_removed(migration_sql: str) -> None:
    assert 'drop policy if exists "own accounts" on accounts;' in migration_sql


def test_only_a_select_policy_remains(migration_sql: str) -> None:
    policies = re.findall(
        r"create policy\s+\"[^\"]+\"\s+on accounts\s+for\s+(\w+)",
        migration_sql,
        flags=re.IGNORECASE,
    )
    assert policies, "the migration must define an accounts policy"
    assert set(policies) == {"select"}, (
        "authenticated users must only be able to SELECT accounts; "
        f"found policies for {sorted(set(policies))}"
    )


@pytest.mark.parametrize("role", ["authenticated", "anon"])
def test_write_grants_are_revoked(migration_sql: str, role: str) -> None:
    pattern = re.compile(
        rf"revoke\s+insert,\s*update,\s*delete,\s*truncate\s+on accounts from {role};",
        flags=re.IGNORECASE,
    )
    assert pattern.search(migration_sql), (
        f"INSERT/UPDATE/DELETE on accounts must be revoked from {role}"
    )


def test_guard_trigger_exists(migration_sql: str) -> None:
    assert "create trigger accounts_guard" in migration_sql
    assert "before insert or update or delete on accounts" in migration_sql
    assert "accounts_guard_server_managed" in migration_sql


@pytest.mark.parametrize("column", SERVER_MANAGED_COLUMNS)
def test_guard_covers_every_server_managed_column(
    guard_fix_sql: str, column: str
) -> None:
    guard_start = guard_fix_sql.index("accounts_guard_server_managed")
    guard = guard_fix_sql[guard_start:]
    assert f"new.{column}" in guard and f"old.{column}" in guard, (
        f"the accounts guard trigger must reject client writes to {column}"
    )


def test_guard_allows_the_service_role(migration_sql: str) -> None:
    assert "is_service_role()" in migration_sql
    assert "service_role" in migration_sql


def test_guard_is_security_invoker_not_definer(guard_fix_sql: str) -> None:
    """A SECURITY DEFINER trigger sees the function owner in ``current_user``.

    That is exactly how 0009 could authorize a client: the fixed guard must be
    security invoker so the caller's real effective role is visible.
    """
    guard_start = guard_fix_sql.index("function accounts_guard_server_managed()")
    guard = guard_fix_sql[guard_start:]
    assert "security invoker" in guard
    assert "security definer" not in guard


def test_guard_authorization_never_trusts_a_client_role(guard_fix_sql: str) -> None:
    assert "current_user in ('anon', 'authenticated') then false" in guard_fix_sql
    # Authorization is JWT-first, with an owner/service fallback only.
    assert "jwt_role() = 'service_role'" in guard_fix_sql


@pytest.mark.parametrize(
    "function_name", ["jwt_role()", "is_service_role()", "accounts_guard_server_managed()"]
)
def test_every_guard_function_pins_search_path(
    guard_fix_sql: str, function_name: str
) -> None:
    start = guard_fix_sql.index(f"function {function_name}")
    body = guard_fix_sql[start : start + 600]
    assert "set search_path = pg_catalog, public" in body, (
        f"{function_name} must pin an explicit search_path"
    )


def test_only_cosmetic_columns_are_client_updatable(guard_fix_sql: str) -> None:
    assert (
        "grant update (nickname, color, is_active) on accounts to authenticated;"
        in guard_fix_sql
    )
    for column in ("owner_id", "mode", "status", "alpaca_account_number"):
        assert f"grant update ({column}" not in guard_fix_sql


def test_the_original_migration_is_not_edited(migration_sql: str) -> None:
    """0009 is already applied in production; the fix is a follow-up."""
    assert "security definer" in migration_sql, (
        "0009 must be left as it was; corrections belong in 0010"
    )


def test_a_real_database_integration_test_exists_and_is_wired_into_ci() -> None:
    assert INTEGRATION_RUNNER.is_file(), f"missing runner: {INTEGRATION_RUNNER}"
    assert INTEGRATION_RUNNER.stat().st_mode & 0o111, "runner must be executable"

    runner = INTEGRATION_RUNNER.read_text(encoding="utf-8")
    # It must apply the real migration files, not a hand-written copy.
    assert "supabase/migrations" in runner
    assert "accounts_server_managed.test.sql" in runner

    workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    assert "supabase-schema-gate" in workflow, (
        "the release gate must run the database integration test"
    )
    assert "postgres:16-alpine" in workflow
    assert "supabase/tests/run_integration.sh" in workflow


def test_rls_regression_script_exists_and_covers_the_write_paths() -> None:
    assert RLS_TEST.is_file(), f"missing RLS test: {RLS_TEST}"
    sql = RLS_TEST.read_text(encoding="utf-8")
    for expectation in (
        "could INSERT an account",
        "could change accounts.mode",
        "could forge accounts.alpaca_account_number",
        "could rewrite server-managed columns",
        "could DELETE an account",
        "can read user A account (RLS leak)",
        "anon can read accounts",
        "cannot change allowed metadata",
        "the service role cannot update server-managed columns",
        "authorizes a client role with no JWT claims",
        "forged service_role claim could rewrite the binding",
    ):
        assert expectation in sql, f"RLS test must assert: {expectation}"
