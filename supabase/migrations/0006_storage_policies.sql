-- ============================================================================
-- 0006_storage_policies.sql — Storage buckets and access policies
-- See DASHBOARD_SPECIFICATION.md §13.17.
--
-- Buckets hold large JSON blobs that would breach the GitHub Contents API
-- 1 MB limit: full backtest payloads and research/screener snapshots.
--   Read:  authenticated users.
--   Write: service role only (the agent / backtest workflow). The service
--          role bypasses RLS on storage.objects, so no write policy is needed.
-- ============================================================================

-- Private buckets (no public URL access).
insert into storage.buckets (id, name, public)
values ('backtest-results', 'backtest-results', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('research-snapshots', 'research-snapshots', false)
on conflict (id) do nothing;

-- Authenticated users may read objects in these two buckets.
drop policy if exists "read backtest results" on storage.objects;
create policy "read backtest results" on storage.objects
  for select
  using (bucket_id = 'backtest-results' and auth.uid() is not null);

drop policy if exists "read research snapshots" on storage.objects;
create policy "read research snapshots" on storage.objects
  for select
  using (bucket_id = 'research-snapshots' and auth.uid() is not null);
