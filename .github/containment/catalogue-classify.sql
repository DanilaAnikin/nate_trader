-- ============================================================================
-- catalogue-classify.sql — a state classifier for public-schema routines
--
-- WHY THIS EXISTS
-- ---------------
-- The previous schema-compat harness called `vault_create_secret` as
-- `service_role`, saw SQLSTATE 42501, and reported a deploy blocker. On the
-- latest schema that 42501 is the *intended* outcome: migration 0022 section 5
-- rewrites the three Vault wrappers into `raise exception '… is superseded …'`
-- and revokes EXECUTE from public, anon, authenticated AND service_role.
--
-- But 42501 on its own is worth nothing. It is produced identically by:
--   * the intended tombstone,
--   * an accidental REVOKE on a perfectly live routine,
--   * a routine someone replaced with a no-op and then locked down,
--   * a routine whose owner changed under you.
-- So this file never concludes anything from a SQLSTATE alone. A SQLSTATE is
-- recorded as evidence; the verdict is a property of the whole catalogue
-- record for one EXACT regprocedure signature, of the complete role landscape
-- that can reach it, and of a controlled probe that has to produce an exact
-- effect.
--
-- THE STATES
-- ----------
--   MISSING                   the exact signature is not there. Always a
--                             blocker. Covers: nothing of that name; only a
--                             different overload; a bare name that is
--                             ambiguous; the name now belongs to a procedure,
--                             an aggregate or a relation rather than the
--                             expected function.
--
--   LIVE_EXPECTED             the object matches the LIVE profile in full —
--                             signature, arguments, return type, owner,
--                             language, security mode, volatility,
--                             search_path/proconfig, explicit EXECUTE grants,
--                             the exact set of roles that can reach EXECUTE,
--                             and a semantic probe that reaches the real
--                             implementation and produces the exact expected
--                             effect — and LIVE is what this generation
--                             expects.
--
--   INTENTIONALLY_TOMBSTONED  the object matches the TOMBSTONE profile in full
--                             and a tombstone is what this generation expects.
--                             That means: exact 0022 semantics (a normalised
--                             body equal to the tombstone migration 0022
--                             itself writes — the expected text is DERIVED
--                             from 0022 at run time, never copied into this
--                             file), owner and administrative properties equal
--                             to the migration's result, NO ordinary
--                             application role able to execute it by grant, by
--                             PUBLIC, by default privilege, by direct or
--                             inherited role membership or by SET ROLE, no
--                             unexpected role of ANY kind — supabase_auth_admin
--                             and freshly created roles included — no
--                             unexpected overload, no same-name routine in
--                             another schema that an ordinary role could call,
--                             and a PRIVILEGED invocation that reaches the body
--                             and returns the exact SQLSTATE and exact message
--                             with zero side effects.
--
--   UNEXPECTED_EXECUTABLE     some routine reachable under this name — the
--                             exact signature, another overload, or a same-name
--                             routine in another schema — can be executed by a
--                             role that is not allowed to. The security-
--                             relevant blocker.
--
--   UNEXPECTED_PRESENT        an unexpected routine is present under this name,
--                             but nothing unexpected can execute it: an extra
--                             overload, an alternate-schema shadow, or the
--                             *other* profile than the one expected here (a
--                             live wrapper on the latest schema, a tombstoned
--                             wrapper on 0001-0008).
--
--   DEFINITION_DRIFT          the definition or an administrative property is
--                             not what either profile calls for: owner,
--                             language, security mode, volatility,
--                             search_path, arguments, return type, body, or a
--                             probe that reached the body and answered wrongly.
--
--   ACL_DRIFT                 the definition is intact and no unexpected role
--                             can execute it, but the privilege surface is not
--                             what was expected: a grant that should be there
--                             is gone, the default-privilege surface moved, the
--                             superuser set moved, or a call was refused with
--                             42501 where the profile expects it to succeed.
--
--   EXPECTEDLY_ABSENT         the signature is not in the catalogue and this
--                             generation says it must not be. Used for the
--                             routines migration 0022 tombstones that were
--                             introduced AFTER the 0001-0008 reference schema:
--                             on that generation the honest expectation is
--                             "not there at all", and back-porting one onto it
--                             is a finding, not a pass. The pair
--                             (EXPECTEDLY_ABSENT, UNEXPECTED_PRESENT) is what
--                             lets every name 0022 tombstones carry a verdict
--                             row in BOTH generations — see control C20.
--
--   AUTHZ_CLOSURE_BROKEN      the object itself is exactly what it should be,
--                             and the authorization it provides is gone anyway,
--                             because something in its PINNED DEPENDENCY
--                             CLOSURE moved: the definition of a function the
--                             body calls (`auth.uid()`), the identity of a
--                             relation it reads (`public.accounts`), RLS being
--                             ENABLED on a table whose policy routes through
--                             it, or the exact set of those policies. A
--                             blocker, and deliberately not folded into
--                             DEFINITION_DRIFT: nothing about this object's
--                             definition drifted.
--
--   UNPROVEN                  no verdict: the probe that would have decided did
--                             not run (probe_mode, or a body this file refuses
--                             to invoke). Never a pass.
--
-- COVERAGE IS ITSELF A CONTROL
-- ----------------------------
-- A classifier is blind to whatever its expectation catalogue does not name,
-- and that blindness is silent: an object with no cc_expect row gets no
-- cc_verdict row, so its ACL, body, owner and executability are never looked
-- at and the run still says PASS. That is exactly how this file shipped with
-- four rows against a migration that tombstones five routines.
--
-- The repair is not "add the missing rows" — it is to make the omission
-- impossible to repeat. `tomb_names` is READ OUT OF migration 0022 at run time
-- (never retyped here), and control C20 requires every name in it to carry a
-- cc_expect row AND a cc_verdict row in every generation. C21 requires the two
-- sets to agree on WHICH state is expected. C23 is the positive control on the
-- comparator behind both, so "no name is missing" is an absence claim from a
-- scanner that has been shown to see a planted absence.
--
-- Observation is computed WITHOUT consulting the expectation for the
-- generation under test; only then is it compared. That independence is what
-- makes "LIVE where a tombstone was expected" observable rather than invisible,
-- and it is why a shared SQLSTATE such as 42501 can never determine a verdict
-- by itself: 42501 arrives at the classifier as one field of one probe record,
-- next to the body text, the owner, the ACL and the full role landscape.
--
-- HOW IT IS DRIVEN
-- ----------------
-- Every psql variable below is supplied by catalogue-classify.sh. The tomb_*
-- variables are extracted from supabase/migrations/0022_*.sql at run time so
-- this file holds no copy of the tombstone that could drift away from it.
--
--   generation         '0008' | 'latest'
--   probe_mode         'normal' | 'skip' | 'break'   (test seam; see below)
--   tomb_names         comma-separated proname list read out of 0022 section 5
--   tomb_postcond_names the SAME list as restated by 0022's section 6
--                      post-condition, extracted independently. The two must
--                      be equal (control C20); that is what makes "these are
--                      all the routines 0022 tombstones" a checked claim.
--   tomb_lang          language keyword read out of the 0022 template
--   tomb_searchpath    search_path clause read out of the 0022 template
--   tomb_secdef        't'/'f' — SECURITY DEFINER present in the template?
--   tomb_volatility    'i'/'s'/'v' — volatility keyword, defaulted like the SQL default
--   tomb_errcode       SQLSTATE literal read out of the 0022 template body
--   tomb_msg_template  message literal read out of the 0022 template body
--   tomb_body_template body text of the 0022 template, one %s = proname
--   tomb_body_shape    POSIX regex the body must match to be SAFE TO CALL
--   tomb_revoke_roles  role list of 0022's REVOKE, comma separated
--   image_id           docker image id, recorded in the report
--   mutation_label     free text recorded in the report ('' for pristine)
--   base_inputs_sha256 digest of the migration set + bootstrap + fixture the
--                      base image was built from, recorded in the report
--
-- probe_mode is a TEST SEAM and is therefore non-promotable: any value other
-- than 'normal' forces the run result away from PASS even if every object
-- looked fine, because an unprobed tombstone has not been proven to be one.
--
-- Runs as `supabase_admin`. That is deliberate: the privileged tombstone probe
-- has to reach the function body regardless of its ACL, and a superuser is the
-- only caller for which "the call was refused" cannot be an ACL artefact.
--
-- The probes write. They create, update and delete Vault secrets whose value
-- is the literal string 'CC-PROBE-NOT-A-CREDENTIAL'. That is only ever done
-- inside a disposable clone that catalogue-classify.sh built and destroys.
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off
\timing off

-- ---------------------------------------------------------------------------
-- 0. inputs
-- ---------------------------------------------------------------------------
create temporary table cc_cfg(k text primary key, v text);
insert into cc_cfg(k, v) values
  ('generation',         :'generation'),
  ('probe_mode',         :'probe_mode'),
  ('tomb_names',         :'tomb_names'),
  ('tomb_postcond_names', :'tomb_postcond_names'),
  ('tomb_template_names', :'tomb_template_names'),
  ('tomb_names_by_source', :'tomb_names_by_source'),
  ('tomb_mechanisms',    :'tomb_mechanisms'),
  ('tomb_sources',       :'tomb_sources'),
  ('tomb_migration_count', :'tomb_migration_count'),
  ('tomb_targets_json',  :'tomb_targets_json'),
  ('tomb_acl_by_target', :'tomb_acl_by_target'),
  ('live_body_json',     :'live_body_json'),
  ('tomb_lang',          :'tomb_lang'),
  ('tomb_searchpath',    :'tomb_searchpath'),
  ('tomb_secdef',        :'tomb_secdef'),
  ('tomb_volatility',    :'tomb_volatility'),
  ('tomb_errcode',       :'tomb_errcode'),
  ('tomb_msg_template',  :'tomb_msg_template'),
  ('tomb_body_template', :'tomb_body_template'),
  ('tomb_body_shape',    :'tomb_body_shape'),
  ('tomb_revoke_roles',  :'tomb_revoke_roles'),
  ('image_id',           :'image_id'),
  ('base_inputs_sha256', :'base_inputs_sha256'),
  ('mutation_label',     :'mutation_label');

-- Collation is locale dependent, and several fingerprints below are ORDERED
-- strings. Every text sort in this file therefore carries an explicit
-- COLLATE "C", so a verdict is a property of the database rather than of the
-- locale the image happened to be initialised with.

create function pg_temp.cc_norm(text) returns text
language sql immutable as $fn$
  select btrim(regexp_replace($1, '\s+', ' ', 'g'))
$fn$;

