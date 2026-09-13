-- Explicit 2026 reconciliation of demonstrated legacy omissions. This is not
-- evidence that migrations 0001–0008 historically ran. The runner hashes this
-- file and records its actual execution separately from migrations 0009–0023.
-- The authenticated session is supabase_admin; ordinary authored application
-- DDL runs as postgres before and after this narrowly scoped platform repair.
lock table auth.users in share row exclusive mode;

do $reconciliation_guard$ begin
  if exists (select 1 from pg_trigger
      where tgrelid='auth.users'::regclass and tgname='on_auth_user_created')
     or exists (select 1 from pg_policy where polrelid='storage.objects'::regclass
      and polname in ('read backtest results','read research snapshots')) then
    raise exception 'Explicit legacy reconciliation requires all three reviewed omissions';
  end if;
  if (select count(*) from storage.buckets
      where id in ('backtest-results','research-snapshots') and public=false)<>2 then
    raise exception 'Expected private artifact buckets are missing or public';
  end if;
  if (select count(*) from auth.users u left join public.profiles p on p.id=u.id
      where p.id is null)<>current_setting('nate_upgrade.expected_missing_profiles')::integer then
    raise exception 'Missing-profile count differs from the reviewed reconciliation';
  end if;
end $reconciliation_guard$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

set local role supabase_admin;
lock table storage.objects in access exclusive mode;
create policy "read backtest results" on storage.objects
  for select
  using (bucket_id = 'backtest-results' and auth.uid() is not null);
create policy "read research snapshots" on storage.objects
  for select
  using (bucket_id = 'research-snapshots' and auth.uid() is not null);
set local role postgres;

-- Exactly the original handle_new_user() mapping; existing profiles are never
-- changed, and no default account or brokerage account is manufactured.
do $reconciliation_profiles$ declare repaired integer; begin
  insert into public.profiles(id,display_name)
    select u.id,coalesce(u.raw_user_meta_data->>'display_name',u.email)
    from auth.users u where not exists(select 1 from public.profiles p where p.id=u.id);
  get diagnostics repaired = row_count;
  if repaired<>current_setting('nate_upgrade.expected_missing_profiles')::integer
     or exists(select 1 from auth.users u left join public.profiles p on p.id=u.id
               where p.id is null) then
    raise exception 'Profile reconciliation did not satisfy the exact ownership contract';
  end if;
end $reconciliation_profiles$;
