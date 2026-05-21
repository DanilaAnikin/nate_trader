-- ============================================================================
-- 0007_advisor_hardening.sql — resolve Supabase security advisor warnings
--
-- Run after 0001–0006. Addresses the database linter findings:
--   0011 function_search_path_mutable
--   0028 anon_security_definer_function_executable
--   0029 authenticated_security_definer_function_executable
--
-- Remaining accepted warning: owns_account() stays EXECUTE-able by the
-- `authenticated` role — it is the RLS helper referenced by every
-- account-scoped policy and self-scopes to auth.uid(), so a direct RPC call
-- discloses nothing. This is the standard Supabase RLS-helper pattern.
-- ============================================================================

-- Pin search_path on the trigger helper (advisor 0011).
create or replace function touch_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin new.updated_at = now(); return new; end; $$;

-- handle_new_user is a trigger function — it must never be reachable as an
-- RPC. Trigger execution does not require EXECUTE, so revoke it from everyone
-- (advisors 0028 / 0029).
revoke all on function handle_new_user() from public, anon, authenticated;

-- owns_account is an RLS helper. anon has no account context (auth.uid() is
-- null), so it never needs to call it (advisor 0028). authenticated must keep
-- EXECUTE — the helper is referenced by every account-scoped RLS policy.
revoke all on function owns_account(uuid) from public, anon;
grant execute on function owns_account(uuid) to authenticated, service_role;
