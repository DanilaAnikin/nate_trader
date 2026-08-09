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
RLS_TEST = REPO_ROOT / "supabase" / "tests" / "accounts_server_managed.test.sql"

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
    migration_sql: str, column: str
) -> None:
    guard_start = migration_sql.index("accounts_guard_server_managed")
    guard = migration_sql[guard_start:]
    assert f"new.{column}" in guard and f"old.{column}" in guard, (
        f"the accounts guard trigger must reject client writes to {column}"
    )


def test_guard_allows_the_service_role(migration_sql: str) -> None:
    assert "is_service_role()" in migration_sql
    assert "service_role" in migration_sql


def test_rls_regression_script_exists_and_covers_the_write_paths() -> None:
    assert RLS_TEST.is_file(), f"missing RLS test: {RLS_TEST}"
    sql = RLS_TEST.read_text(encoding="utf-8")
    for expectation in (
        "could INSERT an account",
        "could change accounts.mode",
        "could change accounts.alpaca_account_number",
        "could rewrite server-managed columns",
        "could DELETE an account",
        "can read user A account (RLS leak)",
        "anon can read accounts",
    ):
        assert expectation in sql, f"RLS test must assert: {expectation}"
