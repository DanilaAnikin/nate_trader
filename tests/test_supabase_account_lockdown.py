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
READ_LOCKDOWN = REPO_ROOT / "supabase" / "migrations" / "0011_revoke_client_reads.sql"
VIEW_ACL = REPO_ROOT / "supabase" / "migrations" / "0012_view_and_write_acl.sql"
LIFECYCLE = REPO_ROOT / "supabase" / "migrations" / "0013_account_lifecycle_rpc.sql"
LIFECYCLE_TEST = REPO_ROOT / "supabase" / "tests" / "account_lifecycle.test.sql"
BOOTSTRAP = REPO_ROOT / "supabase" / "tests" / "bootstrap_local.sql"
RLS_TEST = REPO_ROOT / "supabase" / "tests" / "accounts_server_managed.test.sql"
READ_TEST = REPO_ROOT / "supabase" / "tests" / "client_read_exposure.test.sql"
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


@pytest.fixture(scope="module")
def read_lockdown_sql() -> str:
    assert READ_LOCKDOWN.is_file(), f"missing migration: {READ_LOCKDOWN}"
    return READ_LOCKDOWN.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def view_acl_sql() -> str:
    assert VIEW_ACL.is_file(), f"missing migration: {VIEW_ACL}"
    return VIEW_ACL.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def lifecycle_sql() -> str:
    assert LIFECYCLE.is_file(), f"missing migration: {LIFECYCLE}"
    return LIFECYCLE.read_text(encoding="utf-8")


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


# --------------------------------------------------------------------------
# 0011 — the read side. 0009/0010 stopped client *writes*; a signed-in browser
# could still read the full broker account number and both Vault UUIDs
# straight out of PostgREST.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["authenticated", "anon"])
@pytest.mark.parametrize("table", ["accounts", "trades"])
def test_client_read_privileges_are_revoked(
    read_lockdown_sql: str, table: str, role: str
) -> None:
    assert f"revoke all on {table} from {role};" in read_lockdown_sql, (
        f"{role} must hold no privileges on {table}"
    )


def test_the_read_policies_are_dropped_too(read_lockdown_sql: str) -> None:
    """A later `grant select` must not silently re-open the table."""
    for policy in ('"read own accounts" on accounts', '"read own trades" on trades'):
        assert f"drop policy if exists {policy};" in read_lockdown_sql


def test_the_sanitized_view_lists_only_safe_columns(read_lockdown_sql: str) -> None:
    start = read_lockdown_sql.index("create or replace view accounts_safe")
    view = read_lockdown_sql[start : read_lockdown_sql.index(";", start)]
    for forbidden in (
        "a.alpaca_key_secret_id",
        "a.alpaca_secret_secret_id",
        "a.owner_id,",
        "a.deleted_at,",
    ):
        assert forbidden not in view, f"accounts_safe must not select {forbidden}"
    # The broker number is masked, never selected whole.
    assert "right(a.alpaca_account_number, 4)" in view
    assert "where a.owner_id = auth.uid()" in view
    assert "a.deleted_at is null" in view


def test_the_trade_view_withholds_the_broker_order_id(read_lockdown_sql: str) -> None:
    start = read_lockdown_sql.index("create or replace view trades_safe")
    view = read_lockdown_sql[start : read_lockdown_sql.index(";", start)]
    assert "alpaca_order_id" not in view
    assert "a.deleted_at is null" in view


@pytest.mark.parametrize("view", ["accounts_safe", "trades_safe"])
def test_the_views_are_not_public(read_lockdown_sql: str, view: str) -> None:
    assert f"revoke all on {view} from public;" in read_lockdown_sql
    assert f"grant select on {view} to authenticated;" in read_lockdown_sql
    assert f"grant select on {view} to anon" not in read_lockdown_sql


def test_owns_account_excludes_soft_deleted_accounts(read_lockdown_sql: str) -> None:
    start = read_lockdown_sql.index("function owns_account(acct uuid)")
    body = read_lockdown_sql[start:]
    assert "deleted_at is null" in body
    assert "set search_path = pg_catalog, public" in body


@pytest.mark.parametrize("earlier", [MIGRATION, GUARD_FIX])
def test_the_applied_migrations_are_not_edited(earlier: Path) -> None:
    """0009 and 0010 are historical; corrections belong in a new migration."""
    text = earlier.read_text(encoding="utf-8")
    assert "revoke all on accounts from authenticated" not in text, (
        f"{earlier.name} must be left as applied; the read revoke belongs in 0011"
    )


def test_0011_is_not_edited_either(read_lockdown_sql: str) -> None:
    """0012 corrects 0011's view grants; 0011 itself stays as written."""
    assert "revoke all on accounts_safe from public, anon, authenticated" not in (
        read_lockdown_sql
    ), "the view ACL correction belongs in 0012, not in an edit to 0011"


