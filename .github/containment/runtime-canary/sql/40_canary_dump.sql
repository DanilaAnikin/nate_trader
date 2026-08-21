-- ===========================================================================
-- 40_canary_dump.sql — what the sensor saw, as machine-readable lines
--
-- Two readings, deliberately separate:
--
--   NT_CANARY_HIT_<fn>=<n>   the rollback-proof sequence counter. This is the
--                            number the verdict uses, because it survives the
--                            exception the wrapper raises.
--   NT_CANARY_ROW=...        one line per committed detail row, carrying the
--                            matrix cell the recording sink tagged it with, so
--                            a hit is attributed to a cell rather than matched
--                            to one by clock.
--
-- The two can legitimately disagree: on the latest schema a call is counted
-- and then rolled back, so the counter moves while no row appears. A verdict
-- that only read the rows would call that "no call".
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

select 'NT_CANARY_HIT_' || fn || '=' || hits::text from nt_canary.hits() order by 1;

select 'NT_CANARY_ROW=' ||
       seq::text || '|' ||
       to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '|' ||
       fn || '|' ||
       coalesce(cell, '-') || '|' ||
       coalesce(role_guc, '-') || '|' ||
       session_user_name || '|' ||
       coalesce(host(client_addr), '-') || '|' ||
       replace(args::text, '|', '/')
  from nt_canary.calls
 order by seq;

select 'NT_CANARY_ROWCOUNT=' || count(*)::text from nt_canary.calls;
select 'NT_CANARY_ARMED_FINAL=' || nt_canary.assert_armed();