-- search_path lists are rendered differently depending on who wrote them
-- ("public, vault" vs "public,vault" vs "'public', 'vault'"). Compare the list,
-- not the rendering.
create function pg_temp.cc_normsp(text) returns text
language sql immutable as $fn$
  select case when $1 is null then null else
    (select string_agg(btrim(btrim(btrim(t), '"'), ''''), ',' order by ord)
       from unnest(string_to_array(lower($1), ',')) with ordinality as u(t, ord))
  end
$fn$;

create function pg_temp.cc_cfg(text) returns text
language sql stable as $fn$
  select v from cc_cfg where k = $1
$fn$;

-- ---------------------------------------------------------------------------
-- 0a. the DERIVED tombstone contract, one row per target
--
-- Round 2 held every tombstone to ONE template — migration 0022 section 5's.
-- That template is one MECHANISM for producing a refusal shim, not the
-- definition of one, and holding every shim to it has two failure modes, both
-- of which were live:
--
--   * a shim produced by a different mechanism carried no row at all, so
--     granting EXECUTE on public.resolve_create_operation(uuid,uuid) — which
--     0022 tombstones INLINE, sixty lines above the loop, with a different
--     message — produced a clean PASS, and so did reviving it outright;
--   * the shims migration 0017 installs over reconcile_cash_flow_mirror and
--     replace_equity_snapshots deliberately KEEP `service_role`. One global
--     "no client role may execute a tombstone" rule would either fail the
--     pristine schema or be relaxed until it passed.
--
-- So the contract arrives per target, derived by extract-tombstone-template.py
-- from the whole migration set: its own body, message, SQLSTATE, security
-- mode, search_path — and its own expected grantee set, walked out of the ACL
-- statements of the migration that tombstoned it.
-- ---------------------------------------------------------------------------
create temporary table cc_tomb_target as
select
  (t->>'proname')                                        as proname,
  nullif(t->>'sig', '')                                  as sig,
  (t->>'scope')                                          as scope,
  (t->>'mechanism')                                      as mechanism,
  (t->>'source')                                         as source,
  (t->>'lang')                                           as lang,
  (t->>'searchpath')                                     as searchpath,
  (t->>'secdef')::boolean                                as secdef,
  (t->>'volatility')                                     as volatility,
  (t->>'errcode')                                        as errcode,
  (t->>'message')                                        as message,
  (t->>'body_norm')                                      as body_norm,
  (t->>'body_shape')                                     as body_shape,
  (t->>'acl_note')                                       as acl_note,
  (t->>'client_grantees_derivable')::boolean             as acl_fully_revoked,
  coalesce((select array_agg(x order by x collate "C")
              from jsonb_array_elements_text(t->'expected_grantees') x),
           '{}'::text[])                                 as expected_grantees
from jsonb_array_elements(pg_temp.cc_cfg('tomb_targets_json')::jsonb) t;

-- The last LIVE definition of each signature, per generation, derived from the
-- migration set by the same extractor. The classifier pins those bodies by
-- digest; control C26 requires each pin to equal the derived value, so a pin
-- that was retyped and then drifted cannot go unnoticed.
create temporary table cc_live_body(sig text primary key, sha256 text not null);
insert into cc_live_body(sig, sha256)
select key, value from jsonb_each_text(pg_temp.cc_cfg('live_body_json')::jsonb);

-- ---------------------------------------------------------------------------
-- 0b. the PINNED entitled set
--
-- "Which roles are allowed to reach EXECUTE" used to be answered dynamically:
-- superusers, plus whoever holds membership in the owner. Both halves are
-- attacker-movable, and moving either one produced the RIGHT verdict for the
-- WRONG reason. `grant postgres to anon` makes anon a member of the owner, so
-- anon really can execute the tombstone — and the dynamic answer called that
-- allowed, leaving only the role-graph fingerprint to notice, which ranks as
-- ACL_DRIFT. Same for `create role x superuser`. A role that can genuinely
-- execute a tombstone is UNEXPECTED_EXECUTABLE; anything less understates it.
--
-- So the entitled set is PINNED per generation and the object's own owner is
-- added to it. A role that joins the owner's family, or becomes a superuser,
-- is then an unexpected executor by construction — and the role-graph and
-- superuser fingerprints stay as the second, independent signal.
-- ---------------------------------------------------------------------------
create temporary table cc_entitled_pin(generation text primary key, entitled text[]);
insert into cc_entitled_pin values
  ('0008',   array['postgres','supabase_admin']),
  ('latest', array['postgres','supabase_admin']);

create function pg_temp.cc_entitled() returns text[]
language sql stable as $fn$
  select entitled from cc_entitled_pin
   where generation = (select v from cc_cfg where k = 'generation')
$fn$;

-- ---------------------------------------------------------------------------
-- 0b. the role-landscape primitives
--
-- Every one of these enumerates pg_roles DYNAMICALLY. Nothing here carries a
-- list of "the roles we thought of": a role created five minutes ago is in the
-- scan by construction, which is the whole point — the previous assertion
-- looked at PUBLIC, anon, authenticated and service_role only, and a grant to
-- supabase_auth_admin walked straight past it.
-- ---------------------------------------------------------------------------

-- Roles that can execute the routine *as themselves*: direct grant, PUBLIC,
-- inherited role membership (recursively), or superuser. This is PostgreSQL's
-- own answer, not a re-implementation of its ACL evaluation.
create function pg_temp.cc_execers(p_oid oid) returns text[]
language sql stable as $fn$
  select coalesce(array_agg(r.rolname::text order by r.rolname::text collate "C"),
                  '{}'::text[])
    from pg_roles r
   where has_function_privilege(r.oid, $1, 'EXECUTE')
$fn$;

-- Roles that can execute it after SET ROLE: membership WITHOUT inheritance
-- still hands over the privilege, it just asks the session to say so first.
-- `acldefault` is used when proacl is null, because a null proacl is not "no
-- privileges" — it is PostgreSQL's built-in default, which grants EXECUTE to
-- PUBLIC.
create function pg_temp.cc_assumers(p_oid oid) returns text[]
language sql stable as $fn$
  select coalesce(array_agg(r.rolname::text order by r.rolname::text collate "C"),
                  '{}'::text[])
    from pg_roles r
   where r.rolsuper
      or exists (
           select 1
             from pg_proc p,
                  lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where p.oid = $1
              and a.privilege_type = 'EXECUTE'
              and (a.grantee = 0 or pg_has_role(r.oid, a.grantee, 'MEMBER')))
$fn$;

-- Does PUBLIC hold EXECUTE — including the case where proacl is null and the
-- built-in default is what is in force?
create function pg_temp.cc_public_exec(p_oid oid) returns boolean
language sql stable as $fn$
  select exists (
    select 1
      from pg_proc p,
           lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = $1 and a.privilege_type = 'EXECUTE' and a.grantee = 0)
$fn$;

-- The roles that are ALLOWED to reach EXECUTE, given an owner and the exact
-- list of application roles the profile grants to.
--
--   inherited: the PINNED entitled set, the object's own owner, and exactly the
--              declared grantees. Deliberately NOT "whoever holds membership in
--              the owner" and NOT "whoever is a superuser": both are movable by
--              the same operator the classifier is watching, and a role that
--              acquires either really can execute the object. Also deliberately
--              NOT the declared grantees' member families: a role that becomes
--              a member of `authenticated` gains EXECUTE without any grant on
--              the routine, and that is drift, not policy.
--   assumable: the same pinned base, plus the declared grantees' member
--              families — `authenticator` may SET ROLE to `authenticated` by
--              design, so its ability to call what `authenticated` may call is
--              the schema's intent.
create function pg_temp.cc_allowed_execers(p_owner oid, p_grantees text[])
returns text[] language sql stable as $fn$
  select coalesce(array_agg(r.rolname::text order by r.rolname::text collate "C"),
                  '{}'::text[])
    from pg_roles r
   where r.rolname::text = any (pg_temp.cc_entitled())
      or ($1 is not null and r.oid = $1)
      or r.rolname::text = any ($2)
$fn$;

create function pg_temp.cc_allowed_assumers(p_owner oid, p_grantees text[])
returns text[] language sql stable as $fn$
  select coalesce(array_agg(r.rolname::text order by r.rolname::text collate "C"),
                  '{}'::text[])
    from pg_roles r
   where r.rolname::text = any (pg_temp.cc_entitled())
      or ($1 is not null and r.oid = $1)
      or exists (select 1 from unnest($2) g
                  where to_regrole(g) is not null
                    and pg_has_role(r.oid, to_regrole(g)::oid, 'MEMBER'))
$fn$;

-- Roles that can execute ANY object owned by p_owner purely because of where
-- they sit in the ROLE GRAPH — a superuser, or a member of the owner — and
-- that the pinned entitled set does not already account for. Empty on a
-- pristine cluster.
--
-- WHY THIS EXISTS, AND WHY IT IS NOT A WEAKENING. C12 and C13 are controls on
-- the ACL SCANNER: they plant grants on a throwaway routine and assert the
-- scanner's answer EXACTLY. `grant postgres to <newrole>` makes that role able
-- to execute every postgres-owned object in the cluster — the throwaway probe
-- included — so both exact equalities broke and the whole run came back
-- CONTROL_FAILED, "the classifier could not be trusted this run", for a
-- mutation whose real verdict is UNEXPECTED_EXECUTABLE on the tombstone. That
-- is fail-closed with the wrong name on it, and it buries the actual blocker
-- behind an exit 3.
--
-- Subtracting this set isolates the scanner controls from cluster-wide role
-- tampering. It cannot hide a broken scanner, because the set is derived from
-- pg_roles/pg_has_role and NOT from the scanner under test: a scanner that
-- named a role which genuinely cannot execute the probe would still break the
-- equality. And the tampering is not lost — it is reported where it belongs,
-- on the objects, as `tomb:acl_unexpected_executor` (the entitled set is
-- PINNED, so a role that joins the owner's family is an unexpected executor by
-- construction) and as `env:role_membership_drift` / `env:superuser_set_drift`.
create function pg_temp.cc_env_family(p_owner oid) returns text[]
language sql stable as $fn$
  select coalesce(array_agg(r.rolname::text order by r.rolname::text collate "C"),
                  '{}'::text[])
    from pg_roles r
   where (r.rolsuper or ($1 is not null and pg_has_role(r.oid, $1, 'MEMBER')))
     and not (r.rolname::text = any (pg_temp.cc_entitled()))
$fn$;

create function pg_temp.cc_minus(a text[], b text[]) returns text[]
language sql immutable as $fn$
  select coalesce((select array_agg(x order by x collate "C")
                     from unnest($1) x where not (x = any ($2))), '{}'::text[])
$fn$;

-- Every OTHER routine answering to this name: other overloads in the same
-- schema and same-name routines in any other schema. For each, the roles that
-- can execute it and are not entitled to (its own owner family and superusers
-- are; nobody else is, because the routine should not be there at all).
create function pg_temp.cc_sibling_exec(p_nsp text, p_proname text, p_exclude oid)
returns text[] language sql stable as $fn$
  select coalesce(array_agg(d order by d collate "C"), '{}'::text[])
    from (
      select p2.oid::regprocedure::text || ' => ' ||
             array_to_string(pg_temp.cc_minus(pg_temp.cc_execers(p2.oid),
                                              pg_temp.cc_allowed_execers(p2.proowner, '{}'::text[])),
                             ',') as d
        from pg_proc p2
        join pg_namespace n2 on n2.oid = p2.pronamespace
       where p2.proname = $2
         and p2.oid is distinct from $3
         and cardinality(pg_temp.cc_minus(pg_temp.cc_execers(p2.oid),
                                          pg_temp.cc_allowed_execers(p2.proowner, '{}'::text[]))) > 0
    ) s
$fn$;

create function pg_temp.cc_superusers() returns text
language sql stable as $fn$
  select coalesce(string_agg(rolname::text, ',' order by rolname::text collate "C"), '')
    from pg_roles where rolsuper
$fn$;

-- ADV-2(D). The roles carrying the BYPASSRLS attribute.
--
-- MEASURED, on this exact fixture, before this function existed, with a
-- reversion control on every count. With `alter role authenticated bypassrls`
-- the attacker (fixture owner 4444, JWT subject set) read, in one session in
-- which owns_account(victim) answered false and the classifier returned PASS:
--   public.equity_snapshots   0 -> 21 -> 0
--   public.profiles           1 -> 2  -> 1   (both tenants, not only its own)
--   public.audit_log          0 -> 1  -> 0
-- where the third column is after `alter role authenticated nobypassrls`. The
-- blast radius is the whole database, not this closure.
--
-- rolbypassrls was pinned NOWHERE in this artefact. rolsuper was (a superuser
-- bypasses RLS too, and cc_superusers above is that pin), and the role
-- MEMBERSHIP graph was — but BYPASSRLS is a role ATTRIBUTE, not a membership
-- and not superuser, so neither fingerprint moved when it was granted.
--
-- The scan is over pg_roles with no list anywhere, so it covers every role in
-- the cluster including ones that did not exist when the pin was written: a new
-- role created WITH BYPASSRLS makes the string longer and the comparison fails.
-- The pinned value is NOT empty — postgres, service_role, supabase_admin,
-- supabase_etl_admin and supabase_read_only_user carry it in the stock
-- Supabase image — so this is a drift assertion against a measured baseline,
-- not an "it must be nobody" assertion that would be red from the first run.
create function pg_temp.cc_bypassrls() returns text
language sql stable as $fn$
  select coalesce(string_agg(rolname::text, ',' order by rolname::text collate "C"), '')
    from pg_roles where rolbypassrls
$fn$;

-- Who inherits from whom, and who may SET ROLE into whom. The per-routine
-- comparison treats the owner's role family as entitled — which is right, and
-- which leaves exactly one escape: make an ordinary role a member of the OWNER
-- and it joins that family. Pinning the whole graph closes it, and catches
-- every other membership change with it.
create function pg_temp.cc_role_graph() returns text
language sql stable as $fn$
  select coalesce(string_agg(m || '>' || r || '/' || g || '/' || a || i || x, ','
                             order by m collate "C", r collate "C"), '')
    from (
      select pg_get_userbyid(am.member)::text                          as m,
             pg_get_userbyid(am.roleid)::text                          as r,
             pg_get_userbyid(am.grantor)::text                         as g,
             case when am.admin_option   then 'A' else '-' end         as a,
             case when am.inherit_option then 'I' else '-' end         as i,
             case when am.set_option     then 'S' else '-' end         as x
        from pg_auth_members am
    ) t
$fn$;

create function pg_temp.cc_defacl_fingerprint() returns text
language sql stable as $fn$
  select coalesce(string_agg(ns || '/' || defrole || '/' || grantee, ','
                             order by ns collate "C", defrole collate "C",
                                      grantee collate "C"), '')
    from (
      select case when d.defaclnamespace = 0 then '-'
                  else d.defaclnamespace::regnamespace::text end            as ns,
             pg_get_userbyid(d.defaclrole)::text                            as defrole,
             (case when a.grantee = 0 then 'PUBLIC'
                   else pg_get_userbyid(a.grantee) end)::text               as grantee
        from pg_default_acl d, aclexplode(d.defaclacl) a
       where d.defaclobjtype = 'f'
         and a.privilege_type = 'EXECUTE'
    ) s
$fn$;

-- ---------------------------------------------------------------------------
-- 1. controls — nothing below is believed until these pass
--
-- A classifier that cannot fail is worse than no classifier. Each control has
-- a known answer; a failure aborts with CONTROL_FAILED and the run is not a
-- verdict at all.
--
-- C11-C16 are POSITIVE CONTROLS on the privilege scanner itself. "No
-- unexpected role can execute this" is an absence claim, and an absence claim
-- from a scanner nobody proved works is worth nothing — so before any verdict
-- depends on it, the scanner is shown, on a throwaway object in a throwaway
-- schema, to SEE a grant to supabase_auth_admin, a grant reached through group
-- membership, a grant to PUBLIC, and the built-in default that a null proacl
-- leaves in force.
-- ---------------------------------------------------------------------------
create temporary table cc_control(name text primary key, ok boolean, detail text);

do $cc$
declare
  body_x     text;
  shape      text;
  missing    text;
begin
  shape := pg_temp.cc_cfg('tomb_body_shape');

  -- C1 the normaliser really normalises
  insert into cc_control values ('C01_normaliser',
    pg_temp.cc_norm(E'  a \n\t b  ') = 'a b',
    'cc_norm(''  a \n\t b  '') = ' || quote_literal(pg_temp.cc_norm(E'  a \n\t b  ')));

  -- C2 the resolver finds a signature that must exist in every generation
  insert into cc_control values ('C02_resolver_positive',
    to_regprocedure('public.owns_account(uuid)') is not null,
    'to_regprocedure(public.owns_account(uuid))');

  -- C3 the resolver returns null for something that cannot exist
  insert into cc_control values ('C03_resolver_negative',
    to_regprocedure('public.__cc_absent_probe_fn(uuid)') is null,
    'to_regprocedure(public.__cc_absent_probe_fn(uuid))');

  -- C4 lives in the second control block, on a synthetic signature pair. It
  --    used to assert against public.owns_account, which made a mutant that
  --    merely ADDS an overload of that name fail the control instead of being
  --    classified — a control must not be falsifiable by the very drift the
  --    classifier exists to report.

  -- C5 the derived tombstone body matches the derived safe-call shape
  body_x := pg_temp.cc_norm(format(pg_temp.cc_cfg('tomb_body_template'), 'X'));
  insert into cc_control values ('C05_derived_body_matches_shape',
    body_x ~ shape,
    'derived body for X: ' || body_x);

  -- C6 the shape is not a tautology: a live body must not match it
  insert into cc_control values ('C06_shape_rejects_live_body',
    pg_temp.cc_norm('begin return null; end;') !~ shape,
    'shape = ' || shape);

  -- C7 the derived body is name-bound: two names must not produce equal text
  insert into cc_control values ('C07_body_is_name_bound',
    pg_temp.cc_norm(format(pg_temp.cc_cfg('tomb_body_template'), 'X'))
      <> pg_temp.cc_norm(format(pg_temp.cc_cfg('tomb_body_template'), 'Y')),
    'derived bodies for X and Y differ');

  -- C8 every input arrived
  select string_agg(k, ',' order by k) into missing
    from cc_cfg where k <> 'mutation_label' and (v is null or btrim(v) = '');
  insert into cc_control values ('C08_inputs_present',
    missing is null, coalesce('empty inputs: ' || missing, 'all inputs non-empty'));

  -- C9 the fixture the semantic probes depend on is really seeded
  insert into cc_control values ('C09_fixture_seeded',
    exists (select 1 from public.accounts
             where id = '22222222-2222-4222-8222-222222222222'
               and owner_id = '11111111-1111-4111-8111-111111111111'),
    'seeded fixture account present');

  -- C10 generation is one of the two shapes this file knows
  insert into cc_control values ('C10_known_generation',
    pg_temp.cc_cfg('generation') in ('0008','latest'),
    'generation = ' || pg_temp.cc_cfg('generation'));
end
$cc$;

-- C11..C17 — the ownership fixture and the privilege scanner, proven on
-- throwaway objects before any absence claim is believed.
do $cc$
declare
  fnoid     oid;
  nulloid   oid;
  unexp     text[];
  assum     text[];
  env_fam   text[];
  owner_a   uuid;
  owner_b   uuid;
  n_sec_b   bigint;
  n_sec_a   bigint;
  sid       uuid;
begin
  ---------------------------------------------------------------- C11 fixture
  -- The ownership probe can only tell "checks the owner" from "checks the row
  -- exists" if there are two accounts under two different owners.
  select owner_id into owner_a from public.accounts
   where id = '22222222-2222-4222-8222-222222222222';
  select owner_id into owner_b from public.accounts
   where id = '55555555-5555-4555-8555-555555555555';
  insert into cc_control values ('C11_two_owners_seeded',
    owner_a is not null and owner_b is not null and owner_a is distinct from owner_b
      and not exists (select 1 from public.accounts
                       where id = '33333333-3333-4333-8333-333333333333'),
    format('owner(A)=%s owner(B)=%s absent-id absent=%s', owner_a, owner_b,
           not exists (select 1 from public.accounts
                        where id = '33333333-3333-4333-8333-333333333333')));

  ------------------------------------------------------- C04 exact signatures
  execute 'create schema cc_ctl';
  -- EXACT signatures, not bare names: one synthetic routine, and the resolver
  -- must refuse the same name with a different argument list while still
  -- resolving it by name. Built here rather than on a subject routine so that
  -- a mutation of the subject cannot silently disarm the control.
  execute 'create function cc_ctl.cc_sig_probe(p uuid) returns void language plpgsql as $b$ begin end; $b$';
  insert into cc_control values ('C04_exact_signature',
    to_regprocedure('cc_ctl.cc_sig_probe(uuid)') is not null
      and to_regprocedure('cc_ctl.cc_sig_probe(text)') is null
      and to_regproc('cc_ctl.cc_sig_probe') is not null,
    format('cc_sig_probe(uuid)=%s cc_sig_probe(text)=%s bare=%s',
           to_regprocedure('cc_ctl.cc_sig_probe(uuid)'),
           coalesce(to_regprocedure('cc_ctl.cc_sig_probe(text)')::text, '<null>'),
           to_regproc('cc_ctl.cc_sig_probe')));

  ------------------------------------------------------- C12..C16 acl scanner
  execute 'create function cc_ctl.cc_acl_probe() returns void language plpgsql as $b$ begin end; $b$';
  execute 'revoke all on function cc_ctl.cc_acl_probe() from public';
  execute 'alter function cc_ctl.cc_acl_probe() owner to postgres';
  select p.oid into fnoid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'cc_ctl' and p.proname = 'cc_acl_probe';

  -- C12 NEGATIVE control: a locked-down routine has no unexpected executor.
  --     Without this, C13's positive result could just mean "the scanner says
  --     everything is unexpected".
  --
  --     `cc_env_family` is subtracted so that a cluster-wide role-graph tamper
  --     (`grant postgres to X`) does not turn this control red and downgrade
  --     the whole run to CONTROL_FAILED. X really can execute this throwaway
  --     probe, and saying "the scanner is untrustworthy" would be the wrong
  --     sentence: the scanner is right, the CLUSTER moved. That fact is
  --     reported on the objects, as an unexpected executor of the tombstone
  --     and as role-membership drift. See cc_env_family for why this cannot
  --     mask a broken scanner.
  env_fam := pg_temp.cc_env_family('postgres'::regrole::oid);
  unexp := pg_temp.cc_minus(pg_temp.cc_execers(fnoid),
                            pg_temp.cc_allowed_execers('postgres'::regrole::oid, '{}'::text[])
                            || env_fam);
  insert into cc_control values ('C12_acl_scanner_negative',
    cardinality(unexp) = 0,
    format('locked-down probe routine, unexpected executors: [%s]; role-graph '
           'family excluded here and reported per object instead: [%s]',
           array_to_string(unexp, ','), array_to_string(env_fam, ',')));

  -- C13 POSITIVE control: a grant to supabase_auth_admin — the exact role the
  --     old four-role assertion never looked at — is SEEN. Exact equality, with
  --     the same role-graph family subtracted for the same reason as C12.
  execute 'grant execute on function cc_ctl.cc_acl_probe() to supabase_auth_admin';
  unexp := pg_temp.cc_minus(pg_temp.cc_execers(fnoid),
                            pg_temp.cc_allowed_execers('postgres'::regrole::oid, '{}'::text[])
                            || env_fam);
  insert into cc_control values ('C13_acl_scanner_sees_auth_admin',
    unexp = array['supabase_auth_admin']::text[],
    format('after granting to supabase_auth_admin, unexpected executors: [%s]; '
           'role-graph family excluded: [%s]',
           array_to_string(unexp, ','), array_to_string(env_fam, ',')));
  execute 'revoke execute on function cc_ctl.cc_acl_probe() from supabase_auth_admin';

  -- C14 POSITIVE control: a grant reached only through group membership is
  --     seen, both as an inherited executor and as an assumable one.
  execute 'create role cc_ctl_group nologin';
  execute 'grant execute on function cc_ctl.cc_acl_probe() to cc_ctl_group';
  execute 'grant cc_ctl_group to anon';
  execute 'grant cc_ctl_group to supabase_auth_admin';  -- NOINHERIT: SET ROLE only
  unexp := pg_temp.cc_minus(pg_temp.cc_execers(fnoid),
                            pg_temp.cc_allowed_execers('postgres'::regrole::oid, '{}'::text[]));
  assum := pg_temp.cc_minus(pg_temp.cc_assumers(fnoid),
                            pg_temp.cc_allowed_assumers('postgres'::regrole::oid, '{}'::text[]));
  insert into cc_control values ('C14_acl_scanner_sees_membership',
    'anon' = any (unexp) and 'cc_ctl_group' = any (unexp)
      and 'supabase_auth_admin' = any (assum),
    format('inherited-unexpected=%s assumable-unexpected=%s',
           array_to_string(unexp, ','), array_to_string(assum, ',')));
  execute 'revoke cc_ctl_group from anon';
  execute 'revoke cc_ctl_group from supabase_auth_admin';
  execute 'revoke execute on function cc_ctl.cc_acl_probe() from cc_ctl_group';
  execute 'drop role cc_ctl_group';

  -- C15 POSITIVE control: PUBLIC is seen, and it drags every role with it.
  execute 'grant execute on function cc_ctl.cc_acl_probe() to public';
  unexp := pg_temp.cc_minus(pg_temp.cc_execers(fnoid),
                            pg_temp.cc_allowed_execers('postgres'::regrole::oid, '{}'::text[]));
  insert into cc_control values ('C15_acl_scanner_sees_public',
    pg_temp.cc_public_exec(fnoid) and 'anon' = any (unexp),
    format('public_exec=%s unexpected=%s', pg_temp.cc_public_exec(fnoid),
           array_to_string(unexp, ',')));

  -- C16 POSITIVE control: a NULL proacl is not "no privileges". PostgreSQL's
  --     built-in default hands EXECUTE to PUBLIC, and the scanner must say so.
  execute 'create function cc_ctl.cc_acl_probe_null() returns void language plpgsql as $b$ begin end; $b$';
  execute 'alter function cc_ctl.cc_acl_probe_null() owner to postgres';
  select p.oid into nulloid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'cc_ctl' and p.proname = 'cc_acl_probe_null';
  insert into cc_control values ('C16_null_proacl_is_public',
    (select p.proacl is null from pg_proc p where p.oid = nulloid)
      and pg_temp.cc_public_exec(nulloid)
      and 'anon' = any (pg_temp.cc_execers(nulloid)),
    format('proacl=%s public_exec=%s',
           (select coalesce(p.proacl::text, '<null>') from pg_proc p where p.oid = nulloid),
           pg_temp.cc_public_exec(nulloid)));

  execute 'drop schema cc_ctl cascade';

  -- C17 POSITIVE control on the side-effect detector. No mutant can make a
  --     tombstone body write — the shape this file requires before invoking a
  --     body admits nothing but `raise` — so `tomb:probe_side_effect` is
  --     declared unreachable in the suite. A declared-unreachable check must
  --     still be shown to WORK, or "it never fired" means nothing: the counter
  --     is wrapped around a statement that really does write.
  select count(*) into n_sec_b from vault.secrets;
  sid := vault.create_secret('CC-PROBE-NOT-A-CREDENTIAL',
                             'cc-control-' || md5(random()::text),
                             'catalogue-classify side-effect control; never a credential');
  select count(*) into n_sec_a from vault.secrets;
  delete from vault.secrets where id = sid;
  insert into cc_control values ('C17_side_effect_detector_works',
    n_sec_a = n_sec_b + 1
      and (select count(*) from vault.secrets) = n_sec_b,
    format('vault.secrets %s -> %s -> %s around a real write',
           n_sec_b, n_sec_a, (select count(*) from vault.secrets)));
end
$cc$;

-- ---------------------------------------------------------------------------
-- 1b. the reason-code registry
--
-- Every code this file can put in a `reasons` array is declared here, once.
-- The falsification suite parses this block and REFUSES to pass unless every
-- registered code is required by at least one mutant or declared unreachable
-- with a justification it verifies. Control C18 closes the other direction: a
-- code that is emitted but not registered fails the run.
-- ---------------------------------------------------------------------------
create temporary table cc_reason_registry(code text primary key, category text, note text);
insert into cc_reason_registry(code, category, note) values
  ('sig_absent','structural','nothing of that name in that schema'),
  ('sig_only_other_overload','structural','the name exists, the exact signature does not'),
  ('sig_name_ambiguous','structural','the bare name resolves to more than one routine'),
  ('sig_wrong_object_kind','structural','the name belongs to a procedure, aggregate or relation'),
  ('overload_unexpected','structural','more routines of this name in this schema than expected'),
  ('alt_schema_shadow','structural','a same-name routine exists in another schema'),
  ('env:default_acl_drift','environment','the default-privilege surface for functions moved'),
  ('env:superuser_set_drift','environment','the set of superuser roles moved'),
  ('env:role_membership_drift','environment','the role-membership graph moved'),
  -- ADV-2(D). BYPASSRLS is a role ATTRIBUTE. It is not superuser and it is not
  -- a membership, so neither of the two lines above moves when it is granted,
  -- and a role that carries it reads every row of every table in the database
  -- with every policy still in place.
  ('env:bypassrls_set_drift','environment','the set of roles carrying the BYPASSRLS attribute moved'),
  ('live:owner_mismatch','live-definition','owner is not the live profile owner'),
  ('live:rettype_mismatch','live-definition','return type is not the live profile return type'),
  ('live:args_mismatch','live-definition','argument list is not the live profile argument list'),
  ('live:language_mismatch','live-definition','language is not the live profile language'),
  ('live:secmode_mismatch','live-definition','SECURITY DEFINER/INVOKER is not the live profile mode'),
  ('live:volatility_mismatch','live-definition','volatility is not the live profile volatility'),
  ('live:proconfig_mismatch','live-definition','search_path/proconfig is not the live profile one'),
  ('live:body_mismatch','live-definition','the normalised body does not hash to the pinned live body'),
  ('live:acl_explicit_mismatch','live-acl','explicit EXECUTE grants are not the live profile grants'),
  ('live:acl_effective_mismatch','live-acl','the enumerated application roles that can execute it moved'),
  ('live:acl_unexpected_executor','live-acl','a role outside the live profile can execute it'),
  ('live:acl_missing_executor','live-acl','a role the live profile grants to can no longer execute it'),
  ('live:acl_assumable_executor','live-acl','a role outside the live profile can execute it after SET ROLE'),
  ('live:acl_public_execute','live-acl','PUBLIC holds EXECUTE on a live routine'),
  ('live:acl_sibling_executable','live-acl','another routine of this name is executable by an unexpected role'),
  ('live:probe_skipped_structure','live-probe','the live structure did not match, so no live probe ran'),
  ('live:probe_missing','live-probe','the live probe was selected but did not run'),
  ('live:probe_undefined','live-probe','the live structure matched but this file defines no probe for the key'),
  ('live:probe_failed','live-probe','the live probe raised'),
  ('live:probe_effect_mismatch','live-probe','the live probe completed with the wrong effect'),
  ('tomb:not_applicable','tomb-structural','migration 0022 does not tombstone this name'),
  ('tomb:owner_mismatch','tomb-definition','owner is not the tombstone owner'),
  ('tomb:rettype_mismatch','tomb-definition','return type is not the preserved return type'),
  ('tomb:args_mismatch','tomb-definition','argument list is not the preserved argument list'),
  ('tomb:language_mismatch','tomb-definition','language is not the 0022 template language'),
  ('tomb:secmode_mismatch','tomb-definition','security mode is not the 0022 template mode'),
  ('tomb:volatility_mismatch','tomb-definition','volatility is not the 0022 template volatility'),
  ('tomb:proconfig_mismatch','tomb-definition','search_path/proconfig is not the 0022 template one'),
  ('tomb:body_not_tombstone','tomb-definition','the body is not the body 0022 writes'),
  ('tomb:acl_public_execute','tomb-acl','PUBLIC holds EXECUTE on the tombstone'),
  ('tomb:acl_anon_execute','tomb-acl','anon holds EXECUTE on the tombstone'),
  ('tomb:acl_authenticated_execute','tomb-acl','authenticated holds EXECUTE on the tombstone'),
  ('tomb:acl_service_role_execute','tomb-acl','service_role holds EXECUTE on the tombstone'),
  ('tomb:acl_effective_escape','tomb-acl','an enumerated application role can execute the tombstone'),
  ('tomb:acl_unexpected_executor','tomb-acl','a role outside owner+superuser can execute the tombstone'),
  ('tomb:acl_missing_executor','tomb-acl','the owner or a superuser can no longer execute the tombstone'),
  ('tomb:acl_assumable_executor','tomb-acl','a role outside owner+superuser can execute it after SET ROLE'),
  ('tomb:acl_sibling_executable','tomb-acl','another routine of this name is executable by an unexpected role'),
  ('tomb:probe_skipped_unsafe_body','tomb-probe','the body does not match the safe-to-call shape'),
  ('tomb:probe_not_invoked','tomb-probe','the body was safe to call but the tombstone probe did not run'),
  ('tomb:probe_missing','tomb-probe','the tombstone probe was selected but did not run'),
  ('tomb:probe_sqlstate_mismatch','tomb-probe','the privileged call returned the wrong SQLSTATE'),
  ('tomb:probe_message_mismatch','tomb-probe','the privileged call returned the wrong message'),
  ('tomb:probe_side_effect','tomb-probe','the privileged call changed vault.secrets or audit_log'),
  ('absent:routine_exists','absent-structural','a routine 0022 tombstones exists on a generation that predates it'),
  -- The dependency closure of the authorization predicate (section 2d). These
  -- were emitted before they were registered, which made a genuine RLS-disable
  -- come back CONTROL_FAILED (C19: unregistered code) instead of the blocker it
  -- is. Fail-closed, but the wrong answer with the wrong name on it.
  ('dep:function_drift','closure','a function the pinned authorization body calls is not the pinned one'),
  ('dep:relation_drift','closure','a relation the pinned authorization body reads is not the pinned one'),
  ('dep:rls_disabled','closure','row level security is off on a table whose policy routes through the predicate'),
  ('dep:policy_set_changed','closure','the set of policies routing through the predicate is not the pinned set'),
  -- ADV-1. The line above is keyed on "routes through owns_account", so it
  -- enumerates only the policies whose USING clause mentions the predicate.
  -- PostgreSQL ORs PERMISSIVE policies together: a SECOND policy
  -- `using (true)` beside the expected one leaves the expected one
  -- byte-identical, leaves that aggregate byte-identical, and makes the
  -- predicate irrelevant. The code below is the complete-policy-set pin, per
  -- table, and it fires on an ADDITION as well as on a change.
  ('dep:guarded_policy_set_changed','closure','the COMPLETE policy set of a table in the closure is not the pinned set — a policy was added, removed, renamed, re-commanded, re-targeted or re-qualified'),
  -- ADV-2 (C/E/F). The three shapes that leave RLS enabled, the policy set
  -- byte-identical and owns_account answering correctly, and still return every
  -- row: the table OWNER is exempt from its own policies while FORCE ROW LEVEL
  -- SECURITY is off; an inheritance or partition PARENT is read with the
  -- parent's policies, not the child's; and a VIEW over the table runs in the
  -- VIEW OWNER's row-security context unless it is security_invoker.
  ('dep:guarded_table_exposed','closure','a table in the closure is not the pinned relation — its owner, relkind, RLS/FORCE flags, inheritance edges or the set of views reading it moved'),
  ('dep:closure_missing','closure','a key declares a dependency closure but none was observed, or a declared dependency arm has no reason branch in this file'),
  -- Whole-schema counter-scan findings (section 2e). These are RUN-level, not
  -- per-object: they belong to the schema, not to any catalogue key. They are
  -- registered here anyway so the suite's coverage assertion puts the same
  -- falsification pressure on them as on every other code, and so C19b can
  -- refuse an emitted schema code that nobody registered.
  ('schema:client_executable_surface_drift','schema','the set of public routines a client role can execute is not the pinned set'),
  ('schema:secdef_vault_reacher_unlisted','schema','the set of SECURITY DEFINER public routines that can reach vault.* is not the pinned set'),
  ('expected_state_mismatch','comparison','the observed profile is not the profile expected here');

-- ---------------------------------------------------------------------------
-- 2. the expectation catalogue
--
-- Keyed on EXACT regprocedure signatures. The LIVE profile is what the
-- migration chain leaves when 0022 section 5 has NOT run over the object:
--   * 0008 generation  -> migration 0008's definitions
--   * latest generation -> the last non-tombstone definition in the chain,
--                          which for vault_delete_secret is migration 0020's
--                          FK-aware rewrite, not 0008's.
-- owns_account(uuid) is here as the control object: a routine 0022 never
-- tombstones, so a 42501 on it can never be read as an intentional tombstone.
--
-- live_grantees is the EXACT list of application roles the live profile hands
-- EXECUTE to. The tombstone profile has no such list at all — that is what
-- makes "any role at all, beyond the owner's family and the superusers" a
-- finding rather than something to enumerate in advance.
-- ---------------------------------------------------------------------------
-- live_body_sha256 pins the NORMALISED body of the last live definition, the
-- same way tomb_body_template pins the tombstone's. Without it a routine can
-- keep every catalogue property and every probe answer this file checks and
-- still have had a clause added to its predicate — `or auth.uid() is null`, or
-- `or auth.uid() = <a uuid the attacker holds>`. The probe truth table below
-- catches the first shape (a subject that owns nothing, and no subject at all,
-- must be refused); only a body pin catches the second, because a backdoor
-- keyed on a uuid no probe uses answers every probe correctly. The two are
-- complementary and neither is sufficient alone.
--
-- It is a digest rather than the text because two of the six bodies are ~2 kB
-- of plpgsql; embedding those would put a second copy of the migration in this
-- file, which is the drift this directory exists to avoid. The observed
-- normalised body is in the JSON report, so a mismatch is still diagnosable,
-- and control C24 binds the digest of the one body that carries the
-- authorization decision — owns_account — to a plaintext written out here, so
-- that digest at least is reviewable by reading rather than by trust.
create temporary table cc_expect(
  key             text primary key,
  nspname         text        not null,
  proname         text        not null,
  sig             text        not null,
  expected_state  text        not null
                  check (expected_state in ('LIVE','TOMBSTONED','ABSENT')),
  exp_owner       text        not null,
  exp_rettype     text        not null,   -- 0022 preserves it, so it is shared
  exp_args        text        not null,   -- 0022 preserves it, so it is shared
  exp_overloads   int         not null,
  exp_shadows     int         not null,
  live_lang       text        not null,
  live_secdef     boolean     not null,
  live_volatility text        not null,
  live_searchpath text        not null,
  live_grants     text[]      not null,
  live_effective  text[]      not null,
  live_grantees   text[]      not null,
  live_body_sha256 text,
  -- The EXACT sibling landscape: for every OTHER routine answering this name,
  -- the roles that can execute it and are not entitled to. Pinned rather than
  -- required to be empty, because public.resolve_create_operation has a live
  -- three-argument successor beside its two-argument tombstone and
  -- `service_role` is meant to be able to call it. An exact pin keeps that
  -- fact visible instead of turning the sibling check off for the one object
  -- where it would otherwise fire.
  exp_sibling     text[]      not null,
  -- An ABSENT row is the only row allowed to carry no body pin, and it must
  -- expect no routine of that name anywhere. Every other row MUST pin a body:
  -- a nullable column with no constraint would be a silent opt-out of the
  -- strongest check in this file.
  constraint cc_expect_body_pin_required
    check ((expected_state = 'ABSENT') = (live_body_sha256 is null)),
  constraint cc_expect_absent_expects_nothing
    check (expected_state <> 'ABSENT' or (exp_overloads = 0 and exp_shadows = 0))
);

-- 0001-0008 reference schema
--
-- create_account_atomic (0014) and record_account_verification (0018) do not
-- exist yet on this chain, so their honest expectation here is ABSENT. That is
-- an assertion, not a hole: back-porting either one onto the reference schema
-- makes this run RED. It is also what lets control C20 demand a row for every
-- name 0022 tombstones in BOTH generations rather than only in the one where
-- the tombstone has been applied.
insert into cc_expect
select * from (values
  ('vault_create_secret','public','vault_create_secret','public.vault_create_secret(text,text)',
   'LIVE','postgres','uuid','p_secret text, p_name text DEFAULT NULL::text',1,0,
   'plpgsql',true,'v','public, vault',
   array['service_role'],array['service_role'],array['service_role'],
   '48810bb2bc09dd6c979720abcbb94b480e572e91e4d85f30a9050e3bd6caf6aa','{}'::text[]),
  ('vault_update_secret','public','vault_update_secret','public.vault_update_secret(uuid,text)',
   'LIVE','postgres','void','p_id uuid, p_secret text',1,0,
   'plpgsql',true,'v','public, vault',
   array['service_role'],array['service_role'],array['service_role'],
   '10689b4d1d605921a5cf19da9fc94b1cb3573eb0b31c367c3b15065bd0334586','{}'::text[]),
  ('vault_delete_secret','public','vault_delete_secret','public.vault_delete_secret(uuid)',
   'LIVE','postgres','void','p_id uuid',1,0,
   'plpgsql',true,'v','public, vault',
   array['service_role'],array['service_role'],array['service_role'],
   '3e3de22eb640ff61eca67cac43bbc155e3ada33b69bee29e5fbc01125046f4b1','{}'::text[]),
  ('owns_account','public','owns_account','public.owns_account(uuid)',
   'LIVE','postgres','boolean','acct uuid',1,0,
   'sql',true,'s','public',
   array['authenticated','service_role'],array['authenticated','service_role'],
   array['authenticated','service_role'],
   'b35793905184e1fda1f8260b4a790c264d771e803bba9e5f136a86cc38a1de4f','{}'::text[]),
  ('create_account_atomic','public','create_account_atomic',
   'public.create_account_atomic(uuid,text,account_mode,text,uuid,uuid,text,uuid)',
   'ABSENT','','','',0,0,
   '',false,'','',
   '{}'::text[],'{}'::text[],'{}'::text[],
   null,'{}'::text[]),
  ('record_account_verification','public','record_account_verification',
   'public.record_account_verification(uuid,uuid,account_status,text,bigint)',
   'ABSENT','','','',0,0,
   '',false,'','',
   '{}'::text[],'{}'::text[],'{}'::text[],
   null,'{}'::text[]),
  -- The three refusal shims the section-scoped derivation never saw. Migration
  -- 0017 installs two of them and 0022 installs the third INLINE; all three
  -- postdate this chain, so here the honest expectation is that they are not
  -- there at all — the same ABSENT/EXPECTEDLY_ABSENT pair the 0014/0018
  -- routines above get.
  ('reconcile_cash_flow_mirror','public','reconcile_cash_flow_mirror',
   'public.reconcile_cash_flow_mirror(uuid,uuid,date,jsonb)',
   'ABSENT','','','',0,0,
   '',false,'','',
   '{}'::text[],'{}'::text[],'{}'::text[],
   null,'{}'::text[]),
  ('replace_equity_snapshots','public','replace_equity_snapshots',
   'public.replace_equity_snapshots(uuid,uuid,jsonb)',
   'ABSENT','','','',0,0,
   '',false,'','',
   '{}'::text[],'{}'::text[],'{}'::text[],
   null,'{}'::text[]),
  ('resolve_create_operation','public','resolve_create_operation',
   'public.resolve_create_operation(uuid,uuid)',
   'ABSENT','','','',0,0,
   '',false,'','',
   '{}'::text[],'{}'::text[],'{}'::text[],
   null,'{}'::text[])
) v
where pg_temp.cc_cfg('generation') = '0008';

-- 0001-0023 latest schema
insert into cc_expect
select * from (values
  ('vault_create_secret','public','vault_create_secret','public.vault_create_secret(text,text)',
   'TOMBSTONED','postgres','uuid','p_secret text, p_name text DEFAULT NULL::text',1,0,
   'plpgsql',true,'v','public, vault',
   array['service_role'],array['service_role'],array['service_role'],
   '48810bb2bc09dd6c979720abcbb94b480e572e91e4d85f30a9050e3bd6caf6aa','{}'::text[]),
  ('vault_update_secret','public','vault_update_secret','public.vault_update_secret(uuid,text)',
   'TOMBSTONED','postgres','void','p_id uuid, p_secret text',1,0,
   'plpgsql',true,'v','public, vault',
   array['service_role'],array['service_role'],array['service_role'],
   '10689b4d1d605921a5cf19da9fc94b1cb3573eb0b31c367c3b15065bd0334586','{}'::text[]),
  -- migration 0020 rewrote this one before 0022 tombstoned it: its LIVE
  -- profile on the latest chain is 0020's, with pg_catalog first.
  ('vault_delete_secret','public','vault_delete_secret','public.vault_delete_secret(uuid)',
   'TOMBSTONED','postgres','void','p_id uuid',1,0,
   'plpgsql',true,'v','pg_catalog, public, vault',
   array['service_role'],array['service_role'],array['service_role'],
   'daa34772725b78cd9542afdd7f2abf9f6942d4a930c8392c106e4ca11636bd2e','{}'::text[]),
  ('owns_account','public','owns_account','public.owns_account(uuid)',
   'LIVE','postgres','boolean','acct uuid',1,0,
   'sql',true,'s','pg_catalog, public',
   array['authenticated','service_role'],array['authenticated','service_role'],
   array['authenticated','service_role'],
   'b35793905184e1fda1f8260b4a790c264d771e803bba9e5f136a86cc38a1de4f','{}'::text[]),
  -- The other two routines 0022 section 5 tombstones. Their LIVE profile is
  -- the last definition before the tombstone: migration 0021's for
  -- create_account_atomic, migration 0020's for record_account_verification.
  ('create_account_atomic','public','create_account_atomic',
   'public.create_account_atomic(uuid,text,account_mode,text,uuid,uuid,text,uuid)',
   'TOMBSTONED','postgres','accounts',
   'p_owner uuid, p_nickname text, p_mode account_mode, p_color text, '
   'p_key_secret uuid, p_secret_secret uuid, p_account_number text, p_operation_id uuid',
   1,0,
   'plpgsql',true,'v','pg_catalog, public, vault',
   array['service_role'],array['service_role'],array['service_role'],
   '3afe87e2bf6496af3ca8e8d7bcb887548ea311f86cd999c27cccdd310010525a','{}'::text[]),
  ('record_account_verification','public','record_account_verification',
   'public.record_account_verification(uuid,uuid,account_status,text,bigint)',
   'TOMBSTONED','postgres','accounts',
   'p_account uuid, p_owner uuid, p_status account_status, '
   'p_account_number text DEFAULT NULL::text, p_expected_version bigint DEFAULT NULL::bigint',
   1,0,
   'plpgsql',true,'v','pg_catalog, public',
   array['service_role'],array['service_role'],array['service_role'],
   'd04e49e658833882f9318300be600bb4e556bb9a3fed649d3b30388a5f65a31b','{}'::text[]),
  -- ---- the three shims a section-scoped derivation never saw -------------
  --
  -- Migration 0017 replaces the bodies of reconcile_cash_flow_mirror and
  -- replace_equity_snapshots with a `raise` and DOES NOT revoke service_role;
  -- their derived expected grantee set is therefore {service_role}, not {}.
  -- Their LIVE profile is migration 0014's, which differs from the shim in
  -- NOTHING but the body — same owner, language, security mode, volatility,
  -- search_path, arguments and return type. That is why the tombstone probe is
  -- no longer an `else` branch of the live probe: gating it on "the live
  -- structure did not match" would have left both of these unprobed.
  ('reconcile_cash_flow_mirror','public','reconcile_cash_flow_mirror',
   'public.reconcile_cash_flow_mirror(uuid,uuid,date,jsonb)',
   'TOMBSTONED','postgres','jsonb',
   'p_account uuid, p_owner uuid, p_from date, p_rows jsonb',
   1,0,
   'plpgsql',true,'v','pg_catalog, public',
   array['service_role'],array['service_role'],array['service_role'],
   'c82f3c90793509c613a64b0044c51b1e5ce1e3ec77cd0d2e10fc732316d9f2fe','{}'::text[]),
  ('replace_equity_snapshots','public','replace_equity_snapshots',
   'public.replace_equity_snapshots(uuid,uuid,jsonb)',
   'TOMBSTONED','postgres','jsonb',
   'p_account uuid, p_owner uuid, p_rows jsonb',
   1,0,
   'plpgsql',true,'v','pg_catalog, public',
   array['service_role'],array['service_role'],array['service_role'],
   '2151c8ce3ff0bde48f29ea5811c1844dd84f5a3693094749f22dcfcd2b60b152','{}'::text[]),
  -- 0022 tombstones the two-argument form INLINE, sixty lines above the loop,
  -- with its own message and SECURITY INVOKER, and leaves the three-argument
  -- successor live and callable by service_role. Two overloads are therefore
  -- EXPECTED, and the sibling landscape is pinned rather than required empty.
  ('resolve_create_operation','public','resolve_create_operation',
   'public.resolve_create_operation(uuid,uuid)',
   'TOMBSTONED','postgres','jsonb',
   'p_owner uuid, p_operation_id uuid',
   2,0,
   'plpgsql',true,'v','pg_catalog, public',
   array['service_role'],array['service_role'],array['service_role'],
   'cf2ed199e99948d471b114ccdac3186058f7ac9596da3dda7cb3a34a67442855',
   array['resolve_create_operation(uuid,uuid,text) => service_role'])
) v
where pg_temp.cc_cfg('generation') = 'latest';

-- The environment surface that could hand EXECUTE to somebody without touching
-- a single routine. Both fingerprints are complete — every schema, every
-- grantee, every superuser — not a filtered view of the roles somebody thought
-- of. Default privileges cannot retroactively grant on an object that already
-- exists, so the default-ACL entry is a DRIFT assertion; the superuser entry is
-- not, because a new superuser can execute everything that exists already.
--
-- ADV-2(D). `bypassrls` joins them for the reason recorded on cc_bypassrls()
-- above: a role that carries BYPASSRLS reads every row of every table, and it
-- is neither a superuser (so cc_superusers does not move) nor a membership (so
-- cc_role_graph does not move). It belongs here rather than in the closure
-- because it is a property of the CLUSTER, not of owns_account: one
-- `alter role authenticated bypassrls` defeats every policy in the database at
-- once, including the ones on tables this closure says nothing about.
create temporary table cc_env_expect(
  generation  text primary key,
  defacl      text not null,
  superusers  text not null,
  rolegraph   text not null,
  bypassrls   text not null
);
insert into cc_env_expect values
  ('0008',
   'auth/supabase_auth_admin/dashboard_user,auth/supabase_auth_admin/postgres,'
   'extensions/supabase_admin/postgres,'
   'graphql/supabase_admin/anon,graphql/supabase_admin/authenticated,'
   'graphql/supabase_admin/postgres,graphql/supabase_admin/service_role,'
   'graphql_public/supabase_admin/anon,graphql_public/supabase_admin/authenticated,'
   'graphql_public/supabase_admin/postgres,graphql_public/supabase_admin/service_role,'
   'public/postgres/anon,public/postgres/authenticated,public/postgres/postgres,'
   'public/postgres/service_role,'
   'public/supabase_admin/anon,public/supabase_admin/authenticated,'
   'public/supabase_admin/postgres,public/supabase_admin/service_role,'
   'realtime/supabase_admin/dashboard_user,realtime/supabase_admin/postgres,'
   'storage/postgres/anon,storage/postgres/authenticated,storage/postgres/postgres,'
   'storage/postgres/service_role',
   'supabase_admin',
   'authenticator>anon/supabase_admin/--S,'
   'authenticator>authenticated/supabase_admin/--S,'
   'authenticator>service_role/supabase_admin/--S,'
   'pg_monitor>pg_read_all_settings/supabase_admin/-IS,'
   'pg_monitor>pg_read_all_stats/supabase_admin/-IS,'
   'pg_monitor>pg_stat_scan_tables/supabase_admin/-IS,'
   'postgres>anon/supabase_admin/AIS,'
   'postgres>authenticated/supabase_admin/AIS,'
   'postgres>authenticator/supabase_admin/AIS,'
   'postgres>pg_create_subscription/supabase_admin/AIS,'
   'postgres>pg_monitor/supabase_admin/AIS,'
   'postgres>pg_read_all_data/supabase_admin/AIS,'
   'postgres>pg_signal_backend/supabase_admin/AIS,'
   'postgres>service_role/supabase_admin/AIS,'
   'postgres>supabase_privileged_role/supabase_admin/-IS,'
   'postgres>supabase_storage_admin/supabase_admin/-IS,'
   'supabase_etl_admin>pg_monitor/supabase_admin/-IS,'
   'supabase_etl_admin>pg_read_all_data/supabase_admin/-IS,'
   'supabase_etl_admin>supabase_privileged_role/supabase_admin/-IS,'
   'supabase_read_only_user>pg_monitor/supabase_admin/-IS,'
   'supabase_read_only_user>pg_read_all_data/supabase_admin/-IS,'
   'supabase_storage_admin>authenticator/supabase_admin/--S',
   -- MEASURED on a pristine g0008 clone, `select rolname from pg_roles where
   -- rolbypassrls order by 1`. Not empty, and not a wish: this is what the
   -- stock Supabase image ships.
   'postgres,service_role,supabase_admin,supabase_etl_admin,supabase_read_only_user'),
  ('latest',
   '-/postgres/postgres,-/postgres/service_role,'
   'auth/supabase_auth_admin/dashboard_user,auth/supabase_auth_admin/postgres,'
   'extensions/supabase_admin/postgres,'
   'graphql/supabase_admin/anon,graphql/supabase_admin/authenticated,'
   'graphql/supabase_admin/postgres,graphql/supabase_admin/service_role,'
   'graphql_public/supabase_admin/anon,graphql_public/supabase_admin/authenticated,'
   'graphql_public/supabase_admin/postgres,graphql_public/supabase_admin/service_role,'
   'public/postgres/postgres,public/postgres/service_role,'
   'public/supabase_admin/anon,public/supabase_admin/authenticated,'
   'public/supabase_admin/postgres,public/supabase_admin/service_role,'
   'realtime/supabase_admin/dashboard_user,realtime/supabase_admin/postgres,'
   'storage/postgres/anon,storage/postgres/authenticated,storage/postgres/postgres,'
   'storage/postgres/service_role',
   'supabase_admin',
   'authenticator>anon/supabase_admin/--S,'
   'authenticator>authenticated/supabase_admin/--S,'
   'authenticator>service_role/supabase_admin/--S,'
   'pg_monitor>pg_read_all_settings/supabase_admin/-IS,'
   'pg_monitor>pg_read_all_stats/supabase_admin/-IS,'
   'pg_monitor>pg_stat_scan_tables/supabase_admin/-IS,'
   'postgres>anon/supabase_admin/AIS,'
   'postgres>authenticated/supabase_admin/AIS,'
   'postgres>authenticator/supabase_admin/AIS,'
   'postgres>pg_create_subscription/supabase_admin/AIS,'
   'postgres>pg_monitor/supabase_admin/AIS,'
   'postgres>pg_read_all_data/supabase_admin/AIS,'
   'postgres>pg_signal_backend/supabase_admin/AIS,'
   'postgres>service_role/supabase_admin/AIS,'
   'postgres>supabase_privileged_role/supabase_admin/-IS,'
   'postgres>supabase_storage_admin/supabase_admin/-IS,'
   'supabase_etl_admin>pg_monitor/supabase_admin/-IS,'
   'supabase_etl_admin>pg_read_all_data/supabase_admin/-IS,'
   'supabase_etl_admin>supabase_privileged_role/supabase_admin/-IS,'
   'supabase_read_only_user>pg_monitor/supabase_admin/-IS,'
   'supabase_read_only_user>pg_read_all_data/supabase_admin/-IS,'
   'supabase_storage_admin>authenticator/supabase_admin/--S',
   -- MEASURED on a pristine glatest clone, same query, same answer.
   'postgres,service_role,supabase_admin,supabase_etl_admin,supabase_read_only_user');

-- Every role the expectation names must exist, or "allowed to execute" would
-- silently shrink to nothing and every grant would look like drift.
do $cc$
declare
  bad text;
begin
  select string_agg(g, ',' order by g) into bad
    from (select distinct unnest(live_grantees) as g from cc_expect) s
   where to_regrole(g) is null;
  insert into cc_control values ('C18_declared_grantees_exist',
    bad is null, coalesce('unknown roles named by the expectation: ' || bad,
                          'every declared grantee resolves'));
end
$cc$;

-- ---------------------------------------------------------------------------
-- 2b. COVERAGE — the expectation catalogue must name every routine 0022
--     tombstones, in every generation.
--
-- This is the control this file did not have. `tomb_names` already carried all
-- five names 0022 section 5 tombstones, but only four of them had a cc_expect
-- row, so `create_account_atomic` and `record_account_verification` produced no
-- cc_verdict row at all: their ACL, body, owner and executability were never
-- examined and the run still said PASS. Granting EXECUTE on either of them to
-- service_role passed cleanly. So did dropping the tombstone entirely and
-- installing a live body.
--
-- An omission from a hand-written list is invisible by nature, so the fix is
-- not a longer list — it is a check that fails when the list is short. The
-- name set is READ OUT OF the migration (C20 compares 0022's two independent
-- statements of it to each other as well), and C23 is the positive control
-- proving the comparator behind all of this can see a planted absence.
-- ---------------------------------------------------------------------------
do $cc$
declare
  tnames    text[] := string_to_array(pg_temp.cc_cfg('tomb_names'), ',');
  mnames    text[] := string_to_array(pg_temp.cc_cfg('tomb_template_names'), ',');
  pnames    text[] := string_to_array(pg_temp.cc_cfg('tomb_postcond_names'), ',');
  tgt_names text[];
  covered   text[];
  uncovered text[];
  disagree  text[];
  tombed    text[];
  extra     text[];
  gen       text := pg_temp.cc_cfg('generation');
  synth_all text[] := array['cc_synth_alpha','cc_synth_beta'];
  ok_state  boolean;
begin
  ---------------------------------------------------------------- C23 first
  -- POSITIVE control on the set-difference the two controls below depend on:
  -- it must REPORT a planted missing name, and must stay silent on a complete
  -- set. Without this, "no tombstone name is uncovered" is an absence claim
  -- from a comparator nobody proved works.
  insert into cc_control values ('C23_coverage_comparator',
    pg_temp.cc_minus(synth_all, array['cc_synth_alpha'])
      = array['cc_synth_beta']::text[]
    and cardinality(pg_temp.cc_minus(synth_all, synth_all)) = 0
    and cardinality(pg_temp.cc_minus(synth_all, '{}'::text[])) = 2,
    format('planted-missing=%s complete=%s nothing-covered=%s',
           array_to_string(pg_temp.cc_minus(synth_all, array['cc_synth_alpha']), ','),
           array_to_string(pg_temp.cc_minus(synth_all, synth_all), ','),
           array_to_string(pg_temp.cc_minus(synth_all, '{}'::text[]), ',')));

  ------------------------------------------------------------------ C20
  -- The name set is the UNION over both shim mechanisms across the whole
  -- migration set, not one section of one file. The section-6 post-condition
  -- restates only what the section-5 LOOP tombstones, so it is cross-checked
  -- against the TEMPLATE mechanism's names — comparing it to the union would
  -- fail on 0017's and 0022's inline shims, which it does not know about, and
  -- widening the claim to make that comparison pass is exactly the error this
  -- control exists to prevent.
  select coalesce(array_agg(distinct proname), '{}'::text[]) into covered
    from cc_expect;
  uncovered := pg_temp.cc_minus(tnames, covered);
  disagree  := pg_temp.cc_minus(mnames, pnames) || pg_temp.cc_minus(pnames, mnames);

  insert into cc_control values ('C20_tombstone_names_expected',
    cardinality(tnames) > 0
      and cardinality(mnames) > 0
      and cardinality(pnames) > 0
      and cardinality(disagree) = 0
      and cardinality(uncovered) = 0,
    format('the migration set tombstones %s name(s) [%s] via %s across [%s]; '
           '0022 section-5 loop [%s] and its section-6 restatement %s; '
           'expectation catalogue covers %s; uncovered: %s',
           cardinality(tnames), array_to_string(tnames, ','),
           pg_temp.cc_cfg('tomb_mechanisms'), pg_temp.cc_cfg('tomb_sources'),
           array_to_string(mnames, ','),
           case when cardinality(disagree) = 0 then 'agree'
                else 'DISAGREE on ' || array_to_string(disagree, ',') end,
           array_to_string(covered, ','),
           coalesce(nullif(array_to_string(uncovered, ','), ''), '<none>')));

  ------------------------------------------------------------------ C20b
  -- The derived target table and the derived name list must describe the same
  -- set. They come from the same extractor run, but they are two different
  -- outputs of it: a target list that lost a row while the name list kept it
  -- would leave an object with a coverage row and no contract to compare
  -- against.
  select coalesce(array_agg(distinct proname), '{}'::text[]) into tgt_names
    from cc_tomb_target;
  insert into cc_control values ('C20b_targets_match_names',
    cardinality(pg_temp.cc_minus(tnames, tgt_names)) = 0
      and cardinality(pg_temp.cc_minus(tgt_names, tnames)) = 0
      and (select count(*) from cc_tomb_target) = cardinality(tnames),
    format('derived names [%s]; derived targets [%s]; %s target row(s)',
           array_to_string(tnames, ','), array_to_string(tgt_names, ','),
           (select count(*) from cc_tomb_target)));

  ------------------------------------------------------------------ C21
  -- Coverage alone would be satisfied by a row that expects the wrong thing.
  -- On the latest chain the tombstone has been applied, so the set of names
  -- expected TOMBSTONED must be EXACTLY the set 0022 tombstones — in both
  -- directions. On the 0001-0008 reference chain 0022 has not run at all, so
  -- nothing may be expected TOMBSTONED there.
  select coalesce(array_agg(distinct proname), '{}'::text[]) into tombed
    from cc_expect where expected_state = 'TOMBSTONED';

  if gen = 'latest' then
    extra    := pg_temp.cc_minus(tombed, tnames);
    ok_state := cardinality(pg_temp.cc_minus(tnames, tombed)) = 0
                and cardinality(extra) = 0;
    insert into cc_control values ('C21_tombstone_state_agreement',
      ok_state,
      format('latest: expected-TOMBSTONED=[%s] 0022-tombstones=[%s] '
             'missing=[%s] surplus=[%s]',
             array_to_string(tombed, ','), array_to_string(tnames, ','),
             array_to_string(pg_temp.cc_minus(tnames, tombed), ','),
             array_to_string(extra, ',')));
  else
    insert into cc_control values ('C21_tombstone_state_agreement',
      cardinality(tombed) = 0,
      format('0008: migration 0022 has not run on this chain, so nothing may '
             'be expected TOMBSTONED; expected-TOMBSTONED=[%s]',
             array_to_string(tombed, ',')));
  end if;

  ------------------------------------------------------------------ C22
  -- The third subject the owns_account probe needs: one that owns NOTHING.
  -- "a subject that owns nothing is refused" proves nothing if that subject
  -- silently owns a row.
  insert into cc_control values ('C22_third_subject_owns_nothing',
    not exists (select 1 from public.accounts
                 where owner_id = '66666666-6666-4666-8666-666666666666'),
    format('accounts owned by the owner-less probe subject: %s',
           (select count(*) from public.accounts
             where owner_id = '66666666-6666-4666-8666-666666666666')));

  ------------------------------------------------------------------ C24
  -- The body pin for owns_account is a digest, and a digest is not reviewable
  -- by reading. This binds it to a plaintext written out here: if the two ever
  -- disagree, either the pin moved or this comment lies, and both are findings.
  -- owns_account is the SECURITY DEFINER predicate behind RLS on positions,
  -- performance, equity_snapshots and routine_runs, so its body is the one
  -- body in this file a human should be able to read and check.
  insert into cc_control values ('C24_owns_account_body_pin_readable',
    (select live_body_sha256 from cc_expect where key = 'owns_account')
      = encode(sha256(convert_to(pg_temp.cc_norm(
          'select exists ( select 1 from accounts where id = acct '
          'and owner_id = auth.uid() and deleted_at is null );'), 'UTF8')), 'hex'),
    format('pinned=%s documented=%s',
           (select live_body_sha256 from cc_expect where key = 'owns_account'),
           encode(sha256(convert_to(pg_temp.cc_norm(
             'select exists ( select 1 from accounts where id = acct '
             'and owner_id = auth.uid() and deleted_at is null );'), 'UTF8')), 'hex')));
end
$cc$;

-- ---------------------------------------------------------------------------
-- 2c. C26 — every LIVE body pin above is DERIVED, not merely typed here
--
-- `live_body_sha256` is the strongest single check in this file, and until now
-- every one of those digests was typed into it by hand. A hand-typed pin has
-- the same failure mode as a hand-typed name list: nothing notices when it
-- stops describing the migrations. The extractor now walks every
-- `create [or replace] function` in the migration set, in order, and reports
-- the digest of the last NON-shim body of each signature at this generation.
-- This control requires the two to agree, in both directions, and refuses a
-- comparison against a map that does not carry the signature at all — a
-- missing key would make the check silently vacuous, which is the failure
-- being closed, not a new one to introduce.
-- ---------------------------------------------------------------------------
do $cc$
declare
  bad_pin   text;
  bad_miss  text;
  n_map     int := (select count(*) from cc_live_body);
  n_need    int := (select count(*) from cc_expect where expected_state <> 'ABSENT');
begin
  select string_agg(format('%s pinned=%s derived=%s', e.sig, e.live_body_sha256,
                           b.sha256), '; ' order by e.sig)
    into bad_pin
    from cc_expect e join cc_live_body b on b.sig = e.sig
   where e.expected_state <> 'ABSENT'
     and e.live_body_sha256 is distinct from b.sha256;

  select string_agg(e.sig, ',' order by e.sig) into bad_miss
    from cc_expect e
   where e.expected_state <> 'ABSENT'
     and not exists (select 1 from cc_live_body b where b.sig = e.sig);

  insert into cc_control values ('C26_live_body_pins_derived',
    bad_pin is null and bad_miss is null and n_map >= n_need and n_need > 0,
    format('%s signature(s) in the derived live-body map, %s pin(s) to check; '
           'disagreements: %s; not in the map: %s',
           n_map, n_need,
           coalesce(bad_pin, '<none>'), coalesce(bad_miss, '<none>')));
end
$cc$;

-- ---------------------------------------------------------------------------
-- 2d. THE DEPENDENCY CLOSURE of the authorization predicate
--
-- `owns_account(uuid)` is pinned by body digest and probed at nine points, and
-- those two together were described as jointly sufficient for the claim "this
-- routine authorises exactly the owner". They are not, and the gap is not
-- subtle: the pin covers the routine's OWN TEXT, and that text is
--
--     select exists (select 1 from accounts
--                     where id = acct and owner_id = auth.uid()
--                       and deleted_at is null);
--
-- whose only non-trivial term is `auth.uid()` and whose only relation is
-- `public.accounts`. Neither was checked. Redefining `auth.uid()` as
--
--     select case when current_setting('request.jwt.claim.role', true) = '<x>'
--                 then '<an attacker-chosen uuid>'::uuid
--                 else nullif(current_setting('request.jwt.claim.sub',true),'')::uuid end
--
-- leaves the pinned digest byte-identical, answers all nine probes correctly —
-- none of them sets that claim — and hands `owns(A) = true` to anybody who
-- does. The same applies one level out: the predicate only guards anything
-- because RLS is ENABLED on the tables whose policies call it, and
-- `alter table positions disable row level security` is a total bypass that
-- touches neither the routine nor its ACL.
--
-- So the closure is pinned: the definition of every schema-qualified function
-- the pinned body calls, the identity of every relation it reads, RLS being on
-- for every table a policy routes through it, and the exact set of those
-- policies. C27 is the COMPLETENESS control — the declared closure must cover
-- every dependency a parser finds in the pinned body text OR in the pinned
-- POLICY EXPRESSIONS (R5-CLOSURE-DERIV) — and C28 is that parser's
-- positive/negative control.
-- ---------------------------------------------------------------------------
create temporary table cc_dep_expect(
  key       text not null,   -- the routine whose closure this is
  dep_kind  text not null    -- function | relation | rls | policy | policyset | guarded
            check (dep_kind in ('function','relation','rls','policy','policyset','guarded')),
  dep_id    text not null,
  prop      text not null,
  expected  text not null,
  primary key (key, dep_kind, dep_id, prop)
);

-- The body of auth.uid() is pinned as PLAINTEXT for the same reason
-- owns_account's is (C24): a digest is not reviewable by reading.
create function pg_temp.cc_auth_uid_pinned() returns text
language sql immutable as $fn$
  select 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid;'
$fn$;

insert into cc_dep_expect(key, dep_kind, dep_id, prop, expected) values
  ('owns_account','function','auth.uid()','body_sha256',
     encode(sha256(convert_to(pg_temp.cc_norm(pg_temp.cc_auth_uid_pinned()), 'UTF8')), 'hex')),
  ('owns_account','function','auth.uid()','owner',      'supabase_auth_admin'),
  ('owns_account','function','auth.uid()','language',   'sql'),
  ('owns_account','function','auth.uid()','secdef',     'f'),
  ('owns_account','function','auth.uid()','volatility', 's'),
  ('owns_account','function','auth.uid()','proconfig',  '<none>'),
  ('owns_account','function','auth.uid()','overloads',  '1'),
  ('owns_account','relation','public.accounts','relkind',     'r'),
  ('owns_account','relation','public.accounts','owner',       'postgres'),
  ('owns_account','relation','public.accounts','rowsecurity', 't');

-- The tables a policy routes through owns_account, and the policies
-- themselves. Both generations are stated; on 0001-0008 `trades` and
-- `cash_flows` still carry an owner-scoped read policy, and 0011/0012 removed
-- them from the client read surface entirely.
insert into cc_dep_expect(key, dep_kind, dep_id, prop, expected)
select 'owns_account','rls', t, 'rowsecurity', 't'
  from unnest(case when pg_temp.cc_cfg('generation') = '0008'
                   then array['public.cash_flows','public.equity_snapshots',
                              'public.performance','public.positions',
                              'public.routine_runs','public.trades']
                   else array['public.equity_snapshots','public.performance',
                              'public.positions','public.routine_runs']
              end) t;

insert into cc_dep_expect(key, dep_kind, dep_id, prop, expected) values
  ('owns_account','policy','<policies routing through owns_account>','set',
   case when pg_temp.cc_cfg('generation') = '0008' then
     'public.cash_flows/read own cash flows/r/owns_account(account_id);'
     'public.equity_snapshots/read own equity/r/owns_account(account_id);'
     'public.performance/read own performance/r/owns_account(account_id);'
     'public.positions/read own positions/r/owns_account(account_id);'
     'public.routine_runs/read own routine runs/r/((account_id IS NULL) OR owns_account(account_id));'
     'public.trades/read own trades/r/owns_account(account_id)'
   else
     'public.equity_snapshots/read own equity/r/owns_account(account_id);'
     'public.performance/read own performance/r/owns_account(account_id);'
     'public.positions/read own positions/r/owns_account(account_id);'
     'public.routine_runs/read own routine runs/r/((account_id IS NULL) OR owns_account(account_id))'
   end);

-- ---------------------------------------------------------------------------
-- 2d(ii). ADV-1 — THE COMPLETE POLICY SET OF EVERY TABLE IN THE CLOSURE
--
-- Everything above this line asks "is the policy I know about still there and
-- still saying what it said". PostgreSQL ORs PERMISSIVE policies together, so
-- that question has a `true` answer in a database where the predicate decides
-- nothing at all:
--
--     create policy "read_all" on public.positions for select using (true);
--
-- leaves `read own positions` byte-identical; leaves the `policy` row above
-- byte-identical, because that row aggregates only policies whose USING clause
-- LIKE '%owns_account%' and `true` does not mention it; leaves RLS on, so the
-- `rls` rows are unchanged; leaves auth.uid() and public.accounts untouched,
-- so C27/C28/C34 are unchanged; and leaves all nine owns_account probes
-- answering correctly, because owns_account itself still returns false for a
-- non-owner. MEASURED before this block existed: the classifier returned PASS
-- while `authenticated` with the OTHER fixture owner's JWT subject read the
-- victim account's positions row, and `owns_account(victim)` answered false in
-- the same session. A total read bypass under a green run.
--
-- The expectation shape was wrong, not the expectation: "the policy I know
-- about is intact" instead of "the policy SET is exactly this". So the SET is
-- pinned, per table, with the count in it, and the comparison fails on an
-- ADDITION as loudly as on an edit.
--
-- WHICH TABLES. The four the auditor named were CONFIRMED BY MEASUREMENT, not
-- taken on trust: on generation latest exactly
-- equity_snapshots/performance/positions/routine_runs carry a policy whose
-- USING routes through owns_account, and on 0008 cash_flows and trades do too.
-- `public.accounts` is pinned as well. It is not guarded BY the predicate — it
-- is the relation the predicate READS, already in this closure by relkind,
-- owner and rowsecurity — and on the latest generation it carries RLS with
-- ZERO policies, i.e. it is deny-all to every client role. A single
-- `using (true)` there is the same total read bypass one table over, and
-- nothing else in this file would see it. C35 below keeps this list from going
-- short the way a typed list does.
--
-- WHY A HAND-WRITTEN PIN IS ADMISSIBLE HERE. Same argument as the counter-scan
-- in 2e: this is a SET EQUALITY against a complete enumeration the database
-- produces, per table, with the cardinality carried in the compared string. An
-- omission from the pin makes the run RED, not green. What a hand-written list
-- CAN still get wrong is the list of TABLES, and that is exactly what C35
-- checks against pg_policy.
-- ---------------------------------------------------------------------------

-- The pin is PLAINTEXT, for the same reason owns_account's body and
-- auth.uid()'s are (C24): a digest is not reviewable by reading. The digest
-- the comparison actually uses is computed FROM this plaintext by the same
-- formatter that runs over the catalogue, so the two can never be written
-- differently.
create temporary table cc_policyset_pin(
  generation text not null,
  tbl        text not null,
  polname    text not null,
  cmd        text not null,   -- r | a | w | d | *  (pg_policy.polcmd)
  permissive text not null,   -- permissive | restrictive
  roles      text not null,   -- comma-separated role names, or PUBLIC
  qual       text not null,   -- the USING expression, as pg_get_expr renders it
  withcheck  text not null,   -- the WITH CHECK expression, or '-'
  primary key (generation, tbl, polname)
);

-- The tables whose policy set is pinned. Kept SEPARATE from the policies
-- themselves so that "this table must have no policies at all" is a positive
-- statement with a row behind it, rather than the absence of rows above —
-- which is unreadable and, worse, indistinguishable from forgetting the table.
create temporary table cc_policyset_table(
  generation text not null,
  tbl        text not null,
  primary key (generation, tbl)
);

insert into cc_policyset_table(generation, tbl) values
  ('0008','public.accounts'),          ('latest','public.accounts'),
  ('0008','public.cash_flows'),
  ('0008','public.equity_snapshots'),  ('latest','public.equity_snapshots'),
  ('0008','public.performance'),       ('latest','public.performance'),
  ('0008','public.positions'),         ('latest','public.positions'),
  ('0008','public.routine_runs'),      ('latest','public.routine_runs'),
  ('0008','public.trades');
-- NOTE the deliberate asymmetry: on `latest` there is no row for cash_flows or
-- trades, because 0011/0012 removed them from the client read surface entirely
-- and they carry no policy there. They are not silently dropped — C35 derives
-- the routed set from pg_policy and requires every routed table to be pinned,
-- so if a policy came back on either of them this list would be short and the
-- run would refuse.

-- Every expression below is the SCHEMA-QUALIFIED rendering, i.e. what
-- pg_get_expr returns under `search_path = pg_catalog`. See cc_pol_qual below
-- for why that and not the connecting role's rendering.
insert into cc_policyset_pin(generation, tbl, polname, cmd, permissive, roles, qual, withcheck) values
  -- generation 0008: accounts is still client-readable, owner-scoped, for ALL
  -- commands, with the same expression on USING and WITH CHECK.
  ('0008','public.accounts','own accounts','*','permissive','PUBLIC',
     '(owner_id = auth.uid())','(owner_id = auth.uid())'),
  ('0008','public.cash_flows','read own cash flows','r','permissive','PUBLIC',
     'public.owns_account(account_id)','-'),
  ('0008','public.equity_snapshots','read own equity','r','permissive','PUBLIC',
     'public.owns_account(account_id)','-'),
  ('0008','public.performance','read own performance','r','permissive','PUBLIC',
     'public.owns_account(account_id)','-'),
  ('0008','public.positions','read own positions','r','permissive','PUBLIC',
     'public.owns_account(account_id)','-'),
  ('0008','public.routine_runs','read own routine runs','r','permissive','PUBLIC',
     '((account_id IS NULL) OR public.owns_account(account_id))','-'),
  ('0008','public.trades','read own trades','r','permissive','PUBLIC',
     'public.owns_account(account_id)','-'),
  -- generation latest: accounts has RLS on and NO policy of any kind, so it has
  -- no row here at all; its cc_policyset_table row above pins the empty set.
  ('latest','public.equity_snapshots','read own equity','r','permissive','PUBLIC',
     'public.owns_account(account_id)','-'),
  ('latest','public.performance','read own performance','r','permissive','PUBLIC',
     'public.owns_account(account_id)','-'),
  ('latest','public.positions','read own positions','r','permissive','PUBLIC',
     'public.owns_account(account_id)','-'),
  ('latest','public.routine_runs','read own routine runs','r','permissive','PUBLIC',
     '((account_id IS NULL) OR public.owns_account(account_id))','-');

-- `pg_get_expr` renders a function call RELATIVE TO THE CALLER'S SEARCH_PATH.
-- MEASURED, and the reason this wrapper exists: the classifier connects as
-- `supabase_admin`, whose search_path is `"$user", public, auth, extensions`,
-- so the accounts policy on generation 0008 comes back as
-- `(owner_id = uid())` — while the same query from a default psql session
-- returns `(owner_id = auth.uid())`. A pin written against either rendering is
-- a pin on the connecting role's settings, and would go red the day the
-- fixture's search_path changed and green the day an attacker's schema shadowed
-- a name on it. So every expression this arm compares is rendered under a
-- FIXED `search_path = pg_catalog`, which fully qualifies everything:
-- `auth.uid()` and `public.owns_account(account_id)`.
create function pg_temp.cc_pol_qual(pol_oid oid) returns text
language sql stable set search_path = pg_catalog as $fn$
  select coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '-')
    from pg_catalog.pg_policy p where p.oid = $1
$fn$;

create function pg_temp.cc_pol_check(pol_oid oid) returns text
language sql stable set search_path = pg_catalog as $fn$
  select coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '-')
    from pg_catalog.pg_policy p where p.oid = $1
$fn$;

-- ONE formatter for a policy and ONE for a set of them, called from BOTH sides
-- of the comparison — the pin and the catalogue. Two inline copies would let
-- the expected side be edited to match a mutated observed side while every
-- control still passed, which is the mistake C28's comment records.
create function pg_temp.cc_pol_desc(polname text, cmd text, permissive text,
                                    roles text, qual text, withcheck text)
returns text language sql immutable as $fn$
  select $1 || '/' || $2 || '/' || $3 || '/' || $4
      || '/q:' || encode(sha256(convert_to(pg_temp.cc_norm($5), 'UTF8')), 'hex')
      || '/c:' || encode(sha256(convert_to(pg_temp.cc_norm($6), 'UTF8')), 'hex')
$fn$;

-- The CARDINALITY is inside the compared string on purpose. Without it, a
-- comparison of sorted descriptors would still catch an addition — but only
-- because the concatenation grew, which is a property of this encoding rather
-- than a stated requirement. `n=` states it.
create function pg_temp.cc_polset_desc(descs text[]) returns text
language sql immutable as $fn$
  select 'n=' || cardinality($1) || ';'
      || coalesce((select string_agg(d, ';' order by d collate "C")
                     from unnest($1) d), '<no policy>')
$fn$;

insert into cc_dep_expect(key, dep_kind, dep_id, prop, expected)
select 'owns_account', 'policyset', t.tbl, 'policy_set',
       pg_temp.cc_polset_desc(coalesce((
         select array_agg(pg_temp.cc_pol_desc(p.polname, p.cmd, p.permissive,
                                              p.roles, p.qual, p.withcheck))
           from cc_policyset_pin p
          where p.generation = t.generation and p.tbl = t.tbl), '{}'::text[]))
  from cc_policyset_table t
 where t.generation = pg_temp.cc_cfg('generation');


-- ---------------------------------------------------------------------------
-- 2d(iii). ADV-2 — WHAT MAKES AN RLS POLICY IRRELEVANT WITHOUT CHANGING IT
--
-- 2d(ii) closed the shape "the pinned policy is intact and a SECOND one makes
-- it moot". This block closes the shapes where the policy set is byte-identical
-- AND RLS is still enabled AND the predicate still answers correctly, and the
-- rows come out anyway. Every one of the four below was MEASURED on this exact
-- fixture as a live cross-tenant read while `catalogue-classify.sh --generation
-- latest` returned PASS. The attacker is fixture owner 4444 with its JWT
-- subject set; the victim is account 2222 (owner 1111) with 21
-- equity_snapshots rows; `public.owns_account('2222…')` answered FALSE in the
-- same session in every case.
--
--   (C) OWNERSHIP.  `alter table public.equity_snapshots owner to authenticated`
--       -> 21 rows. A table's OWNER is exempt from its own RLS policies unless
--       FORCE ROW LEVEL SECURITY is set on the table. `relforcerowsecurity` is
--       FALSE on every table in this schema (measured, both generations), so
--       ownership is load-bearing and was pinned for `public.accounts` ONLY.
--       Reverting the owner to postgres: 0 rows for the attacker.
--
--   (D) BYPASSRLS.  `alter role authenticated bypassrls` -> every guarded table,
--       plus profiles and audit_log, each measured with a reversion control (see
--       cc_bypassrls() in section 1 for the numbers). It is NOT closed here: it
--       is a cluster-wide fact, not a property of this closure, so it lives with
--       the other ENVIRONMENT fingerprints — cc_bypassrls(), the `bypassrls`
--       column of cc_env/cc_env_expect, and reason code env:bypassrls_set_drift.
--       One `alter role` defeats every policy in the database at once, including
--       on tables this closure says nothing about, which is exactly why it does
--       not belong in a per-table arm.
--
--   (E) INHERITANCE / PARTITIONING.  `alter table public.equity_snapshots
--       inherit <a new unguarded parent>; grant select on the parent to
--       authenticated` -> 21 rows through the parent. PostgreSQL applies the
--       policies OF THE RELATION NAMED IN THE QUERY; the child's own policies
--       are not consulted when the parent is read. Nothing about the child
--       changes: same owner, RLS still on, same single policy. pg_inherits
--       carries partition attachment too, so one pin covers both.
--
--   (F) A DEPENDENT VIEW.  A view over a guarded table runs with the VIEW
--       OWNER's row-security context unless it is declared
--       `security_invoker = true`. `create view public.cc_evil_view as select *
--       from public.equity_snapshots; grant select to authenticated` -> 21 rows,
--       view owner supabase_admin.
--       This is not hypothetical here. On generation `latest` the client's ONLY
--       read path to accounts / cash_flows / trades is three such views —
--       `accounts_safe`, `cash_flows_safe`, `trades_safe` — owned by `postgres`,
--       which carries BYPASSRLS, granted SELECT to `authenticated`, and scoping
--       rows by a WHERE clause IN THE VIEW BODY rather than by any policy.
--       MEASURED: dropping `owner_id = auth.uid()` from `accounts_safe` handed
--       the attacker every tenant's account row while RLS stayed enabled on
--       `public.accounts`, its pinned EMPTY policy set stayed empty, and the
--       classifier returned PASS. The authorization of that read path was
--       pinned NOWHERE in this file.
--
-- WHICH TABLES. Not taken on trust. MEASURED with
--   select relname from pg_policy join pg_class ... where pg_get_expr(polqual)
--     like '%owns_account%'
-- on pristine clones of both generations: `latest` routes exactly
-- equity_snapshots / performance / positions / routine_runs, and `0008` those
-- four plus cash_flows and trades. `public.accounts` is in the closure as the
-- relation the predicate READS. The set this arm iterates is therefore
-- cc_policyset_table — the SAME list ADV-1 pins and the same list C35 already
-- checks against pg_policy — so the two arms cannot drift apart and a short
-- list is caught once for both.
-- ---------------------------------------------------------------------------

-- pg_get_viewdef renders relative to the caller's search_path, exactly as
-- pg_get_expr does; see cc_pol_qual for the measurement. Fixed to pg_catalog
-- so the pin is a property of the database and not of supabase_admin's
-- search_path.
create function pg_temp.cc_viewdef(rel oid) returns text
language sql stable set search_path = pg_catalog as $fn$
  select pg_catalog.pg_get_viewdef($1, true)
$fn$;

-- Who holds what on a relation, as PostgreSQL's own ACL evaluation renders it,
-- grantee by grantee. The raw relacl array is insertion-ordered and therefore
-- not comparable; this is.
create function pg_temp.cc_rel_grants(rel oid) returns text
language sql stable as $fn$
  select coalesce((
    select string_agg(g || '=' || p, ',' order by g collate "C")
      from (select case when a.grantee = 0 then 'PUBLIC'
                        else pg_get_userbyid(a.grantee)::text end as g,
                   string_agg(a.privilege_type, '+'
                              order by a.privilege_type collate "C") as p
              from pg_class c,
                   lateral aclexplode(coalesce(c.relacl,
                                               acldefault('r', c.relowner))) a
             where c.oid = $1
             group by 1) s), '<none>')
$fn$;

-- (E). Every inheritance edge the guarded table sits on, in both directions.
-- A new PARENT is the attack (query the parent, read the child's rows with the
-- parent's policies); a new CHILD is worth seeing too, because it shares the
-- table's storage lineage and can carry its own grants.
create function pg_temp.cc_inheritance(rel oid) returns text
language sql stable as $fn$
  select coalesce((select string_agg(d, ',' order by d collate "C") from (
      select 'parent:' || pn.nspname || '.' || pc.relname as d
        from pg_inherits i
        join pg_class pc     on pc.oid = i.inhparent
        join pg_namespace pn on pn.oid = pc.relnamespace
       where i.inhrelid = $1
      union all
      select 'child:' || cn.nspname || '.' || cc2.relname
        from pg_inherits i
        join pg_class cc2    on cc2.oid = i.inhrelid
        join pg_namespace cn on cn.oid = cc2.relnamespace
       where i.inhparent = $1) s), '<none>')
$fn$;

-- ONE formatter for a dependent relation, called from BOTH sides of the
-- comparison, for the reason C28's comment records: two inline copies would let
-- the expected side be edited to match a mutated observed side.
-- The definition is DIGESTED and everything a reader needs to judge exposure —
-- kind, owner, options (security_invoker/security_barrier live here) and the
-- grant list — is plaintext in the descriptor itself.
create function pg_temp.cc_depview_desc(viewrel text, kind text, owner text,
                                        opts text, grants text, viewdef text)
returns text language sql immutable as $fn$
  select $1 || '/' || $2 || '/owner:' || $3 || '/opts:' || $4
      || '/grants:' || $5
      || '/def:' || encode(sha256(convert_to(pg_temp.cc_norm($6), 'UTF8')), 'hex')
$fn$;

create function pg_temp.cc_depset_desc(descs text[]) returns text
language sql immutable as $fn$
  select 'n=' || cardinality($1) || ';'
      || coalesce((select string_agg(d, ';' order by d collate "C")
                     from unnest($1) d), '<none>')
$fn$;

-- (F). Every relation whose rewrite rule reads the guarded table — a view or a
-- materialised view, in ANY schema, found through pg_depend rather than through
-- a list. ONE HOP IS ENOUGH FOR DETECTION: a chain v2 -> v1 -> table must have
-- a first hop, and v1 shows up here.
create function pg_temp.cc_dependent_rels(rel oid) returns text
language sql stable as $fn$
  select pg_temp.cc_depset_desc(coalesce((
    select array_agg(pg_temp.cc_depview_desc(
             vn.nspname || '.' || v.relname,
             v.relkind::text,
             pg_get_userbyid(v.relowner)::text,
             coalesce(array_to_string(v.reloptions, ','), '-'),
             pg_temp.cc_rel_grants(v.oid),
             pg_temp.cc_viewdef(v.oid)))
      from (select distinct rw.ev_class as vrel
              from pg_depend dep
              join pg_rewrite rw on rw.oid = dep.objid
                                and dep.classid = 'pg_rewrite'::regclass
             where dep.refclassid = 'pg_class'::regclass
               and dep.refobjid = $1
               and rw.ev_class <> $1) d
      join pg_class v      on v.oid = d.vrel
      join pg_namespace vn on vn.oid = v.relnamespace), '{}'::text[]))
$fn$;

-- R5-CTLPREC(1). THE SIX GUARDED PROPERTIES, READ IN ONE PLACE.
--
-- C38's comment used to say "the observers exercised here are the SAME
-- functions cc_dep_obs calls". That was true of `cc_inheritance` and
-- `cc_dependent_rels` and FALSE of the other four — relkind, owner, rowsecurity
-- and forcerowsecurity were re-derived by an inline `select … from pg_class` in
-- BOTH places, which is exactly the two-inline-copies shape C28's comment
-- rejects for the closure parser and C36's for the policy formatter: the
-- control can keep passing while the observer it is supposed to prove is edited
-- underneath it.
--
-- So all six live here, in one function, called by cc_dep_obs and by C38. The
-- caller still decides what an unresolvable table means: both call sites select
-- FROM pg_class, so a table that no longer resolves yields NULL (which C29
-- refuses outright) rather than a value that could coincide with a pin.
create function pg_temp.cc_guarded_prop(rel oid, prop text) returns text
language sql stable as $fn$
  select case $2
    when 'relkind'          then c.relkind::text
    when 'owner'            then pg_get_userbyid(c.relowner)::text
    when 'rowsecurity'      then case when c.relrowsecurity then 't' else 'f' end
    when 'forcerowsecurity' then case when c.relforcerowsecurity then 't' else 'f' end
    when 'inheritance'      then pg_temp.cc_inheritance(c.oid)
    when 'dependent_rels'   then pg_temp.cc_dependent_rels(c.oid)
    else '<unknown property>' end
    from pg_class c where c.oid = $1
$fn$;

-- The PLAINTEXT pin for (F), for the same reason ADV-1's policy pin is
-- plaintext: a digest is not reviewable by reading. The digest the comparison
-- uses is computed FROM this plaintext by cc_depview_desc, the same function
-- that runs over the catalogue, so the two sides cannot be written differently.
create temporary table cc_depview_pin(
  generation text not null,
  tbl        text not null,   -- the guarded table it reads
  viewrel    text not null,
  relkind    text not null,
  owner      text not null,
  opts       text not null,
  grants     text not null,
  viewdef    text not null,
  primary key (generation, tbl, viewrel)
);

-- generation 0008 has NO relation in `public` of kind v or m at all (measured),
-- so it contributes no row here and every one of its guarded tables pins the
-- empty dependent set.
--
-- On `latest`, these three ARE the client read path for accounts, cash_flows
-- and trades. They are owned by `postgres` (BYPASSRLS), granted SELECT to
-- `authenticated`, and they authorise by a WHERE clause of their own. Read
-- those WHERE clauses: `owner_id = auth.uid()` / `a.owner_id = auth.uid()` is
-- the entire tenant boundary on this path.
-- The definitions below are what `pg_get_viewdef(oid, true)` returns under
-- `search_path = pg_catalog`; whitespace is normalised away by cc_norm before
-- hashing, so the line breaks here are for the reader.
insert into cc_depview_pin(generation, tbl, viewrel, relkind, owner, opts, grants, viewdef) values
  ('latest','public.accounts','public.accounts_safe','v','postgres',
   'security_barrier=true',
   'authenticated=SELECT,'
   'postgres=DELETE+INSERT+MAINTAIN+REFERENCES+SELECT+TRIGGER+TRUNCATE+UPDATE,'
   'service_role=DELETE+INSERT+MAINTAIN+REFERENCES+SELECT+TRIGGER+TRUNCATE+UPDATE',
   ' SELECT id, nickname, mode, status, color, is_active, '
   'CASE WHEN alpaca_account_number IS NULL THEN NULL::text '
   'WHEN length(alpaca_account_number) < 4 THEN NULL::text '
   'ELSE ''••••''::text || "right"(alpaca_account_number, 4) '
   'END AS broker_account_mask, last_verified_at, created_at '
   'FROM public.accounts a WHERE owner_id = auth.uid() AND deleted_at IS NULL;'),
  ('latest','public.accounts','public.cash_flows_safe','v','postgres',
   'security_barrier=true',
   'authenticated=SELECT,'
   'postgres=DELETE+INSERT+MAINTAIN+REFERENCES+SELECT+TRIGGER+TRUNCATE+UPDATE,'
   'service_role=DELETE+INSERT+MAINTAIN+REFERENCES+SELECT+TRIGGER+TRUNCATE+UPDATE',
   ' SELECT c.id, c.account_id, c.flow_date, c.amount, c.kind, c.source, '
   'c.created_at FROM public.cash_flows c '
   'JOIN public.accounts a ON a.id = c.account_id '
   'WHERE a.owner_id = auth.uid() AND a.deleted_at IS NULL;'),
  ('latest','public.accounts','public.trades_safe','v','postgres',
   'security_barrier=true',
   'authenticated=SELECT,'
   'postgres=DELETE+INSERT+MAINTAIN+REFERENCES+SELECT+TRIGGER+TRUNCATE+UPDATE,'
   'service_role=DELETE+INSERT+MAINTAIN+REFERENCES+SELECT+TRIGGER+TRUNCATE+UPDATE',
   ' SELECT t.id, t.account_id, t.symbol, t.side, t.qty, t.price, t.notional, '
   't.filled_at, t.realized_pnl, t.realized_pnl_pct, t.reason, t.strategy, '
   't.created_at FROM public.trades t '
   'JOIN public.accounts a ON a.id = t.account_id '
   'WHERE a.owner_id = auth.uid() AND a.deleted_at IS NULL;');

-- The five scalar properties, per guarded table. `owner` and
-- `forcerowsecurity` are the (C) pair; `relkind` refuses a table swapped for a
-- view; `inheritance` is (E). `rowsecurity` is deliberately REDUNDANT: the
-- `rls` arm already states it for the routed tables and the `relation` arm
-- states it for public.accounts, and restating it over the WHOLE closure on one
-- row set means the three arms cannot disagree about a table. The redundancy is
-- visible in the output — mutants 61 and 62 each report two codes now, and the
-- suite asserts both.
--
-- forcerowsecurity is pinned at its MEASURED value, which is 'f'. That is
-- deliberately not rounded up into a claim: FORCE is OFF in this schema, so the
-- owner check is the load-bearing half of pair (C), and this row exists so that
-- a migration turning FORCE on, and an attacker turning it back off, are both
-- visible and both require a deliberate re-pin.
insert into cc_dep_expect(key, dep_kind, dep_id, prop, expected)
select 'owns_account', 'guarded', t.tbl, p.prop, p.expected
  from cc_policyset_table t
  cross join (values ('relkind','r'),
                     ('owner','postgres'),
                     ('rowsecurity','t'),
                     ('forcerowsecurity','f'),
                     ('inheritance','<none>')) as p(prop, expected)
 where t.generation = pg_temp.cc_cfg('generation');

insert into cc_dep_expect(key, dep_kind, dep_id, prop, expected)
select 'owns_account', 'guarded', t.tbl, 'dependent_rels',
       pg_temp.cc_depset_desc(coalesce((
         select array_agg(pg_temp.cc_depview_desc(v.viewrel, v.relkind, v.owner,
                                                  v.opts, v.grants, v.viewdef))
           from cc_depview_pin v
          where v.generation = t.generation and v.tbl = t.tbl), '{}'::text[]))
  from cc_policyset_table t
 where t.generation = pg_temp.cc_cfg('generation');

create temporary table cc_dep_obs as
select
  d.key, d.dep_kind, d.dep_id, d.prop, d.expected,
  case
    when d.dep_kind = 'function' then
      (select case d.prop
         when 'body_sha256' then encode(sha256(convert_to(
                                   pg_temp.cc_norm(p.prosrc), 'UTF8')), 'hex')
         when 'owner'       then pg_get_userbyid(p.proowner)::text
         when 'language'    then l.lanname::text
         when 'secdef'      then case when p.prosecdef then 't' else 'f' end
         when 'volatility'  then p.provolatile::text
         when 'proconfig'   then coalesce(p.proconfig::text, '<none>')
         when 'overloads'   then (select count(*)::text from pg_proc p2
                                    where p2.pronamespace = p.pronamespace
                                      and p2.proname = p.proname)
         else '<unknown property>' end
         from pg_proc p
         join pg_language l on l.oid = p.prolang
        where p.oid = to_regprocedure(d.dep_id))
    when d.dep_kind = 'relation' then
      (select case d.prop
         when 'relkind'     then c.relkind::text
         when 'owner'       then pg_get_userbyid(c.relowner)::text
         when 'rowsecurity' then case when c.relrowsecurity then 't' else 'f' end
         else '<unknown property>' end
         from pg_class c where c.oid = to_regclass(d.dep_id))
    when d.dep_kind = 'rls' then
      (select case when c.relrowsecurity then 't' else 'f' end
         from pg_class c where c.oid = to_regclass(d.dep_id))
    -- ADV-2. The outer select is over pg_class for the same reason the
    -- policyset arm's is: a table that no longer resolves must observe NULL,
    -- which C29 refuses outright, rather than a value that could coincide with
    -- an expectation.
    when d.dep_kind = 'guarded' then
      -- R5-CTLPREC(1): ONE observer, shared with C38. See cc_guarded_prop.
      (select pg_temp.cc_guarded_prop(c.oid, d.prop)
         from pg_class c where c.oid = to_regclass(d.dep_id))
    when d.dep_kind = 'policy' then
      (select coalesce(string_agg(x, ';' order by x collate "C"), '<no policy>')
         from (
           select n.nspname || '.' || c.relname || '/' || pol.polname || '/'
                  || pol.polcmd::text || '/'
                  || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-') as x
             from pg_policy pol
             join pg_class c     on c.oid = pol.polrelid
             join pg_namespace n on n.oid = c.relnamespace
            where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
                    like '%owns_account%') s)
    when d.dep_kind = 'policyset' then
      -- The outer SELECT is over pg_class, not over pg_policy, so a table that
      -- no longer resolves yields NULL rather than the same `n=0;<no policy>`
      -- an intentionally unpoliced table yields. "The table is gone" and "the
      -- table has no policies" must not be the same observation, and C29
      -- refuses a null observation outright.
      (select pg_temp.cc_polset_desc(coalesce((
                select array_agg(pg_temp.cc_pol_desc(
                         pol.polname,
                         pol.polcmd::text,
                         case when pol.polpermissive then 'permissive'
                                                     else 'restrictive' end,
                         case when 0 = any (pol.polroles) then 'PUBLIC'
                              else coalesce((select string_agg(r.rolname::text, ','
                                                      order by r.rolname::text collate "C")
                                               from pg_roles r
                                              where r.oid = any (pol.polroles)),
                                            '<no role>') end,
                         pg_temp.cc_pol_qual(pol.oid),
                         pg_temp.cc_pol_check(pol.oid)))
                  from pg_policy pol where pol.polrelid = c.oid), '{}'::text[]))
         from pg_class c where c.oid = to_regclass(d.dep_id))
    else '<unknown dep_kind>'
  end as observed
from cc_dep_expect d;

alter table cc_dep_obs add column ok boolean;
update cc_dep_obs set ok = (observed is not distinct from expected);

-- The dependency parser, defined ONCE. `array_agg(distinct x order by y)` is
-- rejected unless y is textually x, and `order by 1` inside an aggregate is the
-- constant 1 rather than a positional reference, so both aggregates select
-- distinct rows in a subquery first and sort the result explicitly under
-- COLLATE "C".
create function pg_temp.cc_body_fns(body text) returns text[]
language sql immutable as $fn$
  select coalesce(array_agg(f order by f collate "C"), '{}'::text[])
    from (select distinct m[1] || '.' || m[2] as f
            from regexp_matches($1,
                   '([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)\s*\(', 'g') m) s
$fn$;

create function pg_temp.cc_body_rels(body text) returns text[]
language sql immutable as $fn$
  select coalesce(array_agg(r order by r collate "C"), '{}'::text[])
    from (select distinct case when m[1] like '%.%' then m[1]
                               else 'public.' || m[1] end as r
            from regexp_matches($1,
                   '\m(?:from|join)\s+([a-z_][a-z0-9_.]*)', 'gi') m) s
$fn$;

-- C27 / C28 — the closure must be COMPLETE with respect to the pinned body
-- AND the pinned policy expressions (R5-CLOSURE-DERIV), and the parser that
-- decides that must be shown to work.
do $cc$
declare
  pinned    text := pg_temp.cc_norm(
                      'select exists ( select 1 from accounts where id = acct '
                      'and owner_id = auth.uid() and deleted_at is null );');
  planted   text := 'select q from cc_planted_relation join zz_other on true '
                    'where q = zzz.planted_fn(1)';
  fns       text[];
  rels      text[];
  ctl_fns   text[];
  ctl_rels  text[];
  declared_f text[];
  declared_r text[];
  missing_f text[];
  missing_r text[];
  polexpr   text;
  pol_fns   text[];
  pol_rels  text[];
  union_f   text[];
  union_r   text[];
begin
  -- ONE parser, called four times. The control below plants a body into the
  -- SAME functions the real body goes through; two inline copies of the regex
  -- would let the control keep passing while the parser it is supposed to
  -- control was edited underneath it.
  fns      := pg_temp.cc_body_fns(pinned);
  rels     := pg_temp.cc_body_rels(pinned);
  ctl_fns  := pg_temp.cc_body_fns(planted);
  ctl_rels := pg_temp.cc_body_rels(planted);

  insert into cc_control values ('C28_closure_parser_works',
    ctl_fns = array['zzz.planted_fn']::text[]
      and ctl_rels = array['public.cc_planted_relation','public.zz_other']::text[]
      and not ('public.zzz' = any (rels)),
    format('planted body -> functions=[%s] relations=[%s]; real body -> '
           'functions=[%s] relations=[%s]',
           array_to_string(ctl_fns, ','), array_to_string(ctl_rels, ','),
           array_to_string(fns, ','), array_to_string(rels, ',')));

  select coalesce(array_agg(distinct replace(dep_id, '()', '')), '{}'::text[])
    into declared_f from cc_dep_expect
   where key = 'owns_account' and dep_kind = 'function';
  select coalesce(array_agg(distinct dep_id), '{}'::text[])
    into declared_r from cc_dep_expect
   where key = 'owns_account' and dep_kind = 'relation';

  -- R5-CLOSURE-DERIV. The completeness requirement used to be derived from
  -- owns_account's BODY TEXT alone. That is the wrong source set by one term:
  -- what has to be complete is the set of things THE TENANT BOUNDARY depends
  -- on, and the boundary is the pinned POLICY EXPRESSIONS as much as it is the
  -- predicate they call. A policy re-pinned to `owner_id = auth.jwt() ->>
  -- 'sub'` would add a dependency the body never mentions, and nothing here
  -- would have required it to be in the closure.
  --
  -- MEASURED, on both generations, before this was added: the union adds
  -- nothing. `auth.uid` is already in the closure — but only because
  -- owns_account happens to call it too, and on generation 0008 the
  -- `own accounts` policy calls it directly. That coincidence was
  -- LOAD-BEARING and undocumented; deriving from the union makes it a
  -- consequence instead of a coincidence, and if it ever stops holding, this
  -- control names the term that appeared.
  --
  -- The SAME two parser functions are used, for C28's reason. The closure key
  -- itself is subtracted: `public.owns_account` is the subject of the closure,
  -- not one of its dependencies.
  select coalesce(string_agg(p.qual || ' ' || p.withcheck, ' '), '')
    into polexpr
    from cc_policyset_pin p
   where p.generation = pg_temp.cc_cfg('generation');
  pol_fns  := pg_temp.cc_minus(pg_temp.cc_body_fns(polexpr),
                               array['public.owns_account']::text[]);
  pol_rels := pg_temp.cc_body_rels(polexpr);

  union_f := fns  || pg_temp.cc_minus(pol_fns,  fns);
  union_r := rels || pg_temp.cc_minus(pol_rels, rels);

  missing_f := pg_temp.cc_minus(union_f, declared_f);
  missing_r := pg_temp.cc_minus(union_r, declared_r);

  insert into cc_control values ('C27_closure_is_complete',
    cardinality(missing_f) = 0 and cardinality(missing_r) = 0
      and cardinality(fns) > 0 and cardinality(rels) > 0
      -- the policy-expression half must not be vacuous: every generation of
      -- this schema pins at least one policy that calls the predicate, so a
      -- parse that found no function at all means the pin was not read
      and cardinality(pg_temp.cc_body_fns(polexpr)) > 0,
    format('pinned body calls [%s] and reads [%s]; the pinned POLICY '
           'expressions additionally call [%s] and read [%s]; the declared '
           'closure names [%s] and [%s]; undeclared: [%s] [%s]',
           array_to_string(fns, ','), array_to_string(rels, ','),
           coalesce(nullif(array_to_string(pg_temp.cc_minus(pol_fns, fns), ','), ''), '<nothing new>'),
           coalesce(nullif(array_to_string(pg_temp.cc_minus(pol_rels, rels), ','), ''), '<nothing new>'),
           array_to_string(declared_f, ','), array_to_string(declared_r, ','),
           array_to_string(missing_f, ','), array_to_string(missing_r, ',')));

  -- C29 — the closure observer must actually read the catalogue. An observer
  -- returning null for everything would make every row "not distinct from" its
  -- expectation only by accident; requiring a known-good row to be OK and the
  -- observed values to be non-null is the floor.
  insert into cc_control values ('C29_closure_observer_reads',
    (select count(*) from cc_dep_obs) >= 10
      and not exists (select 1 from cc_dep_obs where observed is null)
      and (select observed from cc_dep_obs
            where dep_kind = 'function' and prop = 'language') = 'sql',
    format('%s closure row(s) observed, %s with a null observation',
           (select count(*) from cc_dep_obs),
           (select count(*) from cc_dep_obs where observed is null)));
end
$cc$;

-- ---------------------------------------------------------------------------
-- C34 — the `rls` arm of the closure must be DERIVED-COMPLETE
--
-- The four function/relation properties above are checked for completeness
-- against the pinned body AND the pinned policy expressions by C27, because
-- they can be parsed out of both. The
-- `rls` rows cannot: which tables owns_account is supposed to guard is not
-- visible in owns_account's own text. They were therefore TYPED IN, per
-- generation — which is the same shape as the tombstone name list that
-- reported itself whole while being short by three, and the same shape as the
-- expectation catalogue that carried four of five names.
--
-- The list is short exactly when someone removes a line from it, and nothing
-- above would notice: dropping `public.performance` from the array would leave
-- `alter table public.performance disable row level security` invisible, with
-- every other check in this file still green. So the set is checked against
-- one the DATABASE produces: every table carrying a policy whose USING clause
-- routes through owns_account must have an `rls` row. The comparison is one
-- directional on purpose — a table that loses its policy entirely shrinks the
-- derived set, and THAT is caught by the policy-set pin as
-- dep:policy_set_changed, not here.
-- ---------------------------------------------------------------------------
do $cc$
declare
  routed    text[];   -- derived from pg_policy
  declared  text[];   -- the typed-in `rls` arm
  unguarded text[];
  synth_all text[] := array['cc_synth_t1','cc_synth_t2'];
begin
  select coalesce(array_agg(distinct n.nspname || '.' || c.relname), '{}'::text[])
    into routed
    from pg_policy pol
    join pg_class c     on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') like '%owns_account%';

  select coalesce(array_agg(distinct dep_id), '{}'::text[])
    into declared
    from cc_dep_expect where key = 'owns_account' and dep_kind = 'rls';

  unguarded := pg_temp.cc_minus(routed, declared);

  insert into cc_control values ('C34_rls_arm_covers_every_routed_table',
    -- The comparator is proven on synthetic input in the same statement, for
    -- the same reason C23 exists: "nothing is uncovered" from a set difference
    -- nobody exercised is an absence claim with no evidence behind it.
    pg_temp.cc_minus(synth_all, array['cc_synth_t1']) = array['cc_synth_t2']::text[]
      and cardinality(routed) > 0
      and cardinality(declared) > 0
      and cardinality(unguarded) = 0,
    format('policies route through owns_account on [%s]; the closure declares '
           'an rls row for [%s]; routed but NOT guarded: %s',
           array_to_string(routed, ','), array_to_string(declared, ','),
           coalesce(nullif(array_to_string(unguarded, ','), ''), '<none>')));
end
$cc$;

-- ---------------------------------------------------------------------------
-- C35 — the `policyset` arm must cover every routed table, and it must have
--       actually READ pg_policy
--
-- C34's argument, one arm over. The `policyset` list is typed in per
-- generation, so it goes short exactly when a line is deleted, and a deleted
-- line makes ADV-1 invisible again for that table. Three things are required:
--
--   (a) every table the DATABASE routes through owns_account carries a
--       policyset row, and so does every table the `rls` arm names — the two
--       arms may not disagree about which tables are in the closure;
--   (b) every pinned table resolves. A typo in a table name would otherwise
--       give a NULL observation, which C29 catches, but naming it here says
--       WHICH one;
--   (c) THE READ-BACK. `public.accounts` on the latest generation is pinned to
--       the EMPTY policy set, and an empty set is exactly what a scanner that
--       silently stopped scanning would also produce. So the observer's own
--       `n=` counts are summed out of the descriptors it built and compared
--       against a straight count(*) over pg_policy computed here, by a
--       different query, from the pinned table list. If the observer read
--       nothing, the sums disagree and this control fails loudly instead of
--       every policyset row passing together.
-- ---------------------------------------------------------------------------
do $cc$
declare
  routed      text[];
  declared_r  text[];   -- the `rls` arm
  pinned      text[];   -- the `policyset` arm
  unpinned    text[];
  unresolved  text[];
  obs_total   int;
  cat_total   int;
  n_rows      int;
  n_routed_pol int;
  n_qualified  int;
  synth_all   text[] := array['cc_synth_p1','cc_synth_p2'];
begin
  select coalesce(array_agg(distinct n.nspname || '.' || c.relname), '{}'::text[])
    into routed
    from pg_policy pol
    join pg_class c     on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') like '%owns_account%';

  select coalesce(array_agg(distinct dep_id), '{}'::text[]) into declared_r
    from cc_dep_expect where key = 'owns_account' and dep_kind = 'rls';
  select coalesce(array_agg(distinct dep_id), '{}'::text[]) into pinned
    from cc_dep_expect where key = 'owns_account' and dep_kind = 'policyset';

  unpinned := pg_temp.cc_minus(routed, pinned)
              || pg_temp.cc_minus(declared_r, pinned);

  select coalesce(array_agg(t order by t collate "C"), '{}'::text[])
    into unresolved
    from unnest(pinned) t where to_regclass(t) is null;

  -- (c) the read-back, both sides computed here and neither taken from the
  -- other. The observed side parses the cardinality the observer wrote; the
  -- catalogue side counts rows in pg_policy for the same table list.
  select coalesce(sum(substring(o.observed from '^n=([0-9]+);')::int), -1),
         count(*)
    into obs_total, n_rows
    from cc_dep_obs o
   where o.key = 'owns_account' and o.dep_kind = 'policyset';

  select count(*) into cat_total
    from pg_policy pol
   where pol.polrelid in (select to_regclass(t) from unnest(pinned) t
                           where to_regclass(t) is not null);

  -- The renderer must be producing SCHEMA-QUALIFIED text. Every policy on a
  -- routed table routes through owns_account by definition of `routed`, so
  -- every one of them must render `public.owns_account`. If cc_pol_qual ever
  -- stopped forcing search_path, this session's `public, auth` path would
  -- render the bare `owns_account(...)` and this count would fall short.
  select count(*),
         count(*) filter (where pg_temp.cc_pol_qual(pol.oid) like '%public.owns_account%')
    into n_routed_pol, n_qualified
    from pg_policy pol
   where pol.polrelid in (select to_regclass(t) from unnest(routed) t
                           where to_regclass(t) is not null)
     and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') like '%owns_account%';

  insert into cc_control values ('C35_policyset_arm_covers_every_routed_table',
    -- the set comparator, proven on synthetic input in the same statement, for
    -- the same reason C23 and C34 do it
    pg_temp.cc_minus(synth_all, array['cc_synth_p1']) = array['cc_synth_p2']::text[]
      and cardinality(routed) > 0
      and cardinality(pinned) > 0
      and cardinality(unpinned) = 0
      and cardinality(unresolved) = 0
      and n_rows = cardinality(pinned)
      and obs_total = cat_total
      and n_routed_pol > 0
      and n_qualified = n_routed_pol,
    format('policies route through owns_account on [%s]; the rls arm names [%s]; '
           'the policyset arm pins [%s]; routed-or-rls but NOT pinned: %s; '
           'pinned but unresolvable: %s; %s policyset row(s) observed carrying '
           '%s polic(ies) in total, against %s row(s) in pg_policy for the same '
           'tables; %s of %s routed polic(ies) render schema-qualified',
           array_to_string(routed, ','), array_to_string(declared_r, ','),
           array_to_string(pinned, ','),
           coalesce(nullif(array_to_string(unpinned, ','), ''), '<none>'),
           coalesce(nullif(array_to_string(unresolved, ','), ''), '<none>'),
           n_rows, obs_total, cat_total, n_qualified, n_routed_pol));
end
$cc$;

-- ---------------------------------------------------------------------------
-- C36 — the policy-set formatter and comparator must SEE an addition
--
-- The whole ADV-1 repair rests on one string comparison. "The observed
-- descriptor equals the pinned descriptor" is a check whose passing value on a
-- pristine schema is indistinguishable from the value it would take if
-- cc_pol_desc collapsed every policy to the same text, or if cc_polset_desc
-- dropped its input. So the two functions are driven over synthetic input here
-- and required to DISCRIMINATE in every dimension the pin claims to cover —
-- addition, name, command, permissive/restrictive, roles, USING, WITH CHECK —
-- and to be INSENSITIVE to the two things that must not cause a false red:
-- the order the catalogue happens to return policies in, and whitespace inside
-- an expression.
-- ---------------------------------------------------------------------------
do $cc$
declare
  a   text := pg_temp.cc_pol_desc('p1','r','permissive','PUBLIC','owns_account(x)','-');
  -- The whitespace insensitivity claimed below is EXACTLY cc_norm's: runs of
  -- whitespace collapse to one space and the ends are trimmed. It is not
  -- "spaces do not matter" — `owns_account( x )` and `owns_account(x)` are
  -- different strings to cc_norm and therefore different policies to this pin.
  -- Measured: writing this control with that pair failed, which is how the
  -- claim got narrowed to what the normaliser really does.
  a2  text := pg_temp.cc_pol_desc('p1','r','permissive','PUBLIC',
                                  E'  owns_account(x)\n\tand   true ','-');
  a3  text := pg_temp.cc_pol_desc('p1','r','permissive','PUBLIC',
                                  'owns_account(x) and true','-');
  b   text := pg_temp.cc_pol_desc('p2','r','permissive','PUBLIC','true','-');
  nm  text := pg_temp.cc_pol_desc('p9','r','permissive','PUBLIC','owns_account(x)','-');
  cmd text := pg_temp.cc_pol_desc('p1','w','permissive','PUBLIC','owns_account(x)','-');
  perm text := pg_temp.cc_pol_desc('p1','r','restrictive','PUBLIC','owns_account(x)','-');
  rol text := pg_temp.cc_pol_desc('p1','r','permissive','anon','owns_account(x)','-');
  qal text := pg_temp.cc_pol_desc('p1','r','permissive','PUBLIC','true','-');
  chk text := pg_temp.cc_pol_desc('p1','r','permissive','PUBLIC','owns_account(x)','true');
  one text := pg_temp.cc_polset_desc(array[a]);
  two text := pg_temp.cc_polset_desc(array[a, b]);
  rev text := pg_temp.cc_polset_desc(array[b, a]);
  nil text := pg_temp.cc_polset_desc('{}'::text[]);
  discriminates boolean;
  stable_       boolean;
begin
  discriminates :=
        one <> two                              -- THE ADV-1 CASE: an addition
    and one like 'n=1;%' and two like 'n=2;%'   -- the cardinality is carried
    and nil = 'n=0;<no policy>'                 -- and an empty set says so
    and nil <> one
    and a <> nm and a <> cmd and a <> perm      -- name / command / permissiveness
    and a <> rol and a <> qal and a <> chk;     -- roles / USING / WITH CHECK
  stable_ :=
        two = rev                               -- catalogue order is not a finding
    and a2 = a3                                 -- nor is a collapsed whitespace run
    and a  <> a3;                               -- but a real clause still is

  insert into cc_control values ('C36_policyset_comparator_discriminates',
    discriminates and stable_,
    format('addition seen: %s; empty set encodes as %L; name/cmd/permissive/'
           'roles/using/withcheck all distinguished: %s; order-insensitive: %s; '
           'cc_norm whitespace run collapsed: %s; an added clause still seen: %s',
           one <> two, nil,
           (a <> nm and a <> cmd and a <> perm and a <> rol and a <> qal and a <> chk),
           two = rev, a2 = a3, a <> a3));
end
$cc$;


-- ---------------------------------------------------------------------------
-- C37 — the ADV-2 `guarded` arm must cover EVERY table in the closure, and
--       every one must resolve
--
-- Same argument as C34 and C35, one arm over. The `guarded` rows are generated
-- from cc_policyset_table, so they cannot go short independently — but "cannot"
-- is the word every short list in this directory has been described with. This
-- control states it as a comparison instead: the tables carrying `guarded` rows
-- must be exactly the tables the DATABASE routes through owns_account, plus
-- public.accounts, and every property must be present on every one of them. A
-- property dropped from the cross join, or a table dropped from the list, makes
-- the counts disagree and the run REFUSES rather than silently watching one
-- table or one attribute fewer.
-- ---------------------------------------------------------------------------
do $cc$
declare
  routed     text[];
  policyset  text[];
  guarded    text[];
  missing    text[];
  unresolved text[];
  props      text[];
  n_props    int;
  n_tables   int;
  n_rows     int;
  synth_all  text[] := array['cc_synth_g1','cc_synth_g2'];
begin
  select coalesce(array_agg(distinct n.nspname || '.' || c.relname), '{}'::text[])
    into routed
    from pg_policy pol
    join pg_class c     on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') like '%owns_account%';

  select coalesce(array_agg(distinct dep_id), '{}'::text[]) into policyset
    from cc_dep_expect where key = 'owns_account' and dep_kind = 'policyset';
  select coalesce(array_agg(distinct dep_id), '{}'::text[]) into guarded
    from cc_dep_expect where key = 'owns_account' and dep_kind = 'guarded';

  -- both directions: routed-or-policyset must be covered, and the guarded arm
  -- must not have invented a table the other two arms do not know about
  missing := pg_temp.cc_minus(routed, guarded)
             || pg_temp.cc_minus(policyset, guarded)
             || pg_temp.cc_minus(guarded, policyset);

  select coalesce(array_agg(t order by t collate "C"), '{}'::text[])
    into unresolved
    from unnest(guarded) t where to_regclass(t) is null;

  -- `array_agg(distinct x order by y)` is rejected unless y is textually x, so
  -- the distinct rows are selected in a subquery and sorted explicitly, the
  -- same shape cc_body_fns uses.
  select coalesce(array_agg(p order by p collate "C"), '{}'::text[])
    into props
    from (select distinct prop as p from cc_dep_expect
           where key = 'owns_account' and dep_kind = 'guarded') s;

  n_props  := cardinality(props);
  n_tables := cardinality(guarded);
  select count(*) into n_rows from cc_dep_expect
   where key = 'owns_account' and dep_kind = 'guarded';

  insert into cc_control values ('C37_guarded_arm_covers_every_closure_table',
    pg_temp.cc_minus(synth_all, array['cc_synth_g1']) = array['cc_synth_g2']::text[]
      and cardinality(routed) > 0
      and cardinality(guarded) > 0
      and cardinality(missing) = 0
      and cardinality(unresolved) = 0
      -- the six properties are named here, not counted, so deleting one from
      -- the cross join names itself instead of just lowering a number
      and props = array['dependent_rels','forcerowsecurity','inheritance',
                        'owner','relkind','rowsecurity']::text[]
      and n_rows = n_props * n_tables,
    format('policies route through owns_account on [%s]; the policyset arm pins '
           '[%s]; the guarded arm pins [%s] with properties [%s]; uncovered or '
           'invented: %s; unresolvable: %s; %s row(s) = %s propert(ies) x %s '
           'table(s)',
           array_to_string(routed, ','), array_to_string(policyset, ','),
           array_to_string(guarded, ','), array_to_string(props, ','),
           coalesce(nullif(array_to_string(missing, ','), ''), '<none>'),
           coalesce(nullif(array_to_string(unresolved, ','), ''), '<none>'),
           n_rows, n_props, n_tables));
end
$cc$;

-- ---------------------------------------------------------------------------
-- C38 — the ADV-2 observers must SEE each shape, on a planted instance
--
-- Every property this arm compares currently observes the SAME value on every
-- guarded table — owner postgres, relkind r, RLS on, FORCE off, no inheritance,
-- and (except for public.accounts on `latest`) no dependent view. A set of
-- observers that returned those constants without reading anything would pass
-- every row. Three of the six would also pass if they returned the empty
-- string, which is the failure-value/pass-value collision this programme keeps
-- finding.
--
-- So TWO subjects are BUILT in a throwaway schema that is dropped in the same
-- block: one carrying every shape at once, one carrying none of them. Each
-- observer must see its shape on the first and must NOT see it on the second.
--
-- R5-CTLPREC(1). ALL SIX properties are now read through `pg_temp.
-- cc_guarded_prop`, the single function `cc_dep_obs` calls, so the sentence
-- "the observers exercised here are the SAME functions cc_dep_obs calls" is
-- true of the whole arm rather than of two of its six properties. It was not
-- before: `cc_inheritance` and `cc_dependent_rels` were shared, while relkind,
-- owner, rowsecurity and forcerowsecurity were re-derived by an inline
-- `select … from pg_class` on both sides — a control that could keep passing
-- while the observer it proves was edited underneath it.
--
-- THE NEGATIVE HALF IS PLANTED, NOT BORROWED. It read `public.positions` in the
-- first draft, and the mutant that sets FORCE ROW LEVEL SECURITY on that table
-- then turned this control RED — a schema mutation making a CONTROL fail, which
-- reports "the classifier cannot be trusted this run" for what is really a
-- finding the `guarded` rows had already made correctly. A control's negative
-- case must not be a property of the subject under test.
-- ---------------------------------------------------------------------------
do $cc$
declare
  subj      oid;
  clean     oid;
  o_owner   text; o_kind text; o_rls text; o_force text;
  o_inh     text; o_dep  text;
  r_force   text; r_inh  text;
  k_view    text; k_matview text;
  seen_view boolean;
  seen_kid  boolean;
begin
  execute 'create schema cc_ctl2';
  execute 'create table cc_ctl2.subject (account_id uuid, equity numeric(18,2))';
  execute 'alter table cc_ctl2.subject enable row level security';
  execute 'alter table cc_ctl2.subject force row level security';
  execute 'create table cc_ctl2.kid () inherits (cc_ctl2.subject)';
  execute 'create view cc_ctl2.spy as select * from cc_ctl2.subject';
  -- a MATERIALISED view is the second relkind this arm has to see, and it is
  -- the more dangerous one: a matview holds a copy of the rows, applies no
  -- policy of its own, and does not consult the base table's policies when it
  -- is read. MEASURED: the pg_depend query finds one, and finds a view in
  -- ANOTHER schema, which is why this control plants both outside `public`.
  execute 'create materialized view cc_ctl2.spy_m as select * from cc_ctl2.subject';
  execute 'alter table cc_ctl2.subject owner to postgres';
  -- the negative half: same shape of relation, none of the exposures
  execute 'create table cc_ctl2.clean (account_id uuid, equity numeric(18,2))';
  execute 'alter table cc_ctl2.clean enable row level security';

  subj  := to_regclass('cc_ctl2.subject');
  clean := to_regclass('cc_ctl2.clean');

  -- Every read below goes through cc_guarded_prop, the observer cc_dep_obs
  -- uses, with the property name spelled exactly as cc_dep_expect spells it.
  o_rls   := pg_temp.cc_guarded_prop(subj, 'rowsecurity');
  o_force := pg_temp.cc_guarded_prop(subj, 'forcerowsecurity');
  o_kind  := pg_temp.cc_guarded_prop(subj, 'relkind');
  o_owner := pg_temp.cc_guarded_prop(subj, 'owner');
  o_inh   := pg_temp.cc_guarded_prop(subj, 'inheritance');
  o_dep   := pg_temp.cc_guarded_prop(subj, 'dependent_rels');

  r_force := pg_temp.cc_guarded_prop(clean, 'forcerowsecurity');
  r_inh   := pg_temp.cc_guarded_prop(clean, 'inheritance');

  -- R5-CTLPREC(2): the relkind observer, read on the two relations that are
  -- NOT ordinary tables, so 'r' is shown to be an observation and not a
  -- constant.
  k_view    := pg_temp.cc_guarded_prop(to_regclass('cc_ctl2.spy'),   'relkind');
  k_matview := pg_temp.cc_guarded_prop(to_regclass('cc_ctl2.spy_m'), 'relkind');

  seen_kid  := o_inh = 'child:cc_ctl2.kid';
  -- BOTH relkinds, and the cardinality, so a scanner that found one and
  -- stopped is not confused with one that found the set
  seen_view := o_dep like 'n=2;%'
               and o_dep like '%cc_ctl2.spy/v/owner:%'
               and o_dep like '%cc_ctl2.spy_m/m/owner:%'
               and o_dep like '%/def:%'
               -- the descriptor must carry the GRANT list in plaintext, since
               -- that is the half a reviewer has to read
               and o_dep like '%/grants:%';

  insert into cc_control values ('C38_guarded_observers_discriminate',
        o_owner = 'postgres' and o_kind = 'r' and o_rls = 't'
    and o_force = 't'   -- the planted FORCE is seen …
    and r_force = 'f'   -- … and the planted CLEAN table's absence of it is not
                        --   confused with it. Both halves are this control's
                        --   own objects; see the note above.
    and seen_kid
    and r_inh = '<none>'
    and seen_view
    and pg_temp.cc_guarded_prop(clean, 'dependent_rels') = 'n=0;<none>'
    -- R5-CTLPREC(2). relkind was the one guarded property whose observer was
    -- only ever shown returning the value it is pinned to. `o_kind = 'r'` is
    -- satisfied by an observer hard-wired to the literal 'r', which is the
    -- failure-value/pass-value collision this programme keeps finding. The two
    -- relations this control already plants are read through the SAME observer
    -- and must come back as the other two relkinds this arm can encounter.
    and k_view = 'v' and k_matview = 'm'
    -- and a property name the arm does not know must announce itself rather
    -- than return something a pin could coincide with
    and pg_temp.cc_guarded_prop(subj, 'zz_not_a_property') = '<unknown property>'
    -- the formatter must discriminate a redefinition and a re-grant, or the
    -- descriptor would be a name list wearing a digest
    and pg_temp.cc_depview_desc('v','v','o','-','g','select 1')
          <> pg_temp.cc_depview_desc('v','v','o','-','g','select 2')
    and pg_temp.cc_depview_desc('v','v','o','-','g','select 1')
          <> pg_temp.cc_depview_desc('v','v','o','-','g2','select 1')
    and pg_temp.cc_depview_desc('v','v','o','-','g','select 1')
          <> pg_temp.cc_depview_desc('v','v','o2','-','g','select 1')
    -- and whitespace in a definition must NOT be a finding
    and pg_temp.cc_depview_desc('v','v','o','-','g',E'select\n   1')
          = pg_temp.cc_depview_desc('v','v','o','-','g','select 1')
    and pg_temp.cc_depset_desc('{}'::text[]) = 'n=0;<none>',
    format('planted subject: owner=%s kind=%s rls=%s force=%s inheritance=%L '
           'dependent=%L; planted clean table: force=%s inheritance=%L '
           'dependent=%L; the same observer reads the planted view as kind=%s '
           'and the planted materialised view as kind=%s, and an unknown '
           'property as %L',
           o_owner, o_kind, o_rls, o_force, o_inh, o_dep, r_force, r_inh,
           pg_temp.cc_guarded_prop(clean, 'dependent_rels'),
           k_view, k_matview,
           pg_temp.cc_guarded_prop(subj, 'zz_not_a_property')));

  execute 'drop schema cc_ctl2 cascade';

  -- and the teardown must have worked, or the next control would be reading a
  -- schema this one left behind
  insert into cc_control values ('C38b_guarded_control_left_nothing_behind',
    to_regnamespace('cc_ctl2') is null,
    format('cc_ctl2 after teardown: %s',
           coalesce(to_regnamespace('cc_ctl2')::text, '<dropped>')));
end
$cc$;

-- ---------------------------------------------------------------------------
-- 2e. THE WHOLE-SCHEMA COUNTER-SCAN
--
-- Everything above this line is keyed on a NAME. That is the right shape for
-- "is the routine 0022 tombstoned still tombstoned", and it is structurally
-- incapable of seeing a routine nobody has thought of. The demonstration was
-- exact: a fresh `public.vault_create_secret_v2(text,text)`, SECURITY DEFINER,
-- granted to `anon`, re-exposing `vault.create_secret` — anon created a Vault
-- secret through it — and the classifier returned PASS, because the catalogue
-- has no row for a name that did not exist when the catalogue was written and
-- the sibling scan only looks for other routines of the SAME name.
--
-- No signature-keyed catalogue can enumerate names that do not exist yet. That
-- part is INHERENT and is stated as such in the report (`scope_limits`) and in
-- CATALOGUE-CLASSIFIER.md. What IS possible is to stop reasoning about names at
-- all and pin two whole-schema SETS, compared in BOTH directions:
--
--   S1  the client-executable surface — every routine in `public` that `anon`,
--       `authenticated` or `service_role` can execute by ANY path (direct
--       grant, PUBLIC, default privilege, inherited membership), with the exact
--       role list AND the two properties that decide WHOSE privileges the call
--       runs with — `prosecdef` and the routine's OWNER — must equal the pinned
--       set for this generation;
--
--       R5-A1. `prosecdef` and `owner` are in the descriptor because a pin that
--       names objects without naming what they DO caught a new signature and
--       missed an existing one repurposed. MEASURED, on a pristine `latest`
--       clone, before this was added: `create or replace function
--       public.jwt_role() ... security definer` — same signature, same grant
--       list, same owner, body replaced by a read of `public.equity_snapshots`
--       — returned rc 0, PASS, 41/41 controls, `schema_scan.findings []`, all
--       50 authz_closure rows ok and `client_surface.added []` with the pinned
--       38 entries byte-identical, while in the same clone `authenticated`
--       (subject 4444…) got `owns_account(2222…)=false`, 0 rows from a direct
--       `select from public.equity_snapshots`, and all 21 of the victim's rows
--       out of the repurposed routine. With `secdef=` in the descriptor that
--       same mutation is `schema:client_executable_surface_drift`;
--
--       `41` IS THE CONTROL COUNT OF THIS FILE AS IT THEN STOOD, kept as the
--       historical figure rather than quietly restated — the same round that
--       added `secdef=` also added `C39`. RE-MEASURED against today's file by
--       reverting exactly FIVE things and nothing else (the descriptor below,
--       the 45 pinned entries' format, the two halves R5 added to C30,
--       C32's two shape clauses, and cc_surf_sig's ` secdef=` delimiter),
--       which is the pre-R5 classifier by construction.
--
--       FIVE, not four. cc_surf_sig lives OUTSIDE C30, so a four-item revert
--       leaves it splitting on a delimiter the reverted descriptor no longer
--       writes. Both variants were built and run: the four-item revert comes
--       back rc 3 CONTROL_FAILED on exactly one control,
--       C30_client_surface_scanner_works ("38 entries before; planted=NULL;
--       38 entries after the drop, identical to before=t" — the planted row
--       is unparseable, so the scanner's own non-vacuity check fires). The
--       five-item revert is the rc 0 PASS below, 42/42: rc 0, PASS, 42/42 controls, findings [], 50/50 closure
--       rows, 38 pinned entries byte-identical with the repurposed routine's
--       entry still reading `public.jwt_role() => anon+authenticated+
--       service_role`, and 21 of the victim's rows on the wire in that same
--       clone. The shipped file, same mutation, same clone: FAIL,
--       `schema:client_executable_surface_drift`, 42/42 controls still ok. Both
--       figures are measurements of one break against two states of this file;
--       a reader reproducing it today should expect 42, not 41.
--       SIZE OF THE RESIDUAL, measured on pristine clones: the routines a
--       client (`anon`/`authenticated`) can EXECUTE in `public` that are
--       SECURITY INVOKER *and* callable from SQL at all number exactly TWO on
--       `latest` — `is_service_role()` and `jwt_role()` — and ZERO on `0008`,
--       whose only client-reachable invoker routine returns `trigger` and so
--       cannot be called directly. That is the whole surface an invoker body
--       rewrite has to work with, and such a rewrite reads 0 rows past the
--       caller's RLS (measured on this fixture);
--   S2  the SECURITY DEFINER routines in `public` that can reach `vault.*` —
--       by a qualified reference in the (comment-stripped) body or by carrying
--       `vault` in their own search_path — must equal a pinned allowlist.
--
-- WHY A HAND-WRITTEN PIN IS ADMISSIBLE HERE AND WAS NOT ADMISSIBLE FOR THE
-- TOMBSTONE CATALOGUE. The tombstone catalogue is a list of things to LOOK at:
-- an omission is silent, because nothing looks at what is not listed. These two
-- pins are SET EQUALITIES over a complete enumeration the database itself
-- produces: an omission from the pin makes the run RED, not green. The
-- direction of the failure is inverted, which is the whole reason this shape
-- was chosen over "a longer list of names to watch".
--
-- These findings are NOT per-object reason codes. They belong to the run, not
-- to any catalogue key, and forcing them into an object's `reasons` array would
-- attribute a whole-schema fact to whichever routine happened to be listed
-- first. They live in `cc_schema_finding`, they are published in the JSON
-- (`schema_scan`), they are echoed as CATALOGUE_CLASSIFY_SCHEMA_FINDING lines,
-- and the RESULT gate reads them: a non-empty `cc_schema_finding` is FAIL.
-- C33 is the positive control on that last sentence — it plants a synthetic
-- finding, re-evaluates the gate function the report actually calls, and
-- requires the answer to stop being PASS. That control exists because the
-- scanners, their own controls and this insert were all written and merged
-- while NOTHING SELECTED FROM `cc_schema_finding`: a fully built detector whose
-- output reached no verdict, which is the exact shape of defect this directory
-- keeps finding one level up.
--
-- RESIDUAL LIMIT — READ THIS BEFORE QUOTING A PASS.
-- S1/S2 are set equalities against a HAND-WRITTEN pin, so they detect a new
-- privileged routine only in the dimensions the pin describes: for S1, "which
-- of {anon, authenticated, service_role} can EXECUTE it, whether it is SECURITY
-- DEFINER, and who owns it"; for S2, "it is SECURITY DEFINER and can reach
-- vault.*". They are complete over `public` in those dimensions and nowhere
-- else. In particular S1 now covers BOTH halves of the shape it is named for:
-- a NEW client-executable signature (mutant 70) and an EXISTING one REPURPOSED
-- into SECURITY DEFINER or reowned (mutants 73 and 74). What it still does not
-- cover is a repurpose that moves NEITHER the signature, NOR the grant list,
-- NOR prosecdef, NOR the owner — a SECURITY INVOKER body rewrite. That one is
-- bounded rather than open: a SECURITY INVOKER routine runs with the CALLER's
-- row-security context, so it cannot read past the caller's own RLS (measured
-- on this fixture: 0 rows), and the only client-executable SECURITY DEFINER
-- routine left to chain through is `public.owns_account`, whose body, owner,
-- language, volatility, proconfig and whole dependency closure are pinned by
-- the catalogue and by C27/C29/C34-C38.
-- A new privileged routine is still invisible to this classifier when it is
--   * in a schema other than `public` that a client role can reach;
--   * executable only by a role outside {anon, authenticated, service_role}
--     that is nevertheless reachable from a client (a chained SET ROLE, a
--     SECURITY DEFINER caller in another schema);
--   * SECURITY DEFINER and privileged for a reason other than vault (it writes
--     `accounts`, it forges an audit row, it reads another owner's positions)
--     — S1 sees it the moment it becomes SECURITY DEFINER or changes owner,
--     because both are in the descriptor; S2 still does not, because S2 asks
--     only about `vault.*`;
--   * not a routine at all — a view with `security_invoker = off`, a trigger,
--     an event trigger, a FDW, a default expression.
-- This gate therefore proves "the client-executable surface of `public` — by
-- signature, role list, security mode and owner — and the vault-reaching
-- SECURITY DEFINER set of `public` are exactly what was pinned".
-- It does not prove "no new privileged object exists". That second sentence is
-- not derivable from anything in this file, and `pass_does_not_claim` in the
-- JSON says so in machine-readable form so a downstream reader cannot round it
-- up. Widening the pin does not close this; only an authorization model the
-- database can enumerate would, and there is none here.
-- ---------------------------------------------------------------------------
create temporary table cc_schema_finding(
  code   text not null,
  detail text not null
);

-- The client roles the surface is measured against. Named here rather than
-- inline so the positive control below exercises the same list the real scan
-- uses.
create function pg_temp.cc_client_roles() returns text[]
language sql immutable as $fn$ select array['anon','authenticated','service_role'] $fn$;

-- S1. Every routine in `public` any client role can execute, by which roles,
-- AND with whose privileges. `has_function_privilege` is PostgreSQL's own
-- evaluation, so PUBLIC, default privileges and inherited membership are all in
-- it without this file re-implementing any of them.
--
-- R5-A1 — WHY `secdef` AND `owner` ARE IN THE DESCRIPTOR AND NOT JUST THE
-- SIGNATURE. A set equality over signatures answers "is the list of things a
-- client can call still the list we pinned". It does not answer "does calling
-- them still do what it did", and those are different questions: `create or
-- replace function` keeps the signature, keeps the ACL and keeps the owner
-- while moving `prosecdef` and the whole body. That is the shape that got a
-- clean PASS out of this file with 21 of another tenant's rows on the wire —
-- see the measurement in the section header above. `prosecdef` and the owner
-- are the two catalogue columns that decide WHOSE row-security context the
-- call runs in, so they are the two that belong beside the role list.
--
-- The BODY is deliberately NOT in this descriptor. Digesting 38 bodies here
-- would re-pin, badly and without a probe, what the per-object catalogue
-- already pins properly for the routines that matter, and would make every
-- unrelated migration a counter-scan finding. The residual — a SECURITY INVOKER
-- body rewrite — is bounded by the argument in the section header: an invoker
-- routine cannot read past its caller's RLS.
--
-- FORMAT: `<schema>.<name>(<identity args>) secdef=<t|f> owner=<role> => <roles>`.
-- The signature is the prefix and ends at the first ' secdef=', which is what
-- lets C30 assert that a repurpose moved the descriptor while leaving the
-- SIGNATURE identical — i.e. that the old signature-only pin could not have
-- seen it.
create function pg_temp.cc_client_surface() returns text[]
language sql stable as $fn$
  select coalesce(array_agg(e order by e collate "C"), '{}'::text[])
    from (
      select n.nspname || '.' || p.proname || '('
             || pg_get_function_identity_arguments(p.oid) || ')'
             || ' secdef=' || case when p.prosecdef then 't' else 'f' end
             || ' owner=' || pg_get_userbyid(p.proowner)::text
             || ' => '
             || (select string_agg(r.rolname::text, '+' order by r.rolname::text collate "C")
                   from pg_roles r
                  where r.rolname::text = any (pg_temp.cc_client_roles())
                    and has_function_privilege(r.oid, p.oid, 'EXECUTE')) as e
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and exists (select 1 from pg_roles r
                      where r.rolname::text = any (pg_temp.cc_client_roles())
                        and has_function_privilege(r.oid, p.oid, 'EXECUTE'))
    ) s
$fn$;

-- The signature half of a client-surface entry: everything before ' secdef='.
-- Defined ONCE and used by C30 on both sides of its comparison, so "the
-- signature did not move" is measured by the same splitter that the descriptor
-- format promises, rather than by a second inline copy of the delimiter.
create function pg_temp.cc_surf_sig(entry text) returns text
language sql immutable as $fn$ select split_part($1, ' secdef=', 1) $fn$;

-- The single entry in a surface snapshot whose signature is `sig`, or NULL.
create function pg_temp.cc_surf_entry(surf text[], sig text) returns text
language sql immutable as $fn$
  select (select e from unnest($1) e where pg_temp.cc_surf_sig(e) = $2)
$fn$;

-- Comments are blanked before any match. Three separate guards in this
-- programme have now fired on their own documentation; a `-- see vault.secrets`
-- in a body is a comment, not a reach.
create function pg_temp.cc_strip_sql_comments(text) returns text
language sql immutable as $fn$
  select regexp_replace(regexp_replace($1, '/\*.*?\*/', ' ', 'gs'), '--[^\n]*', ' ', 'g')
$fn$;

-- S2. SECURITY DEFINER routines in `public` that can reach `vault.*`. Two
-- reaches, because either is sufficient: a schema-qualified reference in the
-- body, or `vault` on the routine's own search_path (which makes
-- `create_secret(...)` resolve there unqualified).
create function pg_temp.cc_secdef_vault_reachers() returns text[]
language sql stable as $fn$
  select coalesce(array_agg(sig order by sig collate "C"), '{}'::text[])
    from (
      select n.nspname || '.' || p.proname || '('
             || pg_get_function_identity_arguments(p.oid) || ')' as sig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prosecdef
         and p.prokind = 'f'
         and (pg_temp.cc_strip_sql_comments(p.prosrc) ~* '\mvault\s*\.'
              or coalesce(array_to_string(p.proconfig, ','), '')
                   ~* '(^|[=,[:space:]])vault([,[:space:]]|$)')
    ) s
$fn$;

create temporary table cc_schema_pin(
  generation text not null,
  kind       text not null check (kind in ('client_surface','secdef_vault')),
  entry      text not null,
  primary key (generation, kind, entry)
);

insert into cc_schema_pin(generation, kind, entry)
select 'latest', 'client_surface', e from unnest(array[
  'public.account_history_row_limit() secdef=f owner=postgres => service_role',
  'public.account_history_snapshot(p_account uuid, p_owner uuid, p_from date) secdef=t owner=postgres => service_role',
  'public.account_verification_ttl() secdef=f owner=postgres => service_role',
  'public.accounts_guard_server_managed() secdef=f owner=postgres => service_role',
  'public.audit_detail_is_publishable(p_detail jsonb) secdef=f owner=postgres => service_role',
  'public.audit_detail_max_depth() secdef=f owner=postgres => service_role',
  'public.audit_detail_max_nodes() secdef=f owner=postgres => service_role',
  'public.audit_log_detail_guard() secdef=f owner=postgres => service_role',
  'public.audit_token_is_sensitive(p_text text) secdef=f owner=postgres => service_role',
  'public.begin_account_verification(p_account uuid, p_owner uuid) secdef=t owner=postgres => service_role',
  'public.begin_broker_refresh(p_account uuid, p_owner uuid) secdef=t owner=postgres => service_role',
  'public.begin_broker_refresh_with_credentials(p_account uuid, p_owner uuid) secdef=t owner=postgres => service_role',
  'public.broker_refresh_row_limit() secdef=f owner=postgres => service_role',
  'public.broker_refresh_token_ttl() secdef=f owner=postgres => service_role',
  'public.cancel_account_verification(p_token uuid, p_reason text) secdef=t owner=postgres => service_role',
  'public.create_account_operation(p_owner uuid, p_operation_id uuid, p_fingerprint text, p_nickname text, p_mode account_mode, p_color text, p_api_key text, p_api_secret text, p_account_number text) secdef=t owner=postgres => service_role',
  'public.delete_account_atomic(p_account uuid, p_owner uuid, p_purge_history boolean) secdef=t owner=postgres => service_role',
  'public.find_account_by_operation(p_owner uuid, p_operation_id uuid) secdef=t owner=postgres => service_role',
  'public.finish_account_verification(p_token uuid, p_status account_status, p_account_number text) secdef=t owner=postgres => service_role',
  'public.get_account_credentials(acct uuid) secdef=t owner=postgres => service_role',
  'public.handle_new_user() secdef=t owner=postgres => service_role',
  'public.is_service_role() secdef=f owner=postgres => anon+authenticated+service_role',
  'public.jwt_role() secdef=f owner=postgres => anon+authenticated+service_role',
  'public.lock_create_operation(p_operation_id uuid) secdef=f owner=postgres => service_role',
  'public.lock_credential_pair(p_a uuid, p_b uuid) secdef=f owner=postgres => service_role',
  'public.looks_like_broker_account_number(p_value text) secdef=f owner=postgres => service_role',
  'public.owns_account(acct uuid) secdef=t owner=postgres => authenticated+service_role',
  'public.publish_broker_refresh(p_token uuid, p_equity jsonb, p_equity_complete boolean, p_flows jsonb, p_flows_from date, p_flows_complete boolean, p_flows_scanned integer, p_flows_saw_empty_page boolean) secdef=t owner=postgres => service_role',
  'public.purge_unassigned_credential_pair(p_key uuid, p_secret uuid, p_owner uuid, p_reason text) secdef=t owner=postgres => service_role',
  'public.reconcile_cash_flow_mirror(p_account uuid, p_owner uuid, p_from date, p_rows jsonb) secdef=t owner=postgres => service_role',
  'public.replace_equity_snapshots(p_account uuid, p_owner uuid, p_rows jsonb) secdef=t owner=postgres => service_role',
  'public.resolve_create_operation(p_owner uuid, p_operation_id uuid, p_fingerprint text) secdef=t owner=postgres => service_role',
  'public.retract_cash_flow(p_account uuid, p_owner uuid, p_external_id text, p_reason text) secdef=t owner=postgres => service_role',
  'public.retract_equity_snapshot(p_account uuid, p_owner uuid, p_date date, p_reason text) secdef=t owner=postgres => service_role',
  'public.rotate_account_credentials(p_account uuid, p_owner uuid, p_api_key text, p_api_secret text, p_account_number text) secdef=t owner=postgres => service_role',
  'public.touch_updated_at() secdef=f owner=postgres => service_role',
  'public.try_date(p_text text) secdef=f owner=postgres => service_role',
  'public.update_account_metadata(p_account uuid, p_owner uuid, p_nickname text, p_color text, p_is_active boolean) secdef=t owner=postgres => service_role'
]) e
where pg_temp.cc_cfg('generation') = 'latest';

insert into cc_schema_pin(generation, kind, entry)
select 'latest', 'secdef_vault', e from unnest(array[
  'public.begin_account_verification(p_account uuid, p_owner uuid)',
  'public.begin_broker_refresh_with_credentials(p_account uuid, p_owner uuid)',
  'public.create_account_operation(p_owner uuid, p_operation_id uuid, p_fingerprint text, p_nickname text, p_mode account_mode, p_color text, p_api_key text, p_api_secret text, p_account_number text)',
  'public.delete_account_atomic(p_account uuid, p_owner uuid, p_purge_history boolean)',
  'public.get_account_credentials(acct uuid)',
  'public.purge_unassigned_credential_pair(p_key uuid, p_secret uuid, p_owner uuid, p_reason text)',
  'public.rotate_account_credentials(p_account uuid, p_owner uuid, p_api_key text, p_api_secret text, p_account_number text)'
]) e
where pg_temp.cc_cfg('generation') = 'latest';

insert into cc_schema_pin(generation, kind, entry)
select '0008', 'client_surface', e from unnest(array[
  'public.get_account_credentials(acct uuid) secdef=t owner=postgres => service_role',
  'public.handle_new_user() secdef=t owner=postgres => service_role',
  'public.owns_account(acct uuid) secdef=t owner=postgres => authenticated+service_role',
  'public.touch_updated_at() secdef=f owner=postgres => anon+authenticated+service_role',
  'public.vault_create_secret(p_secret text, p_name text) secdef=t owner=postgres => service_role',
  'public.vault_delete_secret(p_id uuid) secdef=t owner=postgres => service_role',
  'public.vault_update_secret(p_id uuid, p_secret text) secdef=t owner=postgres => service_role'
]) e
where pg_temp.cc_cfg('generation') = '0008';

insert into cc_schema_pin(generation, kind, entry)
select '0008', 'secdef_vault', e from unnest(array[
  'public.get_account_credentials(acct uuid)',
  'public.vault_create_secret(p_secret text, p_name text)',
  'public.vault_delete_secret(p_id uuid)',
  'public.vault_update_secret(p_id uuid, p_secret text)'
]) e
where pg_temp.cc_cfg('generation') = '0008';

-- C30/C31 — POSITIVE AND NEGATIVE CONTROL on both scanners, before either one
-- is allowed to make an absence claim. A routine is planted into `public`
-- itself — not into a throwaway schema, because `public` is the only place
-- either scan looks — observed, and dropped again. The negative half asserts
-- that after the drop the scans no longer name it, so "the pristine schema is
-- clean" is a statement from a scanner that has been shown to change its answer.
--
-- R5-A1 ADDED TWO MORE HALVES to C30, and they are the ones that matter now.
-- Seeing a NEW signature was never the gap; the gap was an EXISTING signature
-- repurposed. So the SAME planted routine is (a) `create or replace`d into
-- SECURITY DEFINER and (b) reowned, each with the signature, the grant list and
-- the other property held still, and the control requires the descriptor to
-- move both times WHILE the signature stays byte-identical. That last clause is
-- the measurement behind the claim "the signature-only pin could not have seen
-- this": it is asserted here, in the same block, rather than asserted in a
-- comment somewhere else.
do $cc$
declare
  surf_before  text[] := pg_temp.cc_client_surface();
  reach_before text[] := pg_temp.cc_secdef_vault_reachers();
  surf_planted text[];
  reach_planted text[];
  surf_secdef  text[];
  surf_reowned text[];
  surf_after   text[];
  reach_after  text[];
  planted_sig  text := 'public.__cc_counterscan_probe(p uuid)';
  e_invoker    text;
  e_secdef     text;
  e_reowned    text;
  owner_now    text;
  owner_new    text;
  planted_vault text := 'public.__cc_counterscan_vault(p text)';
begin
  execute 'create function public.__cc_counterscan_probe(p uuid) returns void '
          'language plpgsql as $b$ begin end; $b$';
  execute 'revoke all on function public.__cc_counterscan_probe(uuid) from public, '
          'anon, authenticated, service_role';
  execute 'grant execute on function public.__cc_counterscan_probe(uuid) to anon';

  -- A SECURITY DEFINER routine whose only mention of vault is in a COMMENT must
  -- NOT be reported (that is the false positive this programme keeps hitting),
  -- while one with a real qualified reference must be.
  execute 'create function public.__cc_counterscan_comment(p text) returns void '
          'language plpgsql security definer set search_path = pg_catalog, public '
          'as $b$ begin -- vault.create_secret is deliberately only named here' || chr(10) ||
          ' null; end; $b$';
  execute 'create function public.__cc_counterscan_vault(p text) returns void '
          'language plpgsql security definer set search_path = pg_catalog, public '
          'as $b$ begin perform 1 from vault.secrets limit 1; end; $b$';

  surf_planted  := pg_temp.cc_client_surface();
  reach_planted := pg_temp.cc_secdef_vault_reachers();

  -- R5-A1, THE REPURPOSE HALF. `create or replace function` keeps the
  -- signature, keeps the ACL and keeps the owner; only `prosecdef` moves. This
  -- is exactly the mutation that produced a clean PASS before the descriptor
  -- carried `secdef=`, so the control that proves the descriptor sees it has to
  -- BE that mutation, not a description of it.
  execute 'create or replace function public.__cc_counterscan_probe(p uuid) returns void '
          'language plpgsql security definer as $b$ begin end; $b$';
  surf_secdef := pg_temp.cc_client_surface();

  -- …and the owner half. `alter function ... owner to` also keeps the signature
  -- and the grant list. The target owner is DERIVED as "whichever of these two
  -- the routine is not already owned by", so this control cannot pass by
  -- reowning a routine to the owner it already had, and cannot fail merely
  -- because the classifier was invoked as a different role. Neither candidate
  -- is a client role, so the `=> anon` suffix cannot move with the owner.
  select pg_get_userbyid(p.proowner)::text into owner_now
    from pg_proc p where p.oid = to_regprocedure('public.__cc_counterscan_probe(uuid)');
  owner_new := case when owner_now = 'postgres' then 'supabase_admin' else 'postgres' end;
  execute format('alter function public.__cc_counterscan_probe(uuid) owner to %I', owner_new);
  surf_reowned := pg_temp.cc_client_surface();

  e_invoker := pg_temp.cc_surf_entry(surf_planted,  planted_sig);
  e_secdef  := pg_temp.cc_surf_entry(surf_secdef,   planted_sig);
  e_reowned := pg_temp.cc_surf_entry(surf_reowned,  planted_sig);

  execute 'drop function public.__cc_counterscan_probe(uuid)';
  execute 'drop function public.__cc_counterscan_comment(text)';
  execute 'drop function public.__cc_counterscan_vault(text)';

  surf_after  := pg_temp.cc_client_surface();
  reach_after := pg_temp.cc_secdef_vault_reachers();

  insert into cc_control values ('C30_client_surface_scanner_works',
    cardinality(surf_before) > 0
      -- (i) the scanner sees a NEW client-executable signature, and forgets it
      and pg_temp.cc_surf_entry(surf_before, planted_sig) is null
      and e_invoker is not null
      and e_invoker like '% secdef=f %'
      and surf_after = surf_before
      -- (ii) R5-A1: the same SIGNATURE repurposed into SECURITY DEFINER moves
      --      the descriptor …
      and e_secdef is not null
      and e_secdef like '% secdef=t %'
      and e_secdef <> e_invoker
      -- … while the SIGNATURE itself does not. This is the half that states,
      -- as a measurement rather than as prose, that the signature-only pin this
      -- descriptor replaced could not have seen the repurpose.
      and pg_temp.cc_surf_sig(e_secdef) = pg_temp.cc_surf_sig(e_invoker)
      and pg_temp.cc_surf_sig(e_secdef) = planted_sig
      -- (iii) and the OWNER, on its own, with prosecdef held still
      and e_reowned is not null
      and owner_now is not null and owner_new <> owner_now
      and e_secdef  like '% owner=' || owner_now || ' %'
      and e_reowned like '% owner=' || owner_new || ' %'
      and e_reowned <> e_secdef
      and pg_temp.cc_surf_sig(e_reowned) = planted_sig
      -- (iv) the grant list survived both repurposes, so neither entry differs
      --      for the trivial reason that the routine stopped being reachable
      and e_invoker like '%=> anon' and e_secdef like '%=> anon'
      and e_reowned like '%=> anon'
      -- (v) the splitter is not vacuous: it must NOT collapse two different
      --      descriptors of two different signatures onto one another
      and pg_temp.cc_surf_sig('public.a() secdef=f owner=o => anon')
            <> pg_temp.cc_surf_sig('public.b() secdef=f owner=o => anon'),
    format('%s entries before; planted invoker=%L; repurposed to SECURITY '
           'DEFINER=%L; reowned %s->%s=%L; signature identical across all '
           'three=%s; %s entries after the drop, identical to before=%s',
           cardinality(surf_before), e_invoker, e_secdef,
           owner_now, owner_new, e_reowned,
           (pg_temp.cc_surf_sig(e_invoker) = pg_temp.cc_surf_sig(e_secdef)
            and pg_temp.cc_surf_sig(e_secdef) = pg_temp.cc_surf_sig(e_reowned)),
           cardinality(surf_after), surf_after = surf_before));

  insert into cc_control values ('C31_vault_reacher_scanner_works',
    cardinality(reach_before) > 0
      and not (planted_vault = any (reach_before))
      and (planted_vault = any (reach_planted))
      -- the comment-only routine must NOT be reported
      and not ('public.__cc_counterscan_comment(p text)' = any (reach_planted))
      and reach_after = reach_before,
    format('%s reacher(s) before; planted reacher seen=%s; comment-only routine '
           'reported=%s; %s after the drop, identical to before=%s',
           cardinality(reach_before), (planted_vault = any (reach_planted)),
           ('public.__cc_counterscan_comment(p text)' = any (reach_planted)),
           cardinality(reach_after), reach_after = reach_before));

  -- C32 — the pin itself must be non-vacuous. An empty pin would make both set
  -- equalities trivially satisfiable by an empty schema, and a pin that does
  -- not even contain the one routine this whole directory is about is not
  -- describing this database.
  --
  -- R5-A1 added the last two clauses. A pin re-recorded in the OLD
  -- signature-only format would still satisfy the set equality if the observer
  -- were reverted to match it, and the run would go green with the defect back.
  -- So the pin's own SHAPE is asserted: every client-surface entry must carry a
  -- security mode and an owner, and at least one must be SECURITY DEFINER — a
  -- generation in which nothing is SECURITY DEFINER would make `secdef=` a
  -- constant and the dimension vacuous.
  insert into cc_control values ('C32_schema_pin_non_vacuous',
    (select count(*) from cc_schema_pin
      where generation = pg_temp.cc_cfg('generation') and kind = 'client_surface') >= 7
    and (select count(*) from cc_schema_pin
          where generation = pg_temp.cc_cfg('generation') and kind = 'secdef_vault') >= 4
    and exists (select 1 from cc_schema_pin
                 where generation = pg_temp.cc_cfg('generation')
                   and kind = 'client_surface'
                   and entry like 'public.owns_account(%')
    and not exists (select 1 from cc_schema_pin
                     where generation = pg_temp.cc_cfg('generation')
                       and kind = 'client_surface'
                       and not (entry like '% secdef=_ owner=% => %'))
    and exists (select 1 from cc_schema_pin
                 where generation = pg_temp.cc_cfg('generation')
                   and kind = 'client_surface'
                   and entry like '% secdef=t %'),
    format('client-surface pin: %s entr(ies), %s of them SECURITY DEFINER, %s '
           'malformed; secdef-vault pin: %s entr(ies)',
           (select count(*) from cc_schema_pin
             where generation = pg_temp.cc_cfg('generation') and kind = 'client_surface'),
           (select count(*) from cc_schema_pin
             where generation = pg_temp.cc_cfg('generation') and kind = 'client_surface'
               and entry like '% secdef=t %'),
           (select count(*) from cc_schema_pin
             where generation = pg_temp.cc_cfg('generation') and kind = 'client_surface'
               and not (entry like '% secdef=_ owner=% => %')),
           (select count(*) from cc_schema_pin
             where generation = pg_temp.cc_cfg('generation') and kind = 'secdef_vault')));
end
$cc$;

-- The scan itself, recorded as run-level findings.
create temporary table cc_schema_scan as
select 'client_surface'::text as kind,
       pg_temp.cc_client_surface()      as observed,
       (select coalesce(array_agg(entry order by entry collate "C"), '{}'::text[])
          from cc_schema_pin
         where generation = pg_temp.cc_cfg('generation') and kind = 'client_surface') as pinned
union all
select 'secdef_vault',
       pg_temp.cc_secdef_vault_reachers(),
       (select coalesce(array_agg(entry order by entry collate "C"), '{}'::text[])
          from cc_schema_pin
         where generation = pg_temp.cc_cfg('generation') and kind = 'secdef_vault');

alter table cc_schema_scan add column added text[];
alter table cc_schema_scan add column removed text[];
update cc_schema_scan
   set added   = pg_temp.cc_minus(observed, pinned),
       removed = pg_temp.cc_minus(pinned, observed);

insert into cc_schema_finding(code, detail)
select case s.kind when 'client_surface' then 'schema:client_executable_surface_drift'
                   else 'schema:secdef_vault_reacher_unlisted' end,
       format('%s: %s entr(ies) not in the pinned set [%s]; %s pinned entr(ies) '
              'not observed [%s]',
              s.kind,
              cardinality(s.added),   array_to_string(s.added, ' | '),
              cardinality(s.removed), array_to_string(s.removed, ' | '))
  from cc_schema_scan s
 where cardinality(s.added) > 0 or cardinality(s.removed) > 0;

-- ---------------------------------------------------------------------------
-- R5-DOC1 — THE SCOPE OF THE CLOSURE, DERIVED RATHER THAN COUNTED BY HAND
--
-- `pass_does_not_claim` bullet 3 has to say which client-readable, policy-
-- bearing tables of `public` are OUTSIDE this closure, because a permissive
-- policy on one of them is not pinned anywhere. That list was typed in three
-- places and disagreed with itself: the JSON bullet and one paragraph of
-- CATALOGUE-CLASSIFIER.md said SEVEN tables, and a table in the same document
-- that called itself "measured" concluded "two tables, one policy each … a
-- two-row scope". Both cannot be right, and the wrong one understated the gap
-- by five tables.
--
-- So the set is computed HERE, once, from the catalogue, published in the
-- report, and interpolated into the bullet. `tests/catalogue-classify.mutants.sh`
-- then requires CATALOGUE-CLASSIFIER.md's table to name exactly what the
-- pristine report publishes, so the document and the machine-readable output
-- cannot drift apart again.
--
-- MEASURED for `authenticated`, which is the client role that carries a JWT
-- subject; `anon` is included in the descriptor so a table readable by an
-- unauthenticated client would be visible here too rather than silently
-- excluded by the choice of role.
create function pg_temp.cc_outside_closure_readable() returns text[]
language sql stable as $fn$
  select coalesce(array_agg(e order by e collate "C"), '{}'::text[])
    from (
      select n.nspname || '.' || c.relname
             || '/rls=' || case when c.relrowsecurity then 't' else 'f' end
             || '/policies=' || (select count(*) from pg_policy p where p.polrelid = c.oid)::text
             || '/select:' || (select string_agg(r.rolname::text, '+' order by r.rolname::text collate "C")
                                 from pg_roles r
                                where r.rolname::text = any (pg_temp.cc_client_roles())
                                  and has_table_privilege(r.oid, c.oid, 'SELECT')) as e
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind in ('r','p')
         and exists (select 1 from pg_policy p where p.polrelid = c.oid)
         and exists (select 1 from pg_roles r
                      where r.rolname::text in ('anon','authenticated')
                        and has_table_privilege(r.oid, c.oid, 'SELECT'))
         and not exists (select 1 from cc_policyset_table pt
                          where pt.generation = pg_temp.cc_cfg('generation')
                            and pt.tbl = n.nspname || '.' || c.relname)
    ) s
$fn$;

do $cc$
declare
  outside text[] := pg_temp.cc_outside_closure_readable();
  inside  text[];
  overlap text[];
begin
  select coalesce(array_agg(tbl order by tbl collate "C"), '{}'::text[]) into inside
    from cc_policyset_table where generation = pg_temp.cc_cfg('generation');

  -- the two sets must be disjoint by NAME, computed independently of the
  -- `not exists` above, or "outside the closure" would be a label rather than
  -- a measurement
  select coalesce(array_agg(t order by t collate "C"), '{}'::text[]) into overlap
    from (select split_part(o, '/', 1) as t from unnest(outside) o) s
   where s.t = any (inside);

  insert into cc_control values ('C39_outside_closure_scope_derived',
    -- non-vacuity: the closure itself must be non-empty, and the derivation
    -- must be able to return something. An empty `outside` is a legitimate
    -- answer for a generation, so it is reported rather than refused; what is
    -- refused is a derivation that overlaps the closure, which would mean the
    -- subtraction did not happen.
    cardinality(inside) > 0
      and cardinality(overlap) = 0
      -- every descriptor must carry all three fields, or the document check
      -- downstream would be comparing against a half-built string
      and not exists (select 1 from unnest(outside) o
                       where o not like '%/rls=%/policies=%/select:%'),
    format('closure pins [%s]; client-readable policy-bearing tables OUTSIDE it: '
           '%s -> [%s]; overlap with the closure: %s',
           array_to_string(inside, ','), cardinality(outside),
           array_to_string(outside, ' | '),
           coalesce(nullif(array_to_string(overlap, ','), ''), '<none>')));
end
$cc$;

-- C19b — the schema half of C19. A schema finding code that is not in the
-- registry is a check the suite's coverage assertion cannot require, which is
-- how a check quietly stops being falsifiable.
do $cc$
declare
  unreg text;
begin
  select string_agg(distinct f.code, ',' order by f.code) into unreg
    from cc_schema_finding f
   where not exists (select 1 from cc_reason_registry g where g.code = f.code);
  insert into cc_control values ('C19b_schema_findings_registered',
    unreg is null,
    coalesce('unregistered schema finding codes: ' || unreg,
             format('%s schema finding(s), all registered',
                    (select count(*) from cc_schema_finding))));
end
$cc$;

-- ---------------------------------------------------------------------------
-- 3. observation — one row per expected signature, read from the catalogue
-- ---------------------------------------------------------------------------
create temporary table cc_obs as
with r as (
  select e.key, e.nspname, e.proname, e.sig, to_regprocedure(e.sig) as reg
    from cc_expect e
)
select
  r.key, r.nspname, r.proname, r.sig,
  (r.reg is not null)                                   as resolved,
  p.oid                                                 as prooid,
  p.prokind::text                                       as prokind,
  pg_get_userbyid(p.proowner)::text                     as owner,
  p.proowner                                            as proowner,
  l.lanname::text                                       as lang,
  p.prosecdef                                           as secdef,
  p.provolatile::text                                   as volatility,
  pg_get_function_result(p.oid)                         as rettype,
  pg_get_function_arguments(p.oid)                      as args,
  p.proconfig::text                                     as proconfig_raw,
  (select split_part(x, '=', 2)
     from unnest(p.proconfig) x where x like 'search_path=%')     as searchpath_raw,
  (select count(*) filter (where x not like 'search_path=%')
     from unnest(coalesce(p.proconfig, '{}'::text[])) x)          as other_proconfig,
  pg_temp.cc_norm(p.prosrc)                             as body_norm,
  p.proacl::text                                        as proacl_raw,
  (p.oid is not null and p.proacl is null)              as proacl_is_null,
  (select coalesce(array_agg(g order by g collate "C"), '{}'::text[]) from (
      select distinct
             (case when a.grantee = 0 then 'PUBLIC'
                   else pg_get_userbyid(a.grantee) end)::text as g
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner) s)
                                                        as grants_explicit,
  -- the enumerated application roles, kept as a second, differently derived
  -- assertion beside the dynamic scan below
  (select coalesce(array_agg(rr.rolname::text order by rr.rolname::text collate "C"), '{}'::text[])
     from pg_roles rr
    where rr.rolname in ('anon','authenticated','service_role','authenticator',
                         'dashboard_user','supabase_read_only_user','pgbouncer')
      and has_function_privilege(rr.rolname, p.oid, 'EXECUTE'))
                                                        as grants_effective,
  -- the DYNAMIC scan: every role in the cluster, no list anywhere
  coalesce(pg_temp.cc_execers(p.oid), '{}'::text[])     as exec_inherited,
  coalesce(pg_temp.cc_assumers(p.oid), '{}'::text[])    as exec_assumable,
  coalesce(pg_temp.cc_public_exec(p.oid), false)        as exec_public,
  pg_temp.cc_sibling_exec(r.nspname, r.proname, p.oid)  as sibling_exec,
  (select count(*) from pg_proc p2 join pg_namespace n2 on n2.oid = p2.pronamespace
    where n2.nspname = r.nspname and p2.proname = r.proname)      as overloads,
  (select count(*) from pg_proc p3 join pg_namespace n3 on n3.oid = p3.pronamespace
    where n3.nspname <> r.nspname and p3.proname = r.proname)     as shadows,
  (select coalesce(string_agg(n3.nspname::text, ',' order by n3.nspname::text collate "C"), '')
     from pg_proc p3 join pg_namespace n3 on n3.oid = p3.pronamespace
    where n3.nspname <> r.nspname and p3.proname = r.proname)     as shadow_schemas,
  (to_regproc(r.nspname || '.' || r.proname) is null)             as bare_unresolvable,
  exists (select 1 from pg_class c join pg_namespace n4 on n4.oid = c.relnamespace
           where n4.nspname = r.nspname and c.relname = r.proname) as name_taken_by_relation
from r
left join pg_proc     p on p.oid    = r.reg
left join pg_language l on l.oid    = p.prolang;

-- the environment fingerprints, computed once
create temporary table cc_env as
select pg_temp.cc_defacl_fingerprint() as defacl,
       pg_temp.cc_superusers()         as superusers,
       pg_temp.cc_role_graph()         as rolegraph,
       pg_temp.cc_bypassrls()          as bypassrls;

-- ---------------------------------------------------------------------------
-- 4. structural comparison against both profiles
--
-- Computed for EVERY object against BOTH profiles, without looking at the
-- expectation for this generation. That independence is what makes "LIVE where
-- a tombstone was expected" observable rather than invisible.
-- ---------------------------------------------------------------------------
create temporary table cc_struct as
select
  e.key,
  o.resolved,
  o.prokind,
  o.prooid,
  -- how the signature failed to resolve, if it did
  case
    when o.resolved                                    then null
    when o.name_taken_by_relation                      then 'sig_wrong_object_kind'
    when o.bare_unresolvable and o.overloads > 1       then 'sig_name_ambiguous'
    when o.overloads > 0                               then 'sig_only_other_overload'
    else                                                    'sig_absent'
  end                                                                as miss_reason,
  (o.resolved and o.prokind <> 'f')                                  as wrong_kind,
  (o.overloads <> e.exp_overloads)                                   as overload_bad,
  (o.shadows   <> e.exp_shadows)                                     as shadow_bad,
  o.shadow_schemas,
  -- shared, profile-independent structure
  (o.owner    is not distinct from e.exp_owner)                      as owner_ok,
  (o.rettype  is not distinct from e.exp_rettype)                    as rettype_ok,
  (o.args     is not distinct from e.exp_args)                       as args_ok,
  -- LIVE profile
  (o.lang       is not distinct from e.live_lang)                    as live_lang_ok,
  (o.secdef     is not distinct from e.live_secdef)                  as live_secdef_ok,
  (o.volatility is not distinct from e.live_volatility)              as live_volatility_ok,
  (pg_temp.cc_normsp(o.searchpath_raw)
     is not distinct from pg_temp.cc_normsp(e.live_searchpath)
   and coalesce(o.other_proconfig, 0) = 0)                           as live_proconfig_ok,
  -- the LIVE body, pinned by digest exactly as the tombstone body is pinned by
  -- template. `is not distinct from` would let two nulls agree; an unresolved
  -- signature or a missing pin must never read as a match.
  (e.live_body_sha256 is not null
   and o.body_norm is not null
   and encode(sha256(convert_to(o.body_norm, 'UTF8')), 'hex')
         = e.live_body_sha256)                                       as live_body_ok,
  (o.grants_explicit  @> e.live_grants
   and o.grants_explicit <@ e.live_grants)                           as live_grants_ok,
  (o.grants_effective @> e.live_effective
   and o.grants_effective <@ e.live_effective)                       as live_effective_ok,
  -- LIVE profile, dynamic role landscape
  pg_temp.cc_minus(o.exec_inherited,
                   pg_temp.cc_allowed_execers(o.proowner, e.live_grantees))
                                                                     as live_exec_extra,
  pg_temp.cc_minus(pg_temp.cc_allowed_execers(o.proowner, e.live_grantees),
                   o.exec_inherited)                                 as live_exec_lost,
  pg_temp.cc_minus(o.exec_assumable,
                   pg_temp.cc_allowed_assumers(o.proowner, e.live_grantees))
                                                                     as live_assume_extra,
  -- TOMBSTONE profile, derived PER TARGET from the migration that installs the
  -- shim. Not one template for all of them: 0022's loop, 0022's inline shim and
  -- 0017's two shims differ in message, SQLSTATE, security mode and — decisively
  -- — in which roles are still allowed to hold EXECUTE.
  (tt.proname is not null)                                           as tomb_applicable,
  (o.lang is not distinct from tt.lang)                              as tomb_lang_ok,
  (o.secdef is not distinct from tt.secdef)                          as tomb_secdef_ok,
  (o.volatility is not distinct from tt.volatility)                  as tomb_volatility_ok,
  (pg_temp.cc_normsp(o.searchpath_raw)
     is not distinct from pg_temp.cc_normsp(tt.searchpath)
   and coalesce(o.other_proconfig, 0) = 0)                           as tomb_proconfig_ok,
  (o.body_norm is not distinct from tt.body_norm)                    as tomb_body_ok,
  -- safe to invoke: the body matches the derived shape "raise and nothing
  -- else", so calling it cannot mutate anything even when the literals differ
  (o.body_norm is not null and tt.body_shape is not null
   and o.body_norm ~ tt.body_shape)                                  as tomb_probe_safe,
  tt.errcode                                                         as tomb_errcode,
  tt.message                                                         as tomb_message,
  tt.source                                                          as tomb_source,
  tt.mechanism                                                       as tomb_mechanism,
  tt.acl_note                                                        as tomb_acl_note,
  coalesce(tt.expected_grantees, '{}'::text[])                       as tomb_grantees,
  coalesce(tt.acl_fully_revoked, false)                              as tomb_acl_fully_revoked,
  -- A client role holding EXECUTE is a finding unless the migration that
  -- tombstoned this routine says it should. 0017 keeps service_role on its two
  -- shims and says so in the file; 0022 revokes all four and says that.
  ('PUBLIC' = any (o.grants_explicit) or o.exec_public)              as tomb_acl_public,
  ('anon'          = any (o.grants_explicit)
   and not ('anon' = any (coalesce(tt.expected_grantees, '{}'::text[]))))
                                                                     as tomb_acl_anon,
  ('authenticated' = any (o.grants_explicit)
   and not ('authenticated' = any (coalesce(tt.expected_grantees, '{}'::text[]))))
                                                                     as tomb_acl_authenticated,
  ('service_role'  = any (o.grants_explicit)
   and not ('service_role' = any (coalesce(tt.expected_grantees, '{}'::text[]))))
                                                                     as tomb_acl_service_role,
  (cardinality(pg_temp.cc_minus(o.grants_effective,
                                coalesce(tt.expected_grantees, '{}'::text[]))) > 0)
                                                                     as tomb_effective_escape,
  -- TOMBSTONE profile, dynamic role landscape, against the DERIVED grantees
  pg_temp.cc_minus(o.exec_inherited,
                   pg_temp.cc_allowed_execers(o.proowner,
                     coalesce(tt.expected_grantees, '{}'::text[])))
                                                                     as tomb_exec_extra,
  pg_temp.cc_minus(pg_temp.cc_allowed_execers(o.proowner,
                     coalesce(tt.expected_grantees, '{}'::text[])),
                   o.exec_inherited)                                 as tomb_exec_lost,
  pg_temp.cc_minus(o.exec_assumable,
                   pg_temp.cc_allowed_assumers(o.proowner,
                     coalesce(tt.expected_grantees, '{}'::text[])))
                                                                     as tomb_assume_extra,
  -- the sibling landscape, compared to an EXACT pin rather than required empty
  (o.sibling_exec is distinct from e.exp_sibling)                    as sibling_bad,
  -- the dependency closure of this key, if it has one
  (select coalesce(array_agg(distinct dep_kind order by dep_kind), '{}'::text[])
     from cc_dep_obs d where d.key = e.key and not d.ok)             as dep_bad_kinds,
  (select count(*) from cc_dep_obs d where d.key = e.key)            as dep_rows,
  o.exec_public,
  o.sibling_exec,
  o.grants_explicit,
  o.grants_effective,
  o.exec_inherited,
  o.exec_assumable,
  o.proacl_is_null,
  o.owner, o.lang, o.secdef, o.volatility, o.rettype, o.args,
  o.searchpath_raw, o.proacl_raw, o.body_norm, o.overloads, o.shadows,
  e.expected_state, e.proname, e.sig, e.live_grantees, e.live_body_sha256,
  e.exp_sibling
from cc_expect e
join cc_obs   o using (key)
left join cc_tomb_target tt
       on (tt.sig = e.sig) or (tt.sig is null and tt.proname = e.proname);

-- ---------------------------------------------------------------------------
-- 5. probes
--
-- LIVE probe: gated on the STRUCTURAL live profile only, deliberately not on
-- the ACL. That is the whole point of the owns_account control: a routine
-- whose EXECUTE was revoked by accident still gets called, still answers
-- 42501, and still must not be mistaken for a tombstone.
--
-- The owns_account probe asks NINE questions. Three of them tell ownership
-- from existence (the fixture carries a second account under a different
-- owner, and a function that ignores `owner_id` answers `true` for it). The
-- other six are the NEGATIVE side of the predicate, and they exist because a
-- three-point truth table proves only that the function says yes where it
-- should: it says nothing about who else it says yes to.
--
--   as A:  owns(A's account)  -> true     the predicate is not always false
--   as A:  owns(absent id)    -> false
--   as A:  owns(B's account)  -> false    ownership, not existence
--   as B:  owns(B's account)  -> true     it tracks the subject, not a constant
--   as B:  owns(A's account)  -> false
--   as C:  owns(A's account)  -> false    C owns nothing (control C22)
--   as C:  owns(B's account)  -> false
--   none:  owns(A's account)  -> false    no subject is not "every subject"
--   none:  owns(B's account)  -> false
--
-- The last two are the ones that catch `or auth.uid() is null`, a body that
-- authorises every account for an unauthenticated or service-side caller and
-- that answers the original three-point table perfectly. A backdoor keyed on
-- a uuid none of A, B or C holds answers all NINE perfectly; that shape is
-- caught by the body digest in cc_expect.live_body_sha256, not here. Neither
-- check subsumes the other.
--
-- TOMB probe: gated on tomb_probe_safe — the body must match the derived
-- "raise and nothing else" shape before we are willing to invoke it. A body
-- that does not match cannot be the tombstone anyway, and invoking an unknown
-- body inside the clone is not something a classifier should do.
--
-- THE TWO PROBES ARE INDEPENDENT, NOT AN if/else CHAIN. They used to be, and
-- that is a second face of the same defect AUD-1 named. Migration 0017 replaces
-- the bodies of reconcile_cash_flow_mirror and replace_equity_snapshots with a
-- `raise` and changes NOTHING else — same owner, language, security mode,
-- volatility, search_path, arguments, return type. Their live structural gate
-- therefore matches, so an `elsif` handed them to the live branch, which has no
-- probe for those keys, and the privileged refusal probe never ran: the
-- strongest evidence this file can produce was skipped for exactly the two
-- shims a section-scoped derivation had already missed. Each profile is now
-- offered its own probe on its own gate, and the verdict reads the row for the
-- profile it is reasoning about.
-- ---------------------------------------------------------------------------
create temporary table cc_probe(
  key        text not null,
  kind       text not null,  -- live | tomb | none
  primary key (key, kind),
  ran        boolean not null default false,
  -- false only when the LIVE structure matched but this file defines no probe
  -- for that key. That is a coverage gap in the classifier, not a property of
  -- the database, and it must never be reported as "the probe answered wrongly".
  defined    boolean not null default true,
  sqlstate   text,
  message    text,
  effect_ok  boolean,
  detail     text,
  unpriv_sqlstate text,
  unpriv_message  text
);

do $cc$
declare
  mode          text := pg_temp.cc_cfg('probe_mode');
  r             record;
  st            text;
  msg           text;
  sid           uuid;
  got           text;
  gotname       text;
  nm            text;
  probe_defined boolean;
  own_a         boolean;
  absent_a      boolean;
  other_a       boolean;
  own_b         boolean;
  cross_b       boolean;
  c_on_a        boolean;
  c_on_b        boolean;
  null_on_a     boolean;
  null_on_b     boolean;
  subj_a        constant text := '11111111-1111-4111-8111-111111111111';
  subj_b        constant text := '44444444-4444-4444-8444-444444444444';
  subj_c        constant text := '66666666-6666-4666-8666-666666666666';
  acct_a        constant uuid := '22222222-2222-4222-8222-222222222222';
  acct_b        constant uuid := '55555555-5555-4555-8555-555555555555';
  acct_absent   constant uuid := '33333333-3333-4333-8333-333333333333';
  n_sec_before  bigint;
  n_sec_after   bigint;
  n_aud_before  bigint;
  n_aud_after   bigint;
  eff           boolean;
  det           text;
  stmt          text;
  live_gate     boolean;
  tomb_gate     boolean;
  probed        boolean;
begin
  for r in select * from cc_struct order by key loop
    probed := false;

    live_gate := r.resolved and not r.wrong_kind
       and r.owner_ok and r.rettype_ok and r.args_ok
       and r.live_lang_ok and r.live_secdef_ok and r.live_volatility_ok
       and r.live_proconfig_ok;
    tomb_gate := coalesce(r.tomb_applicable, false) and r.resolved
       and not r.wrong_kind and coalesce(r.tomb_probe_safe, false);

    ------------------------------------------------------------------ LIVE
    if live_gate then
      probed := true;

      if mode = 'skip' then
        insert into cc_probe(key, kind, ran, detail)
        values (r.key, 'live', false, 'probe_mode=skip: no live probe was run');
      else

      st := null; msg := null; eff := false; det := null;
      nm  := 'cc-probe-' || md5(random()::text);
      probe_defined := true;
      begin
        if mode = 'break' then
          set role service_role;
          perform public.__cc_probe_broken_do_not_exist();
          reset role;
          eff := true; det := 'unreachable';

        elsif r.key = 'vault_create_secret' then
          set role service_role;
          sid := public.vault_create_secret('CC-PROBE-NOT-A-CREDENTIAL', nm);
          reset role;
          select ds.decrypted_secret, s2.name into got, gotname
            from vault.decrypted_secrets ds join vault.secrets s2 on s2.id = ds.id
           where ds.id = sid;
          eff := sid is not null
                 and got = 'CC-PROBE-NOT-A-CREDENTIAL'
                 and gotname = nm;
          det := format('created id=%s name_match=%s value_match=%s',
                        sid is not null, gotname = nm, got = 'CC-PROBE-NOT-A-CREDENTIAL');
          delete from vault.secrets where id = sid;

        elsif r.key = 'vault_update_secret' then
          sid := vault.create_secret('CC-PROBE-NOT-A-CREDENTIAL', nm,
                                     'catalogue-classify probe; never a credential');
          set role service_role;
          perform public.vault_update_secret(sid, 'CC-PROBE-UPDATED');
          reset role;
          select decrypted_secret into got from vault.decrypted_secrets where id = sid;
          eff := got = 'CC-PROBE-UPDATED';
          det := format('updated value_now=%s', quote_literal(coalesce(got, '<null>')));
          delete from vault.secrets where id = sid;

        elsif r.key = 'vault_delete_secret' then
          sid := vault.create_secret('CC-PROBE-NOT-A-CREDENTIAL', nm,
                                     'catalogue-classify probe; never a credential');
          set role service_role;
          perform public.vault_delete_secret(sid);
          reset role;
          eff := not exists (select 1 from vault.secrets where id = sid);
          det := format('deleted rows_remaining=%s',
                        (select count(*) from vault.secrets where id = sid));

        elsif r.key = 'owns_account' then
          --------------------------------------------------- subject A (owner)
          perform set_config('request.jwt.claim.sub', subj_a, true);
          perform set_config('request.jwt.claims', format('{"sub":"%s"}', subj_a), true);
          set role service_role;
          -- own account -> true
          own_a    := public.owns_account(acct_a);
          -- absent account -> false
          absent_a := public.owns_account(acct_absent);
          -- SOMEBODY ELSE'S account -> false. A function rewritten to check
          -- existence instead of ownership answers true here.
          other_a  := public.owns_account(acct_b);
          reset role;

          ------------------------------------------- subject B (the other owner)
          -- Symmetry. Without it, "false for B's account" is also what a
          -- predicate hard-wired to one subject would answer.
          perform set_config('request.jwt.claim.sub', subj_b, true);
          perform set_config('request.jwt.claims', format('{"sub":"%s"}', subj_b), true);
          set role service_role;
          own_b   := public.owns_account(acct_b);
          cross_b := public.owns_account(acct_a);
          reset role;

          ---------------------------------- subject C, who owns nothing (C22)
          perform set_config('request.jwt.claim.sub', subj_c, true);
          perform set_config('request.jwt.claims', format('{"sub":"%s"}', subj_c), true);
          set role service_role;
          c_on_a := public.owns_account(acct_a);
          c_on_b := public.owns_account(acct_b);
          reset role;

          ------------------------------------------- NO subject: auth.uid() null
          -- The discriminating negative probe. A body of the form
          -- `owner_id = auth.uid() or auth.uid() is null` answers every
          -- question above exactly as the real one does, and authorises every
          -- account for any caller arriving without a JWT.
          perform set_config('request.jwt.claim.sub', '', true);
          perform set_config('request.jwt.claims', '', true);
          set role service_role;
          null_on_a := public.owns_account(acct_a);
          null_on_b := public.owns_account(acct_b);
          reset role;

          -- leave the session on subject A so nothing downstream inherits an
          -- empty JWT from this probe
          perform set_config('request.jwt.claim.sub', subj_a, true);
          perform set_config('request.jwt.claims', format('{"sub":"%s"}', subj_a), true);

          eff := (own_a is true) and (absent_a is false) and (other_a is false)
                 and (own_b is true) and (cross_b is false)
                 and (c_on_a is false) and (c_on_b is false)
                 and (null_on_a is false) and (null_on_b is false);
          det := format('A:own=%s absent=%s other_owner=%s | B:own=%s cross=%s | '
                        'C(owns-nothing):A=%s B=%s | no-subject:A=%s B=%s',
                        own_a, absent_a, other_a, own_b, cross_b,
                        c_on_a, c_on_b, null_on_a, null_on_b);

        else
          -- The LIVE structure matched, but this file has no probe for the key.
          -- That is a gap in the CLASSIFIER, and calling it a wrong answer from
          -- the database would be a lie: it is recorded as its own reason code.
          probe_defined := false;
          eff := false;
          det := 'the LIVE structure matched but this file defines no live probe for this key';
        end if;
        st := '00000';
        msg := 'call completed';
      exception when others then
        get stacked diagnostics st = returned_sqlstate, msg = message_text;
        eff := false;
        det := coalesce(det, 'call raised');
      end;
      reset role;
      if probe_defined then
        insert into cc_probe(key, kind, ran, sqlstate, message, effect_ok, detail)
        values (r.key, 'live', true, st, msg, eff, det);
      else
        insert into cc_probe(key, kind, ran, defined, detail)
        values (r.key, 'live', false, false, det);
      end if;
      end if;   -- mode = 'skip'
    end if;     -- live_gate

    ------------------------------------------------------------------ TOMB
    if tomb_gate then
      probed := true;

      if mode = 'skip' then
        insert into cc_probe(key, kind, ran, detail)
        values (r.key, 'tomb', false, 'probe_mode=skip: no privileged probe was run');
      else

      select count(*) into n_sec_before from vault.secrets;
      select count(*) into n_aud_before from public.audit_log;

      stmt := case r.key
        when 'vault_create_secret' then
          $q$select public.vault_create_secret('CC-PROBE-NOT-A-CREDENTIAL','cc-probe-tombstone')$q$
        when 'vault_update_secret' then
          $q$select public.vault_update_secret('00000000-0000-0000-0000-000000000000'::uuid,'CC-PROBE-NOT-A-CREDENTIAL')$q$
        when 'vault_delete_secret' then
          $q$select public.vault_delete_secret('00000000-0000-0000-0000-000000000000'::uuid)$q$
        -- The other two routines 0022 section 5 tombstones. Every argument is
        -- an explicit NULL cast: the call has to REACH THE BODY, and the body
        -- this file is willing to invoke raises before it looks at anything
        -- (tomb_probe_safe). A tombstone that had been replaced by something
        -- else would not have been invoked at all.
        when 'create_account_atomic' then
          $q$select public.create_account_atomic(null::uuid, null::text, null::account_mode, null::text, null::uuid, null::uuid, null::text, null::uuid)$q$
        when 'record_account_verification' then
          $q$select public.record_account_verification(null::uuid, null::uuid, null::account_status, null::text, null::bigint)$q$
        -- The three shims a section-scoped derivation never saw. 0017 installs
        -- the first two; 0022 installs the third INLINE, sixty lines above its
        -- loop, and leaves a live three-argument successor beside it — the
        -- explicit ::uuid casts pick the two-argument tombstone and nothing
        -- else. Without these three rows the strongest evidence this file can
        -- produce was simply not produced for them, and `tomb:probe_missing`
        -- was the honest but useless answer.
        when 'reconcile_cash_flow_mirror' then
          $q$select public.reconcile_cash_flow_mirror(null::uuid, null::uuid, null::date, null::jsonb)$q$
        when 'replace_equity_snapshots' then
          $q$select public.replace_equity_snapshots(null::uuid, null::uuid, null::jsonb)$q$
        when 'resolve_create_operation' then
          $q$select public.resolve_create_operation(null::uuid, null::uuid)$q$
        else null end;

      if mode = 'break' then
        stmt := $q$select public.__cc_probe_broken_do_not_exist()$q$;
      end if;

      if stmt is null then
        insert into cc_probe(key, kind, ran, detail)
        values (r.key, 'tomb', false, 'no privileged probe is defined for this key');
      else

      -- PRIVILEGED: the session role is supabase_admin, a superuser, so the
      -- ACL cannot be what answers. Whatever comes back came from the body.
      st := null; msg := null;
      begin
        execute stmt;
        st := '00000'; msg := 'no exception raised';
      exception when others then
        get stacked diagnostics st = returned_sqlstate, msg = message_text;
      end;

      select count(*) into n_sec_after from vault.secrets;
      select count(*) into n_aud_after from public.audit_log;

      -- and the same call as the role the dashboard runs as, recorded as
      -- EVIDENCE ONLY; a 42501 here decides nothing on its own
      begin
        set role service_role;
        execute stmt;
        reset role;
        det := '00000';
        got := 'no exception raised';
      exception when others then
        get stacked diagnostics det = returned_sqlstate, got = message_text;
      end;
      reset role;

      insert into cc_probe(key, kind, ran, sqlstate, message, effect_ok, detail,
                           unpriv_sqlstate, unpriv_message)
      values (r.key, 'tomb', true, st, msg,
              (n_sec_after = n_sec_before and n_aud_after = n_aud_before),
              format('vault.secrets %s->%s audit_log %s->%s',
                     n_sec_before, n_sec_after, n_aud_before, n_aud_after),
              det, got);
      end if;   -- stmt is null
      end if;   -- mode = 'skip'
    end if;     -- tomb_gate

    if not probed then
      insert into cc_probe(key, kind, ran, detail)
      values (r.key, 'none', false,
              'neither profile matched structurally; no probe was invoked');
    end if;
  end loop;
  reset role;
end
$cc$;

-- ---------------------------------------------------------------------------
-- 6. verdict
-- ---------------------------------------------------------------------------
create temporary table cc_verdict as
with p as (
  select s.*,
         -- Each profile reads ITS OWN probe row. A single `using (key)` join was
         -- only ever unambiguous because the probe loop was an if/else chain; now
         -- that both profiles can be probed for one object, joining once would
         -- either duplicate the verdict row or let the live probe's answer decide
         -- a tombstone question.
         lp.ran       as live_probe_ran,
         coalesce(lp.defined, true) as live_probe_is_defined,
         lp.sqlstate  as live_probe_sqlstate,
         lp.effect_ok as live_probe_effect_ok,
         (lp.key is not null) as live_probe_selected,
         tp.ran       as tomb_probe_ran,
         tp.sqlstate  as tomb_probe_sqlstate,
         tp.message   as tomb_probe_message,
         tp.effect_ok as tomb_probe_effect_ok,
         (tp.key is not null) as tomb_probe_selected,
         -- the row shown in the report and the JSON: the profile this generation
         -- EXPECTS, falling back to whichever row exists
         coalesce(case when s.expected_state = 'TOMBSTONED' then tp.kind
                       when s.expected_state = 'LIVE'       then lp.kind end,
                  tp.kind, lp.kind, np.kind)                              as probe_kind,
         coalesce(case when s.expected_state = 'TOMBSTONED' then tp.ran
                       when s.expected_state = 'LIVE'       then lp.ran end,
                  tp.ran, lp.ran, np.ran)                                 as probe_ran,
         coalesce(case when s.expected_state = 'TOMBSTONED' then tp.defined
                       when s.expected_state = 'LIVE'       then lp.defined end,
                  tp.defined, lp.defined, np.defined, true)               as probe_is_defined,
         coalesce(case when s.expected_state = 'TOMBSTONED' then tp.sqlstate
                       when s.expected_state = 'LIVE'       then lp.sqlstate end,
                  tp.sqlstate, lp.sqlstate)                               as probe_sqlstate,
         coalesce(case when s.expected_state = 'TOMBSTONED' then tp.message
                       when s.expected_state = 'LIVE'       then lp.message end,
                  tp.message, lp.message)                                 as probe_message,
         coalesce(case when s.expected_state = 'TOMBSTONED' then tp.effect_ok
                       when s.expected_state = 'LIVE'       then lp.effect_ok end,
                  tp.effect_ok, lp.effect_ok)                             as probe_effect_ok,
         coalesce(case when s.expected_state = 'TOMBSTONED' then tp.detail
                       when s.expected_state = 'LIVE'       then lp.detail end,
                  tp.detail, lp.detail, np.detail)                        as probe_detail,
         coalesce(tp.unpriv_sqlstate, lp.unpriv_sqlstate)                 as unpriv_sqlstate,
         coalesce(tp.unpriv_message,  lp.unpriv_message)                  as unpriv_message,
         (select defacl     from cc_env)                                  as defacl_now,
         (select superusers from cc_env)                                  as superusers_now,
         (select rolegraph  from cc_env)                                  as rolegraph_now,
         (select bypassrls  from cc_env)                                  as bypassrls_now,
         (select defacl     from cc_env_expect
           where generation = pg_temp.cc_cfg('generation'))               as defacl_expected,
         (select superusers from cc_env_expect
           where generation = pg_temp.cc_cfg('generation'))               as superusers_expected,
         (select rolegraph  from cc_env_expect
           where generation = pg_temp.cc_cfg('generation'))               as rolegraph_expected,
         (select bypassrls  from cc_env_expect
           where generation = pg_temp.cc_cfg('generation'))               as bypassrls_expected
    from cc_struct s
    left join cc_probe lp on lp.key = s.key and lp.kind = 'live'
    left join cc_probe tp on tp.key = s.key and tp.kind = 'tomb'
    left join cc_probe np on np.key = s.key and np.kind = 'none'
),
m as (
  select p.*,
    -- ---- structural findings, profile independent
    (case when not p.resolved then array[p.miss_reason]
          when p.wrong_kind   then array['sig_wrong_object_kind']
          else '{}'::text[] end)
    || (case when p.resolved and p.overload_bad then array['overload_unexpected'] else '{}'::text[] end)
    || (case when p.resolved and p.shadow_bad   then array['alt_schema_shadow']   else '{}'::text[] end)
                                                                          as structural_misses,
    -- ---- environment findings, shared by both profiles
    (case when p.defacl_now is not distinct from p.defacl_expected
          then '{}'::text[] else array['env:default_acl_drift'] end)
    || (case when p.superusers_now is not distinct from p.superusers_expected
             then '{}'::text[] else array['env:superuser_set_drift'] end)
    || (case when p.rolegraph_now is not distinct from p.rolegraph_expected
             then '{}'::text[] else array['env:role_membership_drift'] end)
    -- ADV-2(D). A BYPASSRLS role reads every row of every table, and neither
    -- the superuser fingerprint nor the membership graph moves when the
    -- attribute is granted. Measured: PASS while `authenticated` read every
    -- guarded table plus profiles and audit_log.
    || (case when p.bypassrls_now is not distinct from p.bypassrls_expected
             then '{}'::text[] else array['env:bypassrls_set_drift'] end)
                                                                          as env_misses,
    -- ---- LIVE profile: definition
    (case when p.owner_ok            then '{}'::text[] else array['live:owner_mismatch'] end)
    || (case when p.rettype_ok       then '{}'::text[] else array['live:rettype_mismatch'] end)
    || (case when p.args_ok          then '{}'::text[] else array['live:args_mismatch'] end)
    || (case when p.live_lang_ok     then '{}'::text[] else array['live:language_mismatch'] end)
    || (case when p.live_secdef_ok   then '{}'::text[] else array['live:secmode_mismatch'] end)
    || (case when p.live_volatility_ok then '{}'::text[] else array['live:volatility_mismatch'] end)
    || (case when p.live_proconfig_ok  then '{}'::text[] else array['live:proconfig_mismatch'] end)
    -- the body, pinned by digest. Every catalogue property above can be intact
    -- while a clause has been added to the predicate.
    || (case when p.live_body_ok       then '{}'::text[] else array['live:body_mismatch'] end)
    || (case when p.live_probe_ran
                  and p.live_probe_sqlstate = '00000' and not p.live_probe_effect_ok
                                        then array['live:probe_effect_mismatch']
             when p.live_probe_ran
                  and p.live_probe_sqlstate is distinct from '00000'
                  and p.live_probe_sqlstate is distinct from '42501'
                                        then array['live:probe_failed']
             when p.live_probe_selected and not p.live_probe_is_defined
                                        then '{}'::text[]  -- reported as a gap
             when not p.live_probe_selected
                                        then array['live:probe_skipped_structure']
             else '{}'::text[] end)
                                                                          as live_def_misses,
    -- ---- LIVE profile: privileges
    (case when p.live_grants_ok        then '{}'::text[] else array['live:acl_explicit_mismatch'] end)
    || (case when p.live_effective_ok  then '{}'::text[] else array['live:acl_effective_mismatch'] end)
    || (case when cardinality(p.live_exec_extra) = 0
             then '{}'::text[] else array['live:acl_unexpected_executor'] end)
    || (case when cardinality(p.live_exec_lost) = 0
             then '{}'::text[] else array['live:acl_missing_executor'] end)
    || (case when cardinality(p.live_assume_extra) = 0
             then '{}'::text[] else array['live:acl_assumable_executor'] end)
    || (case when p.exec_public and not ('PUBLIC' = any (p.live_grantees))
             then array['live:acl_public_execute'] else '{}'::text[] end)
    -- The sibling landscape is compared to its EXACT PIN, not required to be
    -- empty. `cardinality(sibling_exec) = 0` made the pin decorative: it fired
    -- on public.resolve_create_operation, whose live three-argument successor is
    -- MEANT to be callable by service_role, so the pristine schema could never
    -- be green with the inline tombstone in the catalogue.
    || (case when p.sibling_bad
             then array['live:acl_sibling_executable'] else '{}'::text[] end)
    || (case when p.live_probe_ran and p.live_probe_sqlstate = '42501'
             then array['live:probe_failed'] else '{}'::text[] end)
                                                                          as live_acl_misses,
    -- ---- LIVE profile: evidence gaps
    (case when p.live_probe_selected and not p.live_probe_ran
               and not p.live_probe_is_defined then array['live:probe_undefined']
          when p.live_probe_selected and not p.live_probe_ran
                                     then array['live:probe_missing']
          else '{}'::text[] end)
                                                                          as live_gap_misses,
    -- ---- TOMBSTONE profile: definition
    (case when p.owner_ok                then '{}'::text[] else array['tomb:owner_mismatch'] end)
    || (case when p.rettype_ok           then '{}'::text[] else array['tomb:rettype_mismatch'] end)
    || (case when p.args_ok              then '{}'::text[] else array['tomb:args_mismatch'] end)
    || (case when p.tomb_lang_ok         then '{}'::text[] else array['tomb:language_mismatch'] end)
    || (case when p.tomb_secdef_ok       then '{}'::text[] else array['tomb:secmode_mismatch'] end)
    || (case when p.tomb_volatility_ok   then '{}'::text[] else array['tomb:volatility_mismatch'] end)
    || (case when p.tomb_proconfig_ok    then '{}'::text[] else array['tomb:proconfig_mismatch'] end)
    || (case when p.tomb_body_ok         then '{}'::text[] else array['tomb:body_not_tombstone'] end)
    -- The SQLSTATE and the message are the ones DERIVED FOR THIS TARGET, not one
    -- global template rendered with the routine's name. 0022's loop raises
    -- P0001 with "%s is superseded and must not be called"; 0022's inline shim
    -- raises P0001 with "pass the expected request fingerprint"; 0017's two
    -- shims raise 0A000 and name publish_broker_refresh. Holding all four to the
    -- loop's template would have failed the pristine schema on three of them —
    -- and the only ways out of that are to relax the check or to keep the
    -- section-scoped derivation that hid them.
    || (case when p.tomb_probe_ran
                  and p.tomb_probe_sqlstate is distinct from p.tomb_errcode
                                          then array['tomb:probe_sqlstate_mismatch']
             when p.tomb_probe_ran
                  and p.tomb_probe_message is distinct from p.tomb_message
                                          then array['tomb:probe_message_mismatch']
             when p.tomb_probe_ran and not p.tomb_probe_effect_ok
                                          then array['tomb:probe_side_effect']
             else '{}'::text[] end)
                                                                          as tomb_def_misses,
    -- ---- TOMBSTONE profile: privileges
    (case when p.tomb_acl_public           then array['tomb:acl_public_execute'] else '{}'::text[] end)
    || (case when p.tomb_acl_anon          then array['tomb:acl_anon_execute'] else '{}'::text[] end)
    || (case when p.tomb_acl_authenticated then array['tomb:acl_authenticated_execute'] else '{}'::text[] end)
    || (case when p.tomb_acl_service_role  then array['tomb:acl_service_role_execute'] else '{}'::text[] end)
    || (case when p.tomb_effective_escape  then array['tomb:acl_effective_escape'] else '{}'::text[] end)
    || (case when cardinality(p.tomb_exec_extra) = 0
             then '{}'::text[] else array['tomb:acl_unexpected_executor'] end)
    || (case when cardinality(p.tomb_exec_lost) = 0
             then '{}'::text[] else array['tomb:acl_missing_executor'] end)
    || (case when cardinality(p.tomb_assume_extra) = 0
             then '{}'::text[] else array['tomb:acl_assumable_executor'] end)
    || (case when p.sibling_bad
             then array['tomb:acl_sibling_executable'] else '{}'::text[] end)
                                                                          as tomb_acl_misses,
    -- ---- TOMBSTONE profile: applicability and evidence gaps
    (case when p.tomb_applicable then '{}'::text[] else array['tomb:not_applicable'] end)
                                                                          as tomb_app_misses,
    (case when not coalesce(p.tomb_probe_safe, false)
                                       then array['tomb:probe_skipped_unsafe_body']
          when not p.tomb_probe_selected
                                       then array['tomb:probe_not_invoked']
          when not p.tomb_probe_ran    then array['tomb:probe_missing']
          else '{}'::text[] end)
                                                                          as tomb_gap_misses,
    -- ---- the DEPENDENCY CLOSURE of the authorization predicate
    --
    -- Section 2d observes it; without this block nothing ever read the
    -- observation, which is the same "computed but never decisive" shape as the
    -- sibling pin above. A closure finding is folded into BOTH profiles so it
    -- can never be washed out by which profile an object happens to match.
    -- Every dep_kind the check constraint on cc_dep_expect admits has its own
    -- branch. The `else` used to hold 'policy', which meant a NEW arm added to
    -- that constraint would have been reported under the policy code — the
    -- wrong name on a real finding, which is how dep:rls_disabled once came
    -- back as an unregistered-code control failure. It is unreachable while the
    -- constraint and this CASE agree, and it names the disagreement if they
    -- ever stop agreeing.
    (select coalesce(array_agg(distinct
              case d.dep_kind when 'function'  then 'dep:function_drift'
                              when 'relation'  then 'dep:relation_drift'
                              when 'rls'       then 'dep:rls_disabled'
                              when 'policy'    then 'dep:policy_set_changed'
                              when 'policyset' then 'dep:guarded_policy_set_changed'
                              when 'guarded'   then 'dep:guarded_table_exposed'
                              else                  'dep:closure_missing' end),
                     '{}'::text[])
       from cc_dep_obs d where d.key = p.key and not d.ok)
    || (case when exists (select 1 from cc_dep_expect x where x.key = p.key)
                  and not exists (select 1 from cc_dep_obs d where d.key = p.key)
             then array['dep:closure_missing'] else '{}'::text[] end)
                                                                          as dep_misses
  from p
),
c as (
  select m.*,
         m.live_def_misses || m.live_acl_misses || m.live_gap_misses
           || m.dep_misses                                               as live_misses,
         m.tomb_app_misses || m.tomb_def_misses || m.tomb_acl_misses
           || m.tomb_gap_misses || m.dep_misses                          as tomb_misses
  from m
),
o as (
  select c.*,
    case
      when not c.resolved                          then 'MISSING'
      when c.wrong_kind                            then 'MISSING'
      when cardinality(c.structural_misses) = 0
           and cardinality(c.env_misses) = 0
           and cardinality(c.live_misses) = 0      then 'LIVE'
      when cardinality(c.structural_misses) = 0
           and cardinality(c.env_misses) = 0
           and cardinality(c.tomb_misses) = 0      then 'TOMBSTONED'
      else 'DRIFT'
    end as observed_state
  from c
),
f as (
  select o.*,
    -- The drift refinement is computed against the profile EXPECTED here, in a
    -- fixed precedence: what an unexpected role can execute outranks a broken
    -- authorization closure, which outranks what is merely present, which
    -- outranks a definition that moved, which outranks a privilege surface that
    -- moved, which outranks "the probe did not run".
    --
    -- AUTHZ_CLOSURE_BROKEN is its own state and not a flavour of
    -- DEFINITION_DRIFT, because nothing about THIS object's definition moved. A
    -- redefined `auth.uid()` or an `alter table positions disable row level
    -- security` leaves owns_account byte-identical, correctly owned, correctly
    -- granted, and answering all nine probes correctly, while the authorization
    -- it is supposed to provide is gone. Calling that "definition drift" would
    -- name the wrong object; calling it ACL_DRIFT would name the wrong
    -- mechanism; and folding it into UNPROVEN — which is what happened before
    -- these codes were ranked at all — says the check did not run when in fact
    -- it ran and failed.
    case
      when o.expected_state = 'LIVE' then
        case
          when o.live_acl_misses && array['live:acl_unexpected_executor',
                                          'live:acl_assumable_executor',
                                          'live:acl_public_execute',
                                          'live:acl_sibling_executable']
                                                        then 'UNEXPECTED_EXECUTABLE'
          when cardinality(o.dep_misses) > 0            then 'AUTHZ_CLOSURE_BROKEN'
          when cardinality(o.structural_misses) > 0     then 'UNEXPECTED_PRESENT'
          when cardinality(o.live_def_misses) > 0       then 'DEFINITION_DRIFT'
          when cardinality(o.live_acl_misses) > 0
               or cardinality(o.env_misses) > 0         then 'ACL_DRIFT'
          when cardinality(o.live_gap_misses) > 0       then 'UNPROVEN'
          else 'UNPROVEN'
        end
      else
        case
          when o.tomb_acl_misses && array['tomb:acl_public_execute',
                                          'tomb:acl_anon_execute',
                                          'tomb:acl_authenticated_execute',
                                          'tomb:acl_service_role_execute',
                                          'tomb:acl_effective_escape',
                                          'tomb:acl_unexpected_executor',
                                          'tomb:acl_assumable_executor',
                                          'tomb:acl_sibling_executable']
                                                        then 'UNEXPECTED_EXECUTABLE'
          when cardinality(o.dep_misses) > 0            then 'AUTHZ_CLOSURE_BROKEN'
          when cardinality(o.structural_misses) > 0
               or cardinality(o.tomb_app_misses) > 0    then 'UNEXPECTED_PRESENT'
          when cardinality(o.tomb_def_misses) > 0       then 'DEFINITION_DRIFT'
          when cardinality(o.tomb_acl_misses) > 0
               or cardinality(o.env_misses) > 0         then 'ACL_DRIFT'
          when cardinality(o.tomb_gap_misses) > 0       then 'UNPROVEN'
          else 'UNPROVEN'
        end
    end as drift_state
  from o
)
select f.*,
  case
    -- An ABSENT expectation is decided by presence alone: this generation
    -- predates the routine, so ANY routine answering that exact signature is
    -- a finding, whatever profile it happens to match.
    when f.expected_state = 'ABSENT'
         then (case when f.resolved then 'UNEXPECTED_PRESENT'
                    else 'EXPECTEDLY_ABSENT' end)
    when f.observed_state = 'MISSING'                             then 'MISSING'
    when f.observed_state = 'LIVE'       and f.expected_state = 'LIVE'
                                                                  then 'LIVE_EXPECTED'
    when f.observed_state = 'TOMBSTONED' and f.expected_state = 'TOMBSTONED'
                                                                  then 'INTENTIONALLY_TOMBSTONED'
    when f.observed_state in ('LIVE','TOMBSTONED')                then 'UNEXPECTED_PRESENT'
    else f.drift_state
  end as final_state,
  -- The flat list is the decisive one: the structural and environment
  -- findings, plus the misses of the profile that was EXPECTED here, plus the
  -- state mismatch. Profile misses are suppressed for a MISSING object — "the
  -- tombstone body does not match" says nothing useful about a signature that
  -- is not there. The full live_misses / tomb_misses arrays stay in the JSON
  -- either way.
  (
    -- 'sig_absent' is the CORRECT observation for a row this generation
    -- expects to be absent; reporting it as a miss would make every clean run
    -- carry a finding.
    (case when f.expected_state = 'ABSENT' and not f.resolved
          then '{}'::text[] else f.structural_misses end)
    || case when f.observed_state = 'MISSING' then '{}'::text[] else f.env_misses end
    || case when f.expected_state = 'ABSENT'
              then (case when f.resolved then array['absent:routine_exists']
                         else '{}'::text[] end)
            when f.observed_state = 'MISSING' then '{}'::text[]
            when f.expected_state = 'LIVE'    then f.live_misses
            else f.tomb_misses end
    || case when f.observed_state in ('LIVE','TOMBSTONED')
                 and ((f.observed_state = 'LIVE' and f.expected_state <> 'LIVE')
                   or (f.observed_state = 'TOMBSTONED' and f.expected_state <> 'TOMBSTONED'))
            then array['expected_state_mismatch'] else '{}'::text[] end
  ) as reasons
from f;

-- C19: every reason code this run actually emitted must be registered. The
-- suite's coverage assertion reads the registry; an unregistered code would be
-- a check nothing can require.
do $cc$
declare
  unreg text;
begin
  select string_agg(distinct x, ',' order by x) into unreg
    from cc_verdict v,
         lateral unnest(v.structural_misses || v.env_misses || v.live_misses
                        || v.tomb_misses || v.reasons) x
   where x is not null
     and not exists (select 1 from cc_reason_registry g where g.code = x);
  insert into cc_control values ('C19_reasons_registered',
    unreg is null,
    coalesce('unregistered reason codes: ' || unreg, 'every emitted reason code is registered'));
end
$cc$;

-- C25: the other half of C20. C20 asserts the EXPECTATION names every routine
-- 0022 tombstones; this one asserts a VERDICT was actually reached for each of
-- them. An expectation row that produced no verdict row — because the join in
-- section 3 or 4 dropped it — would leave exactly the blind spot C20 exists to
-- close, one step further down the pipeline. The two sets are compared in both
-- directions: a verdict for a tombstone name the migration does not name is as
-- much a contract break as a missing one.
do $cc$
declare
  tnames    text[] := string_to_array(pg_temp.cc_cfg('tomb_names'), ',');
  verdicted text[];
  missing   text[];
  surplus   text[];
begin
  select coalesce(array_agg(distinct proname), '{}'::text[]) into verdicted
    from cc_verdict;
  missing := pg_temp.cc_minus(tnames, verdicted);
  -- surplus is computed over the tomb-relevant side only: owns_account is a
  -- control object and is deliberately verdicted without being tombstoned.
  select coalesce(array_agg(distinct proname), '{}'::text[]) into surplus
    from cc_verdict
   where not (proname = any (tnames))
     and expected_state = 'TOMBSTONED';
  insert into cc_control values ('C25_tombstone_names_verdicted',
    cardinality(missing) = 0 and cardinality(surplus) = 0,
    format('0022 names [%s]; verdict rows for [%s]; without a verdict: [%s]; '
           'verdicted as a tombstone but not named by 0022: [%s]',
           array_to_string(tnames, ','), array_to_string(verdicted, ','),
           array_to_string(missing, ','), array_to_string(surplus, ',')));
end
$cc$;

-- ---------------------------------------------------------------------------
-- 6b. THE RESULT GATE — one function, called by both places that publish it.
--
-- The gate used to be written out TWICE: once for the CATALOGUE_CLASSIFY_RESULT
-- line the shell driver parses, and once again for the JSON `result` key. Two
-- hand-maintained copies of the same predicate is precisely how a clause ends
-- up in one of them and not the other, and it is how the whole-schema
-- counter-scan came to be in NEITHER. One function called twice cannot drift,
-- which is why this is a function and not a second careful copy.
-- ---------------------------------------------------------------------------
create function pg_temp.cc_result() returns text
language sql stable as $fn$
  select case
    when exists (select 1 from cc_control where not ok)              then 'CONTROL_FAILED'
    when (select count(*) from cc_verdict) <> (select count(*) from cc_expect)
                                                                     then 'CONTROL_FAILED'
    when (select count(*) from cc_expect) = 0                        then 'CONTROL_FAILED'
    when pg_temp.cc_cfg('probe_mode') <> 'normal'                    then 'FAIL'
    -- the whole-schema counter-scan (section 2e). A run-level finding with no
    -- catalogue key: a client-executable routine whose signature, role list,
    -- security mode or owner is not the pinned one, or an unpinned SECURITY
    -- DEFINER vault reacher, is a blocker even when every catalogued object is
    -- exactly as expected. Read the RESIDUAL LIMIT note at section 2e before
    -- quoting a PASS as "no new privileged routine exists".
    when exists (select 1 from cc_schema_finding)                    then 'FAIL'
    when exists (select 1 from cc_verdict
                  where final_state not in ('LIVE_EXPECTED','INTENTIONALLY_TOMBSTONED',
                                            'EXPECTEDLY_ABSENT'))
                                                                     then 'FAIL'
    when exists (select 1 from cc_verdict
                  where (expected_state = 'LIVE') <> (final_state = 'LIVE_EXPECTED'))
                                                                     then 'FAIL'
    -- the whole mapping, not just the LIVE half: a row may only pass as the
    -- ONE outcome its expected_state calls for
    when exists (select 1 from cc_verdict
                  where final_state is distinct from
                        case expected_state
                          when 'LIVE'       then 'LIVE_EXPECTED'
                          when 'TOMBSTONED' then 'INTENTIONALLY_TOMBSTONED'
                          when 'ABSENT'     then 'EXPECTEDLY_ABSENT'
                        end)                                         then 'FAIL'
    else 'PASS'
  end
$fn$;

-- C33 — POSITIVE CONTROL on the sentence "the RESULT gate reads the schema
-- findings". That sentence was written in a source comment at section 2e while
-- nothing in the file selected from `cc_schema_finding` at all: the scanners
-- ran, their own controls passed, the findings table was populated, and the
-- verdict ignored it. A comment is not a wire. This plants a synthetic finding,
-- re-evaluates the SAME function the report calls, and requires the answer to
-- stop being PASS — then removes it and requires the answer to come back.
do $cc$
declare
  baseline text := pg_temp.cc_result();
  planted  text;
  restored text;
  probe    text := 'schema:__cc_gate_probe';
begin
  insert into cc_schema_finding(code, detail)
    values (probe, 'synthetic finding planted by C33; removed again in the same block');
  planted := pg_temp.cc_result();
  delete from cc_schema_finding where code = probe;
  restored := pg_temp.cc_result();

  insert into cc_control values ('C33_schema_findings_gate_the_result',
    planted <> 'PASS'
      -- non-vacuous whenever the run would otherwise pass: then the planted
      -- finding must be the thing that turns it FAIL, not CONTROL_FAILED
      and (baseline <> 'PASS' or planted = 'FAIL')
      and restored = baseline
      and not exists (select 1 from cc_schema_finding where code = probe),
    format('gate without a planted schema finding=%s; with one=%s; after removing '
           'it=%s; %s real finding(s) stand',
           baseline, planted, restored,
           (select count(*) from cc_schema_finding)));
end
$cc$;

-- ---------------------------------------------------------------------------
-- 7. report
-- ---------------------------------------------------------------------------
\pset format aligned
\pset tuples_only off

\echo ''
\echo '--- controls -----------------------------------------------------------'
select name, ok, detail from cc_control order by name;

\echo ''
\echo '--- tombstone coverage -------------------------------------------------'
select pg_temp.cc_cfg('tomb_names')                              as "derived tombstone set (all migrations, both mechanisms)",
       pg_temp.cc_cfg('tomb_sources')                            as "derived from",
       pg_temp.cc_cfg('tomb_postcond_names')                     as "0022 section 6 restates",
       (select string_agg(distinct proname, ',' order by proname)
          from cc_verdict)                                       as "verdicts reached for";

\echo ''
\echo '--- whole-schema counter-scan ------------------------------------------'
\echo '(complete over public in TWO dimensions only: S1 = signature + client-role'
\echo ' EXECUTE list + prosecdef + owner; S2 = SECURITY DEFINER reaching vault.*.'
\echo ' See pass_does_not_claim for what that does and does not cover.)'
select kind, cardinality(observed) as observed_n, cardinality(pinned) as pinned_n,
       array_to_string(added, ' | ')   as "not in the pin",
       array_to_string(removed, ' | ') as "pinned, not observed"
  from cc_schema_scan order by kind;

\echo ''
\echo '--- catalogue ----------------------------------------------------------'
select key, sig, owner, lang, secdef, volatility, rettype, searchpath_raw as search_path,
       overloads, shadows
  from cc_struct order by key;

\echo ''
\echo '--- privileges ---------------------------------------------------------'
select key, proacl_raw as proacl, grants_explicit, exec_inherited, exec_public
  from cc_struct order by key;

\echo ''
\echo '--- environment --------------------------------------------------------'
select (select superusers from cc_env) as superusers_now,
       (select bypassrls  from cc_env) as bypassrls_now,
       (select defacl     from cc_env) as default_acl_now,
       (select rolegraph  from cc_env) as role_graph_now;

\echo ''
\echo '--- probes -------------------------------------------------------------'
select key, kind, ran, defined, sqlstate, effect_ok, detail,
       unpriv_sqlstate as "service_role sqlstate"
  from cc_probe order by key;

\echo ''
\echo '--- classification -----------------------------------------------------'
select key, expected_state as expected, observed_state as observed,
       final_state as final, reasons
  from cc_verdict order by key;

\pset format unaligned
\pset tuples_only on

select 'CATALOGUE_CLASSIFY_CONTROL=' || name || '|' || ok || '|' || detail
  from cc_control where not ok order by name;

select 'CATALOGUE_CLASSIFY_REASON_CODE=' || code || '|' || category
  from cc_reason_registry order by code collate "C";

select 'CATALOGUE_CLASSIFY_OBJECT=' || key || '|' || expected_state || '|'
       || observed_state || '|' || final_state || '|'
       || array_to_string(reasons, ',')
  from cc_verdict order by key;

-- Run-level findings, echoed line by line so a reader of the transcript sees
-- them even without parsing the JSON, and so the shell driver can print them
-- next to the per-object verdicts. A clean run emits none of these.
select 'CATALOGUE_CLASSIFY_SCHEMA_FINDING=' || code || '|' || detail
  from cc_schema_finding order by code collate "C", detail collate "C";

select 'CATALOGUE_CLASSIFY_RESULT=' || pg_temp.cc_result();

select 'CATALOGUE_CLASSIFY_JSON=' || jsonb_build_object(
  'gate',            'dashboard-containment-gate/catalogue-classifier',
  'generation',      pg_temp.cc_cfg('generation'),
  'probe_mode',      pg_temp.cc_cfg('probe_mode'),
  'mutation_label',  pg_temp.cc_cfg('mutation_label'),
  'image_id',        pg_temp.cc_cfg('image_id'),
  'base_inputs_sha256', pg_temp.cc_cfg('base_inputs_sha256'),
  'note',            '42501 alone is never evidence of an intentional tombstone; '
                     'every INTENTIONALLY_TOMBSTONED verdict here also carries a '
                     'derived-body match, an exhaustive dynamic role scan and a '
                     'privileged P0001 probe.',
  'tombstone_source', jsonb_build_object(
      -- NOT 'supabase/migrations/0022 section 5', which is what this said while
      -- the derivation had already been widened to the whole migration set and
      -- both shim mechanisms. A provenance string that names a narrower source
      -- than the code actually read is a false claim in the report.
      'migration',      'supabase/migrations (' || pg_temp.cc_cfg('tomb_migration_count')
                        || ' file(s) scanned); shims found in '
                        || pg_temp.cc_cfg('tomb_sources'),
      'mechanisms',     pg_temp.cc_cfg('tomb_mechanisms'),
      'names',          pg_temp.cc_cfg('tomb_names'),
      'postcondition_names', pg_temp.cc_cfg('tomb_postcond_names'),
      'language',       pg_temp.cc_cfg('tomb_lang'),
      'search_path',    pg_temp.cc_cfg('tomb_searchpath'),
      'security_definer', pg_temp.cc_cfg('tomb_secdef'),
      'volatility',     pg_temp.cc_cfg('tomb_volatility'),
      'errcode',        pg_temp.cc_cfg('tomb_errcode'),
      'message_template', pg_temp.cc_cfg('tomb_msg_template'),
      'revoke_roles',   pg_temp.cc_cfg('tomb_revoke_roles'),
      'body_digest',    encode(sha256(convert_to(pg_temp.cc_cfg('tomb_body_template'), 'UTF8')), 'hex')),
  'environment',     jsonb_build_object(
      'default_acl_observed', (select defacl from cc_env),
      'default_acl_expected', (select defacl from cc_env_expect
                                where generation = pg_temp.cc_cfg('generation')),
      'superusers_observed',  (select superusers from cc_env),
      'superusers_expected',  (select superusers from cc_env_expect
                                where generation = pg_temp.cc_cfg('generation')),
      'role_graph_observed',  (select rolegraph from cc_env),
      'role_graph_expected',  (select rolegraph from cc_env_expect
                                where generation = pg_temp.cc_cfg('generation')),
      'bypassrls_observed',   (select bypassrls from cc_env),
      'bypassrls_expected',   (select bypassrls from cc_env_expect
                                where generation = pg_temp.cc_cfg('generation')),
      'roles_scanned',        (select count(*) from pg_roles)),
  -- coverage, in the report rather than only in a control, so a reader can see
  -- WHICH names were verdicted rather than trusting that all of them were.
  --
  -- THE KEY NAMES MATTER HERE. `tombstoned_by_0022` used to publish the narrow
  -- migration-0022-section-5 list, and `uncovered` was computed against that
  -- same list — so it printed [] whatever the catalogue did or did not cover,
  -- and the number a reader took for "nothing is missed" was true by
  -- construction. The published set is now the extractor's UNION over both shim
  -- mechanisms across every migration file (0017's inline shims included), it
  -- is named for what it is, its provenance travels with it, and `uncovered_*`
  -- is the difference between that INDEPENDENTLY DERIVED set and what the
  -- hand-written catalogue and the verdict pipeline actually reached.
  'coverage',        jsonb_build_object(
      'derived_tombstone_set', to_jsonb(string_to_array(pg_temp.cc_cfg('tomb_names'), ',')),
      'derived_from',         jsonb_build_object(
          'mechanisms',              pg_temp.cc_cfg('tomb_mechanisms'),
          'sources',                 pg_temp.cc_cfg('tomb_sources'),
          'names_by_source',         pg_temp.cc_cfg('tomb_names_by_source'),
          'migration_files_scanned', pg_temp.cc_cfg('tomb_migration_count'),
          'note', 'the union of both shim mechanisms over the whole migration '
                  'set, produced by extract-tombstone-template.py; NOT one '
                  'section of one file, and not a list kept in the classifier'),
      'section5_loop_names',     to_jsonb(string_to_array(pg_temp.cc_cfg('tomb_template_names'), ',')),
      'section6_restated_names', to_jsonb(string_to_array(pg_temp.cc_cfg('tomb_postcond_names'), ',')),
      'expectation_covers',   (select jsonb_agg(distinct proname) from cc_expect),
      'verdicts_reached_for', (select jsonb_agg(distinct proname) from cc_verdict),
      -- derived set MINUS what the hand-written catalogue names (C20's subject)
      'uncovered_by_expectation', to_jsonb(pg_temp.cc_minus(
                                 string_to_array(pg_temp.cc_cfg('tomb_names'), ','),
                                 (select coalesce(array_agg(distinct proname), '{}'::text[])
                                    from cc_expect))),
      -- derived set MINUS what a verdict was actually reached for (C25's)
      'uncovered_by_verdict',  to_jsonb(pg_temp.cc_minus(
                                 string_to_array(pg_temp.cc_cfg('tomb_names'), ','),
                                 (select coalesce(array_agg(distinct proname), '{}'::text[])
                                    from cc_verdict))),
      'expected_states',      (select jsonb_object_agg(proname, expected_state)
                                 from cc_expect)),
  -- DECLARED, so the driver can tell "this classifier has no counter-scan" from
  -- "this classifier claims one and produced nothing". The two used to be the
  -- same answer (fewer than two scan kinds -> harness error), which made
  -- tests/naive-oracle.sql — the straw man that models the OLD harness and
  -- performs no counter-scan on purpose — unrunnable, and took the whole
  -- "the strong classifier buys something" demonstration down with it. The
  -- shipped classifier must publish `true` here; the driver refuses a default
  -- classifier that declares itself out of the gate, so this line cannot be
  -- flipped to make a stripped build run quietly.
  -- The dependency closure, published row by row. It used to reach the report
  -- only as a reason code on owns_account, which tells a reader THAT the
  -- closure broke and nothing about which arm, which dependency or what the
  -- database actually held. The policyset arm in particular compares two long
  -- machine-built strings; a failure that does not publish both sides cannot be
  -- diagnosed from the artefact.
  'authz_closure', jsonb_build_object(
      'key', 'owns_account',
      'rows', (select jsonb_agg(jsonb_build_object(
                   'kind', d.dep_kind, 'dependency', d.dep_id, 'property', d.prop,
                   'expected', d.expected, 'observed', d.observed, 'ok', d.ok)
                 order by d.dep_kind collate "C", d.dep_id collate "C", d.prop collate "C")
                 from cc_dep_obs d),
      'policyset_pin_plaintext', (
          select jsonb_agg(jsonb_build_object(
                   'table', p.tbl, 'policy', p.polname, 'command', p.cmd,
                   'permissive', p.permissive, 'roles', p.roles,
                   'using', p.qual, 'with_check', p.withcheck)
                 order by p.tbl collate "C", p.polname collate "C")
            from cc_policyset_pin p
           where p.generation = pg_temp.cc_cfg('generation')),
      'policyset_tables_pinned', (
          select jsonb_agg(t.tbl order by t.tbl collate "C")
            from cc_policyset_table t
           where t.generation = pg_temp.cc_cfg('generation')),
      -- ADV-2(F). The plaintext pin for the dependent-relation arm, published
      -- for the same reason the policy pin is: the comparison is a digest, and
      -- a digest is not reviewable by reading. On generation `latest` these
      -- three views ARE the client read path for accounts / cash_flows /
      -- trades, and the `using` line below is the entire tenant boundary on it.
      'dependent_view_pin_plaintext', (
          select jsonb_agg(jsonb_build_object(
                   'guarded_table', v.tbl, 'relation', v.viewrel,
                   'relkind', v.relkind, 'owner', v.owner, 'options', v.opts,
                   'grants', v.grants, 'definition', v.viewdef)
                 order by v.tbl collate "C", v.viewrel collate "C")
            from cc_depview_pin v
           where v.generation = pg_temp.cc_cfg('generation')),
      -- R5-DOC1. The scope of the closure, as a DERIVED list rather than a
      -- number somebody counted. `outside_closure_policy_bearing` is every
      -- table in `public` that carries at least one policy, is SELECT-able by
      -- a client role, and is NOT in this closure — i.e. every table whose
      -- policy set this file does not pin. C39 proves the two sets are
      -- disjoint; the mutation suite requires CATALOGUE-CLASSIFIER.md to name
      -- exactly this list, because the document and this array said two and
      -- seven at the same time and only one of them could be right.
      'closure_tables_pinned', to_jsonb(
          (select coalesce(array_agg(t.tbl order by t.tbl collate "C"), '{}'::text[])
             from cc_policyset_table t
            where t.generation = pg_temp.cc_cfg('generation'))),
      'outside_closure_policy_bearing',
          to_jsonb(pg_temp.cc_outside_closure_readable()),
      'outside_closure_policy_bearing_count',
          cardinality(pg_temp.cc_outside_closure_readable())),
  'counter_scan_declared', true,
  -- The whole-schema counter-scan, published whether or not it found anything,
  -- so a reader can see it RAN and against what. `findings` non-empty is FAIL.
  'schema_scan',     jsonb_build_object(
      'client_roles_measured', to_jsonb(pg_temp.cc_client_roles()),
      'kinds', (select jsonb_agg(jsonb_build_object(
                    'kind',     s.kind,
                    'observed', to_jsonb(s.observed),
                    'pinned',   to_jsonb(s.pinned),
                    'added',    to_jsonb(s.added),
                    'removed',  to_jsonb(s.removed)) order by s.kind)
                  from cc_schema_scan s),
      'findings', coalesce((select jsonb_agg(jsonb_build_object('code', f.code, 'detail', f.detail)
                                             order by f.code collate "C")
                              from cc_schema_finding f), '[]'::jsonb)),
  -- SCOPE, in machine-readable form, so a downstream reader cannot round a
  -- PASS up into a claim this file never made. Every entry here is a residual
  -- limit of the MECHANISM, not a defect waiting to be fixed by a longer list.
  'pass_does_not_claim', jsonb_build_array(
      'that no NEW privileged object exists. The counter-scan is complete over '
      || 'public in exactly two dimensions and in no others: S1 pins, for every '
      || 'routine a client role can EXECUTE, the signature, the exact role list, '
      || 'prosecdef and the owner; S2 pins the SECURITY DEFINER routines '
      || 'reaching vault.*. Because prosecdef and the owner are in S1, an '
      || 'EXISTING client-executable signature repurposed into SECURITY DEFINER '
      || 'or reowned is a finding, not only a NEW one. Still outside it: a '
      || 'privileged routine in another schema; one privileged for a non-vault '
      || 'reason that is neither SECURITY DEFINER nor reowned — i.e. a SECURITY '
      || 'INVOKER body rewrite, which runs in the caller''s row-security '
      || 'context and so cannot read past the caller''s own RLS; and a '
      || 'view/trigger/FDW rather than a routine.',
      'that the tombstone set is complete beyond the two shim mechanisms the '
      || 'extractor recognises (an inline create-or-replace whose whole body is '
      || 'a raise, and the 0022 format() loop). A third mechanism would be '
      || 'derived by neither, and neither C20 nor coverage.uncovered_* would '
      || 'notice, because both are computed FROM that derivation.',
      'that owns_account is safe beyond its pinned body, its pinned dependency '
      || 'closure and its nine probes. The closure is pinned by name and digest; '
      || 'a rewrite of something outside the pinned closure that still changes '
      || 'the answer is not modelled. Three residual limits of THAT mechanism, '
      || 'stated so a PASS cannot be rounded up: it is ONE LEVEL DEEP — the '
      || 'body digest of auth.uid() is pinned, the definitions of whatever '
      || 'auth.uid() itself calls are not; it exists for owns_account ONLY, so '
      || 'no other catalogued routine has a dependency closure at all; and its '
      || 'function/relation arms are derived from the UNION of the pinned body '
      || 'text and the pinned POLICY EXPRESSIONS (C27/C28) — the union rather '
      || 'than the body alone, because the tenant boundary is the policies as '
      || 'much as the predicate they call; measured on both generations the '
      || 'union adds nothing today, but only because owns_account happens to '
      || 'call auth.uid() too, so this makes a load-bearing coincidence into a '
      || 'consequence — '
      || 'while its rls/policy/policyset arms cannot be derived at all — which tables the '
      || 'predicate guards is not visible in the predicate — so those are '
      || 'written out per generation and kept honest by C34 and C35 comparing '
      || 'the TABLE LIST against the set pg_policy produces, not by derivation '
      || 'from the routine. What the policyset arm does close (ADV-1) is the '
      || 'shape where the pinned policy is intact and irrelevant: the COMPLETE '
      || 'policy set of every table in the closure is pinned by count, name, '
      || 'command, permissive/restrictive, role list and expression digest, so '
      || 'a second permissive policy beside the expected one is a finding. What '
      || 'it does NOT close: a permissive policy on a public table that is NOT '
      || 'in this closure is outside the pin, because this closure is '
      || 'owns_account''s and those tables do not route through it. That set is '
      || 'DERIVED, not counted by hand, and published in this report as '
      || 'authz_closure.outside_closure_policy_bearing; on this generation it '
      || 'has '
      || cardinality(pg_temp.cc_outside_closure_readable())::text
      || ' member(s): '
      || coalesce(nullif((select string_agg(split_part(o, '/', 1), ', ' order by o collate "C")
                            from unnest(pg_temp.cc_outside_closure_readable()) o), ''), '<none>')
      || '. A whole-schema policy pin would be a different '
      || 'control from a different premise and this file does not have one.',
      -- ADV-2. The mechanisms that make an RLS policy ineffective WITHOUT
      -- changing the policy, enumerated, each labelled pinned or not pinned.
      -- The first four were each MEASURED as a live cross-tenant read under a
      -- PASS before this round; a bullet that only listed the two an auditor
      -- named would be the same "subset reporting itself whole" this directory
      -- keeps finding.
      'that RLS being ENABLED means the policy decides anything. Enabled is '
      || 'necessary, not sufficient. PostgreSQL offers these ways to make a '
      || 'policy ineffective without editing it, and this is which of them this '
      || 'file pins. PINNED, per table in the closure, as dep:guarded_table_'
      || 'exposed: (1) the table OWNER, because an owner is exempt from its own '
      || 'policies unless FORCE ROW LEVEL SECURITY is set; (2) FORCE ROW LEVEL '
      || 'SECURITY itself, pinned at its MEASURED value, which is OFF on every '
      || 'table in this schema — so the owner pin is the load-bearing half of '
      || 'that pair, and this row exists so that turning FORCE on, or later off '
      || 'again, both require a deliberate re-pin; (3) relkind, so the table '
      || 'cannot be swapped for a view; (4) every pg_inherits edge, in both '
      || 'directions, because a query against an inheritance or partition '
      || 'PARENT applies the PARENT''s policies to the child''s rows; (5) every '
      || 'view or materialised view whose rewrite rule reads the table, pinned '
      || 'by relkind, owner, reloptions (security_invoker/barrier live there), '
      || 'grant list and definition digest, because a view runs in the VIEW '
      || 'OWNER''s row-security context unless it is security_invoker — on '
      || 'generation latest the client''s only read path to accounts, '
      || 'cash_flows and trades is three such views owned by postgres, which '
      || 'carries BYPASSRLS, and their WHERE clause is the entire tenant '
      || 'boundary on that path. PINNED cluster-wide, as env:bypassrls_set_'
      || 'drift: (6) the set of roles carrying the BYPASSRLS attribute, which '
      || 'is neither superuser nor a membership and so moved neither of the '
      || 'other two environment fingerprints. Already pinned elsewhere: the '
      || 'superuser set (env:superuser_set_drift), the role-membership graph '
      || '(env:role_membership_drift) and relrowsecurity (dep:rls_disabled). '
      || 'MEASURED AND NOT A BYPASS, so deliberately not pinned: '
      || 'row_security=off set on a role — a non-exempt role still gets the '
      || 'policy applied; membership in pg_read_all_data, which grants SELECT '
      || 'everywhere but does NOT carry BYPASSRLS (both measured at 0 rows for '
      || 'the attacker on this fixture; the membership would move the role '
      || 'graph in any case); and a table-level GRANT on a guarded table, '
      || 'measured twice — `grant select on public.accounts to authenticated` '
      || 'returns 0 rows because RLS is on with no policy, and `grant select '
      || 'on public.positions to anon` makes anon fail closed with "permission '
      || 'denied for function owns_account". A SELECT privilege is not a row. '
      || 'COLUMN-LEVEL grants are the same answer and were measured separately '
      || 'because they are a different catalogue column: `grant select '
      || '(equity, snapshot_date, account_id) on public.equity_snapshots to '
      || 'authenticated` puts an attacl on three pg_attribute rows and returns '
      || '0 rows to the attacker, selecting the granted columns alone included. '
      || 'RLS filters rows before column privileges are consulted, so this is a '
      || 'completeness note, not a gap. '
      || 'ALSO MEASURED: an ON SELECT rule cannot be added to an existing '
      || 'table at all (PostgreSQL: "relation cannot have ON SELECT rules"), '
      || 'so the only way one relation can read another is to BE a view or a '
      || 'materialised view, and pg_depend records every one of those. NOT '
      || 'PINNED, and each of these can still '
      || 'expose a guarded row under a PASS: a view, inheritance edge or '
      || 'permissive policy attached to a public table OUTSIDE this closure, '
      || 'including cash_flows and trades as BASE tables on generation latest; '
      || 'a second-hop view reached only through such a table; a SECURITY '
      || 'DEFINER routine in ANOTHER SCHEMA that reads a guarded table (in '
      || 'public the counter-scan now sees both a NEW client-executable '
      || 'signature and an EXISTING one repurposed into SECURITY DEFINER or '
      || 'reowned, because prosecdef and the owner are in the S1 descriptor; '
      || 'what it does not see there is a SECURITY INVOKER body rewrite, which '
      || 'cannot read past its caller''s RLS); a trigger that copies guarded '
      || 'rows into an unguarded one; a foreign table, dblink or logical-'
      || 'replication slot reading the same data out of band; value leakage '
      || 'through a non-leakproof function in a qual; '
      || 'A PLAIN DATA COPY — `create table public.cc_copy as select * from '
      || 'public.equity_snapshots` followed by a grant. MEASURED: the run is '
      || 'PASS with every control green, no findings and no closure row moved, '
      || 'and the attacker read all 21 of the victim''s rows out of the copy. There is '
      || 'NO pg_depend edge between the copy and the source — measured at zero '
      || 'in both directions — so no dependency walk from a guarded table can '
      || 'reach it, and its detection is INHERENTLY HARD for a catalogue '
      || 'classifier: what makes those rows sensitive is their content, which '
      || 'the catalogue does not describe. Only a data-level control (content '
      || 'comparison, or an allowlist of tables permitted to exist at all) '
      || 'would see it; '
      || 'and A FOREIGN KEY from a client-writable table to a guarded table. '
      || 'PostgreSQL runs referential-integrity checks with the REFERENCED '
      || 'table''s owner privileges, which its documentation states bypasses '
      || 'row security. MEASURED as a working existence oracle over another '
      || 'tenant''s primary keys: with `snap bigint references '
      || 'public.equity_snapshots(id)` on a table the attacker may INSERT into, '
      || 'key 1 is ACCEPTED and key 999999 is refused with the detail line '
      || '"Key is not present in table equity_snapshots", while the same '
      || 'attacker reads 0 rows '
      || 'from equity_snapshots directly and the run is PASS. Unlike the data '
      || 'copy this one IS recorded in pg_depend, as a pg_constraint row, so it '
      || 'is closable by walking inbound foreign keys — this file does not, '
      || 'because its dependent-relation observer walks pg_rewrite only. '
      || 'Closing any of those needs a '
      || 'whole-schema exposure model, which is a different control from a '
      || 'different premise, and this file does not have one.',
      'that the counter-scan declaration is anything but a SELF-REPORT. This '
      || 'report says counter_scan_declared=true and publishes schema_scan.kinds; '
      || 'the driver refuses a classifier that declares nothing, refuses one that '
      || 'declares true and produced fewer than two scan kinds, and refuses the '
      || 'shipped classifier declaring false. It cannot detect a classifier that '
      || 'declares true and fabricates two scan kinds — the subject writes the '
      || 'report. That is inherent to any self-describing artefact and is not '
      || 'closed by a stricter declaration; what bounds it is that the shipped '
      || 'classifier is the one under review and its scanners carry C30-C33.',
      'anything at all about runtime behaviour. This is a static classification '
      || 'of one disposable clone of one schema generation. It is not evidence '
      || 'about the deployed database, and it is not the runtime canary.',
      'that a PASS on generation 0008 says anything about generation latest, or '
      || 'the reverse. Each run classifies exactly the generation named in '
      || 'this report.'),
  'reason_registry', (select jsonb_agg(jsonb_build_object('code', code, 'category', category,
                                                          'note', note)
                                       order by code collate "C") from cc_reason_registry),
  'controls',        (select jsonb_agg(jsonb_build_object('name', name, 'ok', ok, 'detail', detail)
                                       order by name) from cc_control),
  'objects',         (select jsonb_agg(jsonb_build_object(
                        'key',              key,
                        'signature',        sig,
                        'expected',         expected_state,
                        'observed',         observed_state,
                        'final',            final_state,
                        'reasons',          to_jsonb(reasons),
                        'structural_misses', to_jsonb(structural_misses),
                        'env_misses',       to_jsonb(env_misses),
                        'live_misses',      to_jsonb(live_misses),
                        'tomb_misses',      to_jsonb(tomb_misses),
                        'tomb_applicable',  tomb_applicable,
                        'owner',            owner,
                        'language',         lang,
                        'security_definer', secdef,
                        'volatility',       volatility,
                        'return_type',      rettype,
                        'arguments',        args,
                        'search_path',      searchpath_raw,
                        'proacl',           proacl_raw,
                        'proacl_is_null',   proacl_is_null,
                        'grants_explicit',  to_jsonb(grants_explicit),
                        'grants_effective', to_jsonb(grants_effective),
                        'exec_inherited',   to_jsonb(exec_inherited),
                        'exec_assumable',   to_jsonb(exec_assumable),
                        'exec_public',      exec_public,
                        'exec_unexpected_live', to_jsonb(live_exec_extra),
                        'exec_unexpected_tomb', to_jsonb(tomb_exec_extra),
                        'exec_missing_live',    to_jsonb(live_exec_lost),
                        'exec_missing_tomb',    to_jsonb(tomb_exec_lost),
                        'exec_assumable_extra_live', to_jsonb(live_assume_extra),
                        'exec_assumable_extra_tomb', to_jsonb(tomb_assume_extra),
                        'sibling_executable', to_jsonb(sibling_exec),
                        'overloads',        overloads,
                        'shadow_schemas',   shadow_schemas,
                        'body_normalised',  body_norm,
                        'body_sha256_observed',
                            case when body_norm is null then null
                                 else encode(sha256(convert_to(body_norm, 'UTF8')), 'hex') end,
                        'body_sha256_pinned', live_body_sha256,
                        'body_matches_pin',   live_body_ok,
                        'probe',            jsonb_build_object(
                            'kind',      probe_kind,
                            'ran',       probe_ran,
                            'defined',   probe_is_defined,
                            'sqlstate',  probe_sqlstate,
                            'message',   probe_message,
                            'effect_ok', probe_effect_ok,
                            'detail',    probe_detail,
                            'service_role_sqlstate', unpriv_sqlstate,
                            'service_role_message',  unpriv_message))
                        order by key) from cc_verdict),
  -- the SAME function the CATALOGUE_CLASSIFY_RESULT line publishes, so the two
  -- cannot disagree and a clause cannot be added to one copy only
  'result',          pg_temp.cc_result()
)::text;