# --------------------------------------------------------------------------
# 0012 — the ACL that Supabase's own defaults hand out.
#
# `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`
# means every new table and view arrives DML-capable for both client roles.
# Revoking from `public` does not touch a direct role grant, so 0011's views
# shipped with INSERT/UPDATE/DELETE for anon and authenticated.
# --------------------------------------------------------------------------

SAFE_VIEWS = ("accounts_safe", "trades_safe", "cash_flows_safe")


@pytest.mark.parametrize("view", SAFE_VIEWS)
def test_view_privileges_are_revoked_from_every_client_role(
    view_acl_sql: str, view: str
) -> None:
    pattern = re.compile(
        rf"revoke all on {view}\s+from public, anon, authenticated;"
    )
    assert pattern.search(view_acl_sql), (
        f"{view} must be revoked from public AND anon AND authenticated by name"
    )
    assert f"grant select on {view}" in view_acl_sql


@pytest.mark.parametrize("view", SAFE_VIEWS)
def test_views_are_security_barriers(view_acl_sql: str, view: str) -> None:
    assert f"alter view {view}" in view_acl_sql
    assert "security_barrier = true" in view_acl_sql


def test_the_migration_verifies_its_own_result(view_acl_sql: str) -> None:
    """The catalogue is the authority, not the text of the revokes."""
    assert "has_table_privilege" in view_acl_sql
    for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
        assert f"'{privilege}'" in view_acl_sql
    assert "raise exception 'privilege lockdown failed" in view_acl_sql
    # The service role must keep working.
    assert "service_role lost" in view_acl_sql


def test_client_writes_are_revoked_on_account_scoped_tables(
    view_acl_sql: str,
) -> None:
    for table in (
        "equity_snapshots",
        "performance",
        "positions",
        "routine_runs",
        "audit_log",
    ):
        assert f"'{table}'" in view_acl_sql
    # The settings screen still edits the caller's own profile row.
    assert "grant select, update on profiles to authenticated;" in view_acl_sql


def test_future_objects_do_not_inherit_client_privileges(
    view_acl_sql: str,
) -> None:
    assert "alter default privileges in schema public" in view_acl_sql
    assert "revoke all on tables from anon, authenticated;" in view_acl_sql


def test_the_harness_reproduces_supabase_default_privileges() -> None:
    """A weaker local default would test a database that is not production."""
    bootstrap = BOOTSTRAP.read_text(encoding="utf-8")
    assert "grant all on tables to anon, authenticated, service_role;" in bootstrap
    assert "grant all on sequences to anon, authenticated, service_role;" in bootstrap
    assert "grant all on functions to anon, authenticated, service_role;" in bootstrap


def test_the_dml_negative_test_runs_real_statements() -> None:
    sql = READ_TEST.read_text(encoding="utf-8")
    assert "update accounts_safe set nickname = ''pwned''" in sql
    assert "delete from accounts_safe" in sql
    assert "insert into accounts_safe" in sql
    # `accounts_safe` is auto-updatable, so only the missing privilege stops it.
    assert "42501" in sql
    # The join views are refused earlier as non-updatable; both are acceptable.
    assert "55000" in sql


# --------------------------------------------------------------------------
# 0013 — one transaction per lifecycle flow.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "function_name",
    ["rotate_account_credentials", "delete_account_atomic"],
)
def test_lifecycle_functions_are_service_role_only(
    lifecycle_sql: str, function_name: str
) -> None:
    assert f"create or replace function {function_name}(" in lifecycle_sql
    assert f"revoke all on function {function_name}(" in lifecycle_sql
    assert "from public, anon, authenticated;" in lifecycle_sql
    assert f"grant execute on function {function_name}(" in lifecycle_sql
    assert "to service_role;" in lifecycle_sql


@pytest.mark.parametrize(
    "function_name",
    ["rotate_account_credentials", "delete_account_atomic"],
)
def test_lifecycle_functions_pin_search_path_and_check_ownership(
    lifecycle_sql: str, function_name: str
) -> None:
    start = lifecycle_sql.index(f"create or replace function {function_name}(")
    body = lifecycle_sql[start : lifecycle_sql.index("$$;", start)]
    assert "security definer" in body
    assert "set search_path = pg_catalog, public, vault" in body
    assert "and owner_id = p_owner" in body
    assert "and deleted_at is null" in body
    # The row is locked so two concurrent calls serialise.
    assert "for update" in body


