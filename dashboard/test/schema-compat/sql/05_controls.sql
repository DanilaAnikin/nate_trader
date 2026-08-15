-- ===========================================================================
-- 05_controls.sql — the negative control for the catalogue check itself
--
-- A check that cannot fail is worse than no check. Before the real route
-- surface is judged, the same query in 20_check.sql is pointed at four objects
-- with known answers: two that must be reported PRESENT and two that cannot
-- possibly exist. run.sh asserts the exact expected verdict string, not merely
-- "some failure occurred". If a future edit turns the check into a tautology,
-- this fails first and the run stops before it can report a false pass.
-- ===========================================================================

create temporary table wanted(obj_name text, obj_kind text, used_by text, req_roles text);

insert into wanted(obj_name, obj_kind, used_by, req_roles) values
  ('accounts',                   'relation', 'control:must-be-PRESENT', 'service_role'),
  ('owns_account',               'function', 'control:must-be-PRESENT', 'service_role'),
  ('__nt_absent_probe_relation', 'relation', 'control:must-be-ABSENT',  'service_role'),
  ('__nt_absent_probe_function', 'function', 'control:must-be-ABSENT',  'service_role');