def test_rotation_does_everything_in_one_body(lifecycle_sql: str) -> None:
    start = lifecycle_sql.index("create or replace function rotate_account_credentials(")
    body = lifecycle_sql[start : lifecycle_sql.index("$$;", start)]
    # Both Vault writes, the row rebinding and the audit entry.
    assert body.count("perform vault.update_secret") == 2
    assert "alpaca_account_number = p_account_number" in body
    assert "account.keys_rotated" in body
    # An id that no longer exists updates zero rows and reports success.
    assert "is missing from the vault" in body


def test_deletion_does_everything_in_one_body(lifecycle_sql: str) -> None:
    start = lifecycle_sql.index("create or replace function delete_account_atomic(")
    body = lifecycle_sql[start : lifecycle_sql.index("$$;", start)]
    assert "delete from vault.secrets" in body
    assert "alpaca_account_number   = null" in body
    assert "account.deleted_purged" in body
    assert "account.deleted'" in body


def test_the_lifecycle_transactions_are_tested_against_a_real_server() -> None:
    assert LIFECYCLE_TEST.is_file(), f"missing test: {LIFECYCLE_TEST}"
    sql = LIFECYCLE_TEST.read_text(encoding="utf-8")
    for expectation in (
        "rotation did not replace both secrets",
        "rotation succeeded against a missing Vault secret",
        "a failed rotation left the key overwritten",
        "another user could rotate this account",
        "a soft-deleted account still carries the broker account number",
        "the Vault secrets survived the deletion",
        "the hard delete left the Vault secret",
        "authenticated can call rotate_account_credentials",
        "authenticated can call delete_account_atomic",
    ):
        assert expectation in sql, f"lifecycle test must assert: {expectation}"

    runner = INTEGRATION_RUNNER.read_text(encoding="utf-8")
    assert "account_lifecycle.test.sql" in runner


def test_the_server_uses_the_transactions_rather_than_a_sequence() -> None:
    service = (REPO_ROOT / "dashboard" / "lib" / "accounts" / "service.ts").read_text(
        encoding="utf-8"
    )
    assert 'svc.rpc("rotate_account_credentials"' in service
    assert 'svc.rpc("delete_account_atomic"' in service
    # The step-by-step rotation is gone.
    assert "rotateCredentials(" not in service


def test_the_real_select_test_proves_the_read_side() -> None:
    """A DTO test cannot prove this: PostgREST answers the browser directly."""
    assert READ_TEST.is_file(), f"missing read-exposure test: {READ_TEST}"
    sql = READ_TEST.read_text(encoding="utf-8")
    assert "set local role authenticated;" in sql
    for expectation in (
        "can SELECT the accounts base table",
        "can read accounts.% via REST",
        "can SELECT the trades base table",
        "can read trades.alpaca_order_id",
        "soft-deleted account is readable through accounts_safe",
        "another user''s account is readable through accounts_safe",
        "accounts_safe exposes unexpected columns",
        "leaked the full broker account number",
        "snapshots of a soft-deleted account are still readable",
        "anon can read accounts_safe",
    ):
        assert expectation in sql, f"read-exposure test must assert: {expectation}"
    # Every sensitive column is probed individually, not only the whole table.
    for column in (
        "alpaca_account_number",
        "alpaca_key_secret_id",
        "alpaca_secret_secret_id",
        "owner_id",
        "deleted_at",
    ):
        assert f"'{column}'" in sql

    runner = INTEGRATION_RUNNER.read_text(encoding="utf-8")
    assert "client_read_exposure.test.sql" in runner, (
        "the read-exposure test must run in the integration harness"
    )


def test_soft_delete_clears_the_broker_identifier() -> None:
    """A deleted row must stop carrying the number the binding compares.

    This now happens inside `delete_account_atomic`, so the guarantee lives in
    the migration rather than in a sequence of writes from Node.
    """
    sql = LIFECYCLE.read_text(encoding="utf-8")
    start = sql.index("create or replace function delete_account_atomic(")
    body = sql[start : sql.index("$$;", start)]
    assert "alpaca_account_number   = null" in body


def test_routes_read_accounts_through_the_server_session_helper() -> None:
    """No route may read `accounts` with the cookie-bound (RLS) client."""
    api = REPO_ROOT / "dashboard" / "app" / "api" / "accounts"
    for route in sorted(api.rglob("route.ts")):
        text = route.read_text(encoding="utf-8")
        if 'from("accounts")' not in text:
            continue
        assert "getSupabaseServer" not in text, (
            f"{route.relative_to(REPO_ROOT)} must not read accounts via RLS"
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
        "could update account metadata",
        "the service role cannot update server-managed columns",
        "authorizes a client role with no JWT claims",
        "forged service_role claim could rewrite the binding",
    ):
        assert expectation in sql, f"RLS test must assert: {expectation}"
