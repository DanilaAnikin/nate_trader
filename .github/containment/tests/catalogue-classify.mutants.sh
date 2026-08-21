#!/usr/bin/env bash
# ============================================================================
# catalogue-classify.mutants.sh — the falsification suite for the catalogue
# classifier.
#
# A classifier is only worth its verdict if a wrong catalogue makes it say so,
# and a SUITE is only worth its verdict if deleting a check makes IT say so.
# This file therefore does three things:
#
#   1. runs the classifier against the two pristine generations, which must
#      both be GREEN, and against every mutant below, each on a FRESH clone
#      built from the cached base image and destroyed afterwards, each of which
#      must be RED with an EXACT final state and EXACT reason codes — never
#      merely "something failed";
#
#   2. asserts REASON-CODE COVERAGE. Every code the classifier can emit is
#      declared in its registry; this suite requires each one to be required by
#      at least one mutant, or to be declared unreachable here with a written
#      justification that the suite verifies. An unasserted check is a check
#      that can be deleted in silence, and that is exactly what this assertion
#      exists to prevent;
#
#   3. re-runs everything against tests/naive-oracle.sql, the name-only /
#      bare-42501 straw man, and requires the suite to go RED with exactly the
#      frozen set of mutants that straw man cannot see. That is the
#      demonstration that the classifier's strength is load-bearing rather than
#      decorative.
#
# Usage:
#   catalogue-classify.mutants.sh [--oracle real|naive|both] [--only ID[,ID...]]
#                                 [--keep-work]
#
# Exit codes:
#   0  suite green
#   1  suite red
#   2  harness error (including an --only that selects nothing)
#   3  a control misbehaved; the suite cannot be trusted this run
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly CONTAINMENT="$(cd "${HERE}/.." && pwd)"
readonly REPO="$(cd "${CONTAINMENT}/../.." && pwd)"
readonly DRIVER="${CONTAINMENT}/catalogue-classify.sh"
readonly EXTRACTOR="${CONTAINMENT}/extract-tombstone-template.py"
readonly REAL_ORACLE="${CONTAINMENT}/catalogue-classify.sql"
readonly NAIVE_ORACLE="${HERE}/naive-oracle.sql"
# The extractor derives the tombstone contract from the WHOLE migration set,
# because a section-scoped derivation reported itself whole: migration 0022
# also tombstones resolve_create_operation(uuid,uuid) INLINE, and 0017
# tombstones two more, and none of those three carried an expectation row. So
# the unit this suite hands it is the DIRECTORY. TOMB_BASENAME survives only
# for `--emit-tombstone-do`, which slices section 5 out of one named file.
readonly MIGRATIONS_DIR="${REPO}/supabase/migrations"
readonly TOMB_BASENAME="0022_fingerprint_binding_and_token_generations.sql"
readonly TOMB_MIGRATION="${MIGRATIONS_DIR}/${TOMB_BASENAME}"

readonly EXIT_RED=1
readonly EXIT_HARNESS=2
readonly EXIT_CONTROL=3

# The mutants the name-only / bare-42501 straw man cannot see. Frozen from a
# measured run: a change to this set is a change to the demonstration and must
# be looked at, not absorbed.
# The two it DOES see, 01 and 23, are the two where the name itself vanishes
# from pg_proc: a dropped function, and a name taken over by a table. That is
# the entire reach of a name-only check.
# 60-65 join it for a reason worth stating: the straw man DOES enumerate
# owns_account and DOES get an answer out of it, and every one of those six
# mutations leaves that answer correct. Being blind to them is not a matter of
# not knowing the name. 64 and 65 are the sharpest of the six: owns_account is
# byte-identical, correctly owned, correctly granted, and answers false for a
# non-owner, while the table it is supposed to guard is world-readable.
# 66-72 (ADV-2) are sharper still, and they were blind to the STRONG classifier
# too until the round that added the `guarded` arm: RLS stays enabled, the policy
# set stays byte-identical, owns_account stays correct, and the rows come out
# through the table's owner, an inheritance parent, a view, or a role attribute.
# 75 (R5) joins them and is measured, not assumed: it replaces a guarded TABLE
# with a VIEW over an unguarded copy. The straw man enumerates owns_account,
# calls it, and gets the right answer — the routine is untouched — while the
# table it guards is no longer a table. This pin is re-recorded DELIBERATELY
# here, in the same change that added the mutant; the frozen-set comparison
# refused the run until it was, which is the pin working.
#
# NOT here, and worth saying so: 52-59 are excluded from the straw-man run
# altogether (NAIVE_UNADDRESSABLE) because it does not enumerate those objects
# at all, and 70/73/74 are run-level counter-scan cells that produce no
# per-object row for either classifier.
readonly NAIVE_BLIND_EXPECTED="02,03,04,05,06,07,08,09,10,11,12,13,14,15,16,16b,17,18,18b,18c,19,19b,20,20b,21,22,24,24b,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,60,61,62,63,64,65,66,67,68,69,71,72,75"

ORACLE=both
ONLY=""
KEEP_WORK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --oracle)    ORACLE="${2:?--oracle needs a value}"; shift 2 ;;
    --only)      ONLY="${2:?--only needs a value}"; shift 2 ;;
    --keep-work) KEEP_WORK=1; shift ;;
    -h|--help)   sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit "$EXIT_HARNESS" ;;
  esac
done
case "$ORACLE" in real|naive|both) ;; *)
  printf -- '--oracle must be real, naive or both\n' >&2; exit "$EXIT_HARNESS" ;;
esac

# ---------------------------------------------------------------------------
# IS THIS RUN A CERTIFICATION?
#
# It used to be impossible to tell from the output. `--only 01` ran ONE of the
# 69 declared mutants, skipped the coverage assertions and their red-before,
# skipped schema mutant 70, skipped the C34 falsification, and did not assert
# the straw man's frozen blind set — and then printed, verbatim and
# unqualified:
#
#     green the classifier is green on both pristine schemas, RED on every
#           mutant with the exact state and the exact reason codes ...
#     SUITE GREEN
#
# exit 0. "RED on every mutant" over one mutant. That is the same defect
# run-all.sh closed as B8(iii) — "a skipped attack is not a passed attack" —
# sitting unfixed in the sibling suite, and it is the defect the naive oracle's
# own `counter_scan_declared: false` labelling exists to prevent one level down.
#
# `--only` and a single `--oracle` are legitimate developer conveniences, so
# they are NOT errors — they are this suite's `--allow-skips`. What they must
# not do is produce a sentence that claims the whole suite passed. So every
# site that skips an assertion RECORDS it here, and the verdict refuses to
# print the certification text while anything is recorded, printing instead a
# banner naming exactly what did not run.
#
# The counts in that banner are MEASURED from the results file, never from the
# loop that was supposed to write it: a count taken from the same variable that
# drove the loop cannot detect the loop not running.
# ---------------------------------------------------------------------------
NOT_CERTIFYING=()
uncertify() { NOT_CERTIFYING+=("$1"); }

[[ -z "$ONLY" ]] || uncertify "--only ${ONLY}: only the named mutants ran"
if [[ "$ORACLE" != both ]]; then
  uncertify "--oracle ${ORACLE}: the other oracle did not run$(
    [[ "$ORACLE" == real ]] \
      && printf ', so the straw-man demonstration that the classifier'"'"'s strength is load-bearing did not happen' \
      || printf ', so the real classifier was not exercised at all')"
fi

WORK="$(mktemp -d)"
cleanup() {
  local rc=$?
  if [[ "$KEEP_WORK" -eq 1 ]]; then printf '\nwork dir kept: %s\n' "$WORK"
  else rm -rf "$WORK"; fi
  exit "$rc"
}
trap cleanup EXIT

hdr()  { printf '\n\033[1m########## %s\033[0m\n' "$*"; }
log()  { printf '\n\033[1m-- %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
bad()  { printf '   \033[1;31mRED \033[0m %s\n' "$*"; }
good() { printf '   \033[1;32mgreen\033[0m %s\n' "$*"; }

for f in "$DRIVER" "$EXTRACTOR" "$REAL_ORACLE" "$NAIVE_ORACLE" "$TOMB_MIGRATION"; do
  [[ -f "$f" ]] || { printf 'missing: %s\n' "$f" >&2; exit "$EXIT_HARNESS"; }
done
[[ -d "$MIGRATIONS_DIR" ]] || {
  printf 'missing migrations directory: %s\n' "$MIGRATIONS_DIR" >&2
  exit "$EXIT_HARNESS"; }

# ---------------------------------------------------------------------------
# 0. controls on the extractor — before any verdict depends on what it derives
# ---------------------------------------------------------------------------
hdr "0. controls on the tombstone extractor"

log "0a. positive control — the real migration set yields the real contract"
if ! python3 "$EXTRACTOR" "$MIGRATIONS_DIR" > "$WORK/tomb.env" 2> "$WORK/tomb.err"; then
  bad "the extractor failed on the real migration set ${MIGRATIONS_DIR}"
  cat "$WORK/tomb.err" >&2
  exit "$EXIT_CONTROL"
fi
if ! grep -q "^NT_CC_TOMB_ERRCODE=P0001$" "$WORK/tomb.env"; then
  bad "the extractor did not derive errcode P0001 from migration 0022"
  cat "$WORK/tomb.env" >&2; exit "$EXIT_CONTROL"
fi
if ! grep -q "superseded and must not be called" "$WORK/tomb.env"; then
  bad "the extractor did not derive the superseded message"; exit "$EXIT_CONTROL"
fi
good "extractor derives P0001 and the superseded message from the migration set"

# A DISPOSABLE COPY of the whole migration set. supabase/migrations itself is
# never written to. Every negative control below doctors this copy, so the
# refusal it asserts can only have come from the doctoring — which is only true
# if the UNDOCTORED copy is accepted and derives exactly what the real tree
# does. That is asserted here, once, before any doctoring.
PRISTINE_MIG="$WORK/mig-pristine"
mkdir -p "$PRISTINE_MIG"
cp "$MIGRATIONS_DIR"/*.sql "$PRISTINE_MIG/"
if ! python3 "$EXTRACTOR" "$PRISTINE_MIG" > "$WORK/tomb-copy.env" 2> "$WORK/tomb-copy.err"; then
  bad "the extractor refused the UNDOCTORED copy of the migration set; every"
  bad "negative control below would then prove nothing about its doctoring"
  cat "$WORK/tomb-copy.err" >&2; exit "$EXIT_CONTROL"
fi
for k in NT_CC_TOMB_NAMES NT_CC_TOMB_MECHANISMS NT_CC_TOMB_SIGS \
         NT_CC_TOMB_TEMPLATE_NAMES NT_CC_TOMB_POSTCOND_NAMES; do
  if [[ "$(grep "^${k}=" "$WORK/tomb.env")" != "$(grep "^${k}=" "$WORK/tomb-copy.env")" ]]; then
    bad "the disposable copy derives a different ${k} than the real tree:"
    bad "  real: $(grep "^${k}=" "$WORK/tomb.env")"
    bad "  copy: $(grep "^${k}=" "$WORK/tomb-copy.env")"
    exit "$EXIT_CONTROL"
  fi
done
good "the disposable migration copy derives the same contract as the real tree"

# Each doctored copy must fail with ONE named error, not merely non-zero.
# "the extractor exited 2" would also be satisfied by a typo in the extractor.
# The doctoring script edits ONE file inside a fresh copy of the whole set; the
# extractor is then pointed at the DIRECTORY, which is the only shape it takes.
doctor_control() {  # tag, doctoring script, exact expected stderr fragment
  local tag="$1" script="$2" want="$3" rc
  local dir="$WORK/mig-${tag}"
  rm -rf "$dir"; cp -r "$PRISTINE_MIG" "$dir"
  python3 "$script" "$PRISTINE_MIG/$TOMB_BASENAME" "$dir/$TOMB_BASENAME"
  if cmp -s "$PRISTINE_MIG/$TOMB_BASENAME" "$dir/$TOMB_BASENAME"; then
    bad "control ${tag}: the doctoring script changed nothing"
    return 1
  fi
  set +e
  python3 "$EXTRACTOR" "$dir" \
    > "$WORK/doctored-${tag}.out" 2> "$WORK/doctored-${tag}.err"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    bad "control ${tag}: the extractor ACCEPTED a doctored migration 0022"
    return 1
  fi
  if [[ "$rc" -ne 2 ]]; then
    bad "control ${tag}: extractor exited ${rc}; its documented refusal code is 2"
    cat "$WORK/doctored-${tag}.err" >&2
    return 1
  fi
  if ! grep -F -q "$want" "$WORK/doctored-${tag}.err"; then
    bad "control ${tag}: refused, but NOT with the exact expected failure class"
    bad "  wanted fragment: ${want}"
    bad "  got            : $(tr -d '\n' < "$WORK/doctored-${tag}.err")"
    return 1
  fi
  good "control ${tag}: refused with the exact expected error — ${want}"
  return 0
}

cat > "$WORK/doctor-remove.py" <<'DOCTOR'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
out, n = re.subn(r"\$fn\$.*?\$fn\$", "'-- template removed by the suite control'",
                 src, flags=re.S)
assert n == 1, "expected exactly one template to remove, removed %d" % n
open(sys.argv[2], "w", encoding="utf-8").write(out)
DOCTOR

cat > "$WORK/doctor-duplicate.py" <<'DOCTOR'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"\$fn\$.*?\$fn\$", src, re.S)
assert m, "no template to duplicate"
out = (src[:m.end()] + "\n-- suite control: a second, conflicting template\n"
       + m.group(0) + src[m.end():])
open(sys.argv[2], "w", encoding="utf-8").write(out)
DOCTOR

cat > "$WORK/doctor-errcode.py" <<'DOCTOR'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
# Only inside the $fn$ template: the migration raises P0001 in several other
# places and doctoring one of those would test nothing.
m = re.search(r"\$fn\$.*?\$fn\$", src, re.S)
assert m, "no template found"
tpl = m.group(0)
assert tpl.count("using errcode = 'P0001';") == 1, tpl.count("using errcode = 'P0001';")
out = src[:m.start()] + tpl.replace("using errcode = 'P0001';",
                                    "using errcode = 'nope!';") + src[m.end():]
open(sys.argv[2], "w", encoding="utf-8").write(out)
DOCTOR

ctl_ok=1
log "0b. negative control — the tombstone template removed"
# The refusal here is the TEMPLATE arm's non-vacuity floor, not "the marker
# string is missing": with the whole set scanned, 0017's and 0022's inline
# shims are still found, so what the extractor must notice is that one of the
# union's two arms went empty.
doctor_control remove "$WORK/doctor-remove.py" \
  'the `template` mechanism found no `do $$ ... $fn$ ... $$` tombstone loop' || ctl_ok=0

log "0c. negative control — a second, conflicting template"
doctor_control duplicate "$WORK/doctor-duplicate.py" \
  'expected exactly one $fn$...$fn$ template, found 2' || ctl_ok=0

log "0d. negative control — the SQLSTATE literal is not a SQLSTATE"
# The refusal now NAMES the target whose SQLSTATE is malformed, because the
# errcode check is per derived target rather than one check on the template.
doctor_control errcode "$WORK/doctor-errcode.py" \
  "errcode 'nope!' for create_account_atomic is not a 5-character SQLSTATE" || ctl_ok=0

# 0e/0f are the controls behind F1's real repair. The classifier's coverage
# assertion is only as complete as the name list it derives, and that list came
# from ONE statement in migration 0022. The extractor now reads the SAME set
# from 0022's section-6 post-condition as well and refuses when the two
# disagree. These two controls plant exactly that disagreement.

cat > "$WORK/doctor-drop-name.py" <<'DOCTOR'
import sys
src = open(sys.argv[1], encoding="utf-8").read()
needle = "'create_account_atomic',"
# only the FIRST occurrence, which is section 5's tombstone loop; section 6's
# restatement is left intact so the two lists disagree
i = src.index(needle)
out = src[:i] + src[i + len(needle):]
assert out.count("'create_account_atomic'") >= 1, "section 6's copy was removed too"
open(sys.argv[2], "w", encoding="utf-8").write(out)
DOCTOR

cat > "$WORK/doctor-drop-postcond.py" <<'DOCTOR'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
marker = "superseded routines are still executable"
at = src.index(marker)
lists = list(re.finditer(r"p\.proname\s+in\s*\((.*?)\)", src[:at], re.S))
assert len(lists) >= 2, "expected section 5 and section 6 to state the set"
m = lists[-1]
out = src[:m.start()] + "true /* post-condition name list removed by the suite control */" \
      + src[m.end():]
open(sys.argv[2], "w", encoding="utf-8").write(out)
DOCTOR

log "0e. negative control — 0022's two statements of the tombstone set disagree"
doctor_control drop-name "$WORK/doctor-drop-name.py" \
  "migration 0022 states its tombstone set twice and the two disagree" || ctl_ok=0

log "0f. negative control — the post-condition no longer restates the set"
doctor_control drop-postcond "$WORK/doctor-drop-postcond.py" \
  "list(s) precede the post-condition marker" || ctl_ok=0

# POSITIVE control on the derived name set. Two failures are frozen into it,
# both measured rather than imagined:
#
#   * requiring only the three vault wrappers is what let the classifier's
#     expectation catalogue carry four of five names with nothing noticing;
#   * requiring only migration 0022 SECTION 5 is what let
#     resolve_create_operation(uuid,uuid) — tombstoned INLINE sixty lines above
#     the loop, with a different message — be granted to anon and revived to
#     0021's SECURITY DEFINER body under a clean PASS. 0017 tombstones two more
#     the same way.
#
# So the set is pinned EXACTLY, in both directions, and the pin is per source
# file. A change to it is a change to the contract and must be looked at.
#
# The three names in TOMB_FALSE_POSITIVES are the ones a weaker parser really
# did produce on the way here: `is superseded` matched inside a COMMENT
# (begin_account_verification); a body sliced to the next `create or replace`
# absorbed section 5's DO block and attributed its format() string to the
# preceding function (audit_log_detail_guard, the guard that ARMS the audit
# rules); and finish_account_verification raises `... was superseded by a later
# verification` in the middle of a long LIVE body. None may be derived.
readonly TOMB_EXPECTED_NAMES="create_account_atomic,reconcile_cash_flow_mirror,record_account_verification,replace_equity_snapshots,resolve_create_operation,vault_create_secret,vault_delete_secret,vault_update_secret"
readonly TOMB_EXPECTED_0022="create_account_atomic,record_account_verification,resolve_create_operation,vault_create_secret,vault_delete_secret,vault_update_secret"
readonly TOMB_EXPECTED_0017="reconcile_cash_flow_mirror,replace_equity_snapshots"
readonly TOMB_EXPECTED_MECHANISMS="inline=3,template=5"
# Assembled from the two per-file pins above rather than typed a third time, so
# there is one place to change and no way for the whole-string pin to drift from
# the per-file ones. It carries a claim the per-file loop does not: that EXACTLY
# these two files contribute, in this order. A third file contributing only
# names already in the union would leave TOMB_EXPECTED_NAMES satisfied and show
# up here.
readonly TOMB_EXPECTED_BY_SOURCE="0017_refresh_generation_and_guards.sql:${TOMB_EXPECTED_0017};${TOMB_BASENAME}:${TOMB_EXPECTED_0022}"
readonly TOMB_FALSE_POSITIVES="begin_account_verification audit_log_detail_guard finish_account_verification"

log "0g. positive control — the derived set is the whole UNION, over both mechanisms"
derived_names="$(sed -n 's/^NT_CC_TOMB_NAMES=//p' "$WORK/tomb.env" | tr -d "'")"
derived_by_source="$(sed -n 's/^NT_CC_TOMB_NAMES_BY_SOURCE=//p' "$WORK/tomb.env" | tr -d "'")"
derived_mechs="$(sed -n 's/^NT_CC_TOMB_MECHANISMS=//p' "$WORK/tomb.env" | tr -d "'")"
g_ok=1
if [[ "$derived_names" != "$TOMB_EXPECTED_NAMES" ]]; then
  bad "the derived tombstone name set is not the pinned union:"
  bad "  derived: ${derived_names}"
  bad "  pinned : ${TOMB_EXPECTED_NAMES}"
  g_ok=0
fi
if [[ "$derived_by_source" != "$TOMB_EXPECTED_BY_SOURCE" ]]; then
  bad "the per-source breakdown is not the pinned one:"
  bad "  derived: ${derived_by_source}"
  bad "  pinned : ${TOMB_EXPECTED_BY_SOURCE}"
  g_ok=0
fi
if [[ "$derived_mechs" != "$TOMB_EXPECTED_MECHANISMS" ]]; then
  bad "mechanism counts moved: derived '${derived_mechs}', pinned '${TOMB_EXPECTED_MECHANISMS}'"
  bad "  a union with an empty arm is a single-arm scan wearing a union's name"
  g_ok=0
fi
# Per source file, so "the union is complete" cannot be satisfied by one arm
# finding everything. Bound each expectation by its own source name.
for pair in "0017_refresh_generation_and_guards.sql:${TOMB_EXPECTED_0017}" \
            "${TOMB_BASENAME}:${TOMB_EXPECTED_0022}"; do
  src_file="${pair%%:*}"; want_set="${pair#*:}"
  got_set="$(printf '%s' "$derived_by_source" | tr ';' '\n' \
              | awk -F: -v f="$src_file" '$1==f {print $2; exit}')"
  if [[ "$got_set" != "$want_set" ]]; then
    bad "the set derived from ${src_file} is not the pinned one:"
    bad "  derived: ${got_set:-<the extractor derived nothing from this file>}"
    bad "  pinned : ${want_set}"
    g_ok=0
  fi
done
for n in $TOMB_FALSE_POSITIVES; do
  case ",${derived_names}," in
    *",${n},"*)
      bad "the extractor derived ${n}, which is NOT a tombstone — this is one of"
      bad "  the three false positives the comment-stripping and dollar-quote"
      bad "  bounding exist to prevent"
      g_ok=0 ;;
  esac
done
if [[ "$g_ok" -eq 1 ]]; then
  good "derived set is exactly the pinned union of ${derived_mechs} across two files:"
  good "  ${derived_by_source}"
  good "  and none of the three known false positives is in it"
else
  ctl_ok=0
fi

# 0i/0j/0k are the controls behind the AUD-1/AUD-2 repair. 0g is an assertion
# about the CURRENT tree; on its own it would still be satisfied by an
# extractor that hard-coded the eight names. These three exercise the scan.
log "0i. negative control — the union collapses to a single source file"
onesrc="$WORK/mig-onesrc"; rm -rf "$onesrc"; cp -r "$PRISTINE_MIG" "$onesrc"
rm -f "$onesrc/0017_refresh_generation_and_guards.sql"
set +e
python3 "$EXTRACTOR" "$onesrc" >/dev/null 2>"$WORK/onesrc.err"; onesrc_rc=$?
set -e
if [[ "$onesrc_rc" -ne 2 ]] || ! grep -F -q \
     "every derived tombstone comes from" "$WORK/onesrc.err"; then
  bad "control 0i: with 0017 removed the extractor exited ${onesrc_rc}; it must"
  bad "  refuse (2) rather than emit a single-file result"
  bad "  got: $(tr -d '\n' < "$WORK/onesrc.err")"
  ctl_ok=0
else
  good "control 0i: a derivation that degenerates to one file is refused"
fi

log "0j. negative control — the INLINE arm of the union goes empty"
noinl="$WORK/mig-noinline"; rm -rf "$noinl"; cp -r "$PRISTINE_MIG" "$noinl"
# Only the three INLINE shim messages are neutralised. The template's message
# ('%s is superseded and must not be called') is a different string and is left
# alone, so the refusal below can only be the inline arm's floor. The exact
# occurrence counts are asserted: a doctoring that silently matched nothing
# would make this control vacuous.
python3 - "$noinl" <<'PY'
import os, sys
d = sys.argv[1]
subs = [("0017_refresh_generation_and_guards.sql",
         "is superseded by publish_broker_refresh",
         "is retired by publish_broker_refresh", 2),
        ("0022_fingerprint_binding_and_token_generations.sql",
         "is superseded: pass the expected",
         "is retired: pass the expected", 1)]
for fname, old, new, want in subs:
    p = os.path.join(d, fname)
    s = open(p, encoding="utf-8").read()
    got = s.count(old)
    if got != want:
        raise SystemExit("doctor-noinline: %s has %d occurrence(s) of %r, expected %d"
                         % (fname, got, old, want))
    open(p, "w", encoding="utf-8").write(s.replace(old, new))
PY
set +e
python3 "$EXTRACTOR" "$noinl" >/dev/null 2>"$WORK/noinline.err"; noinl_rc=$?
set -e
if [[ "$noinl_rc" -ne 2 ]] || ! grep -F -q \
     'the `inline` mechanism found no refusal shim' "$WORK/noinline.err"; then
  bad "control 0j: with every inline shim message neutralised the extractor"
  bad "  exited ${noinl_rc}; the inline arm's non-vacuity floor must refuse (2)"
  bad "  got: $(tr -d '\n' < "$WORK/noinline.err")"
  ctl_ok=0
else
  good "control 0j: an empty inline arm is refused, not silently unioned away"
fi

log "0k. positive control — a PLANTED inline tombstone is found by the scan"
# The absence claims above are only worth their words if the thing making them
# can see an instance it was never told about. This plants one and requires the
# derived set to grow by exactly that name.
plant="$WORK/mig-plant"; rm -rf "$plant"; cp -r "$PRISTINE_MIG" "$plant"
cat >> "$plant/0023_audit_guard_traversal_and_token_deadline.sql" <<'PLANT'

-- planted by the suite control 0k; never applied to a real database
create or replace function public.cc_planted_shim(p_a uuid)
returns void language plpgsql set search_path = pg_catalog, public
as $planted$
begin
  raise exception 'cc_planted_shim is superseded and must not be called'
    using errcode = 'P0001';
end;
$planted$;
revoke all on routine public.cc_planted_shim(uuid) from public, anon, authenticated, service_role;
PLANT
set +e
python3 "$EXTRACTOR" "$plant" > "$WORK/plant.env" 2>"$WORK/plant.err"; plant_rc=$?
set -e
plant_names="$(sed -n 's/^NT_CC_TOMB_NAMES=//p' "$WORK/plant.env" | tr -d "'")"
plant_mechs="$(sed -n 's/^NT_CC_TOMB_MECHANISMS=//p' "$WORK/plant.env" | tr -d "'")"
if [[ "$plant_rc" -ne 0 ]]; then
  bad "control 0k: the extractor refused a migration set with one extra inline"
  bad "  shim planted in it (exit ${plant_rc}): $(tr -d '\n' < "$WORK/plant.err")"
  ctl_ok=0
elif [[ "$plant_names" != "cc_planted_shim,${TOMB_EXPECTED_NAMES}" \
     || "$plant_mechs" != "inline=4,template=5" ]]; then
  bad "control 0k: the scan did not see the planted inline tombstone."
  bad "  derived: ${plant_names} (${plant_mechs})"
  bad "  wanted : cc_planted_shim,${TOMB_EXPECTED_NAMES} (inline=4,template=5)"
  bad "  every 'no other tombstone exists' claim in this suite rests on this."
  ctl_ok=0
else
  good "control 0k: a planted inline tombstone is derived; the inline arm is live"
fi

log "0l. negative control — the two false positives this parser was built to avoid"
# 0k proves the inline arm FINDS things. This proves it does not find the two
# non-tombstones it once found for real:
#
#   * `is superseded` matched inside a COMMENT (begin_account_verification), so
#     every match must run against a comment-blanked copy;
#   * a LIVE body that merely mentions the word in the middle — the
#     finish_account_verification trap — so the shape test must require the
#     WHOLE body to be the raise, not to contain one.
#
# (The third historical false positive, a body sliced to the next `create or
# replace` absorbing section 5's DO block and having its format() string
# attributed to the preceding function, is asserted by 0g: audit_log_detail_guard
# must not appear in the derived set.)
fpctl="$WORK/mig-falsepos"; rm -rf "$fpctl"; cp -r "$PRISTINE_MIG" "$fpctl"
cat >> "$fpctl/0023_audit_guard_traversal_and_token_deadline.sql" <<'PLANT'

/* planted by the suite control 0l: a COMPLETE, well-formed shim that is
   entirely inside a block comment and therefore is not a tombstone.
create or replace function public.cc_commented_shim(p_a uuid)
returns void language plpgsql set search_path = pg_catalog, public
as $c1$
begin
  raise exception 'cc_commented_shim is superseded and must not be called'
    using errcode = 'P0001';
end;
$c1$;
*/

-- planted by the suite control 0l: a LIVE routine that merely MENTIONS the word
-- part-way through a long body, and is not a tombstone.
create or replace function public.cc_live_mentions(p_a uuid)
returns integer language plpgsql set search_path = pg_catalog, public
as $c2$
declare n integer := 0;
begin
  n := n + 1;
  if p_a is null then
    raise exception 'token % was superseded by a later verification', p_a
      using errcode = 'P0001';
  end if;
  return n;
end;
$c2$;
PLANT
set +e
python3 "$EXTRACTOR" "$fpctl" > "$WORK/falsepos.env" 2>"$WORK/falsepos.err"; fp_rc=$?
set -e
fp_names="$(sed -n 's/^NT_CC_TOMB_NAMES=//p' "$WORK/falsepos.env" | tr -d "'")"
fp_mechs="$(sed -n 's/^NT_CC_TOMB_MECHANISMS=//p' "$WORK/falsepos.env" | tr -d "'")"
if [[ "$fp_rc" -ne 0 ]]; then
  bad "control 0l: the extractor refused a migration set carrying two planted"
  bad "  NON-tombstones (exit ${fp_rc}): $(tr -d '\n' < "$WORK/falsepos.err")"
  ctl_ok=0
elif [[ "$fp_names" != "$TOMB_EXPECTED_NAMES" || "$fp_mechs" != "$TOMB_EXPECTED_MECHANISMS" ]]; then
  bad "control 0l: a planted NON-tombstone was derived as a tombstone."
  bad "  derived: ${fp_names} (${fp_mechs})"
  bad "  wanted : ${TOMB_EXPECTED_NAMES} (${TOMB_EXPECTED_MECHANISMS}) — unchanged"
  ctl_ok=0
else
  good "control 0l: a shim inside a comment and a live body that merely mentions"
  good "  'superseded' are both rejected; the derived set is unchanged"
fi

# 0h is the standing guard for the migration-selection glob. The driver used to
# select migrations with a four-digit `find` pattern while every applier in
# supabase/tests/ globs *.sql, so a `supabase migration new`-style 14-digit file
# was dropped from BOTH the applied set and the base-inputs digest: the cache
# key did not move, the cached image was reused, and the classifier PASSed over
# a schema that migration had never touched. This runs the driver against a
# disposable COPY of the migration tree — supabase/migrations itself is never
# written to — first clean, then with such a file planted.
log "0h. negative control — a migration the appliers would apply that this driver cannot order"
glob_ok=1
GLOBROOT="$WORK/globctl"
mkdir -p "$GLOBROOT/supabase/migrations" "$GLOBROOT/.github/containment/sql"
cp "$REPO"/supabase/migrations/*.sql            "$GLOBROOT/supabase/migrations/"
cp "$CONTAINMENT"/sql/*.sql                     "$GLOBROOT/.github/containment/sql/"
cp "$CONTAINMENT/catalogue-classify.sql" "$CONTAINMENT/extract-tombstone-template.py" \
   "$CONTAINMENT/catalogue-classify.sh"         "$GLOBROOT/.github/containment/"
chmod +x "$GLOBROOT/.github/containment/catalogue-classify.sh"
GLOBDRIVER="$GLOBROOT/.github/containment/catalogue-classify.sh"

# POSITIVE control on the copy: it must key on the same digest as the real tree,
# or a later refusal would prove nothing about the real one.
real_digest="$("$DRIVER" --generation latest --print-base-digest)"
copy_digest="$("$GLOBDRIVER" --generation latest --print-base-digest 2>/dev/null)"
if [[ "$real_digest" != "$copy_digest" || ! "$real_digest" =~ ^[0-9a-f]{64}$ ]]; then
  bad "control 0h: the disposable copy keys on ${copy_digest:-<none>}, the real tree on ${real_digest:-<none>}"
  glob_ok=0
fi

printf -- '-- planted by the suite control; never applied to a real database\nselect 1;\n' \
  > "$GLOBROOT/supabase/migrations/20250814120000_suite_glob_control.sql"
for g in latest 0008; do
  set +e
  glob_err="$("$GLOBDRIVER" --generation "$g" --print-base-digest 2>&1 >/dev/null)"
  glob_rc=$?
  glob_out="$("$GLOBDRIVER" --generation "$g" --print-base-digest 2>/dev/null)"
  set -e
  if [[ "$glob_rc" -ne 2 ]]; then
    bad "control 0h [$g]: exited ${glob_rc}; a file the appliers would apply and this"
    bad "  driver cannot order must be a harness error (2). stdout=${glob_out:-<empty>}"
    glob_ok=0
  elif [[ "$glob_err" != *"20250814120000_suite_glob_control.sql"* \
        || "$glob_err" != *"cannot order"* ]]; then
    bad "control 0h [$g]: refused, but not with the expected message"
    bad "  got: $(printf '%s' "$glob_err" | tr '\n' ' ')"
    glob_ok=0
  fi
done
rm -f "$GLOBROOT/supabase/migrations/20250814120000_suite_glob_control.sql"

# and it must NOT fire once the file is gone
set +e
glob_out="$("$GLOBDRIVER" --generation latest --print-base-digest 2>/dev/null)"
glob_rc=$?
set -e
if [[ "$glob_rc" -ne 0 || "$glob_out" != "$real_digest" ]]; then
  bad "control 0h: with the planted file removed the driver exited ${glob_rc} with"
  bad "  digest ${glob_out:-<none>}; expected 0 and ${real_digest}"
  glob_ok=0
fi
if [[ "$glob_ok" -eq 1 ]]; then
  good "control 0h: a 14-digit migration is refused with exit 2 naming the file, on both"
  good "  generations; removing it restores the real tree's digest ${real_digest:0:16}…"
else
  ctl_ok=0
fi

[[ "$ctl_ok" -eq 1 ]] || exit "$EXIT_CONTROL"

# ---------------------------------------------------------------------------
# 1. mutation catalogue
#
# Every mutation is applied as supabase_admin, the privilege level a careless
# or hostile operator has. Every mutation that CREATES a routine and means to
# vary exactly one property also revokes the default-privilege grants the new
# object picks up and sets its owner back to postgres, so the reason code the
# suite asserts is the reason the classifier genuinely found — not a side
# effect of who ran the DDL. The mutants that deliberately leave those grants
# in place say so.
# ---------------------------------------------------------------------------
mkdir -p "$WORK/mut"

w() { cat > "$WORK/mut/$1.sql"; }

w 01 <<'SQL'
-- 1. a wrapper is gone entirely
drop function public.vault_update_secret(uuid, text);
SQL

w 02 <<'SQL'
-- 2. the exact signature is gone; only a DIFFERENT overload of the name remains
drop function public.vault_delete_secret(uuid);
create function public.vault_delete_secret(p_id text) returns void
  language plpgsql set search_path = pg_catalog, public as $$ begin end; $$;
alter function public.vault_delete_secret(text) owner to postgres;
SQL

w 03 <<'SQL'
-- 3. the tombstone body is replaced by a live no-op; EXECUTE stays revoked, so
--    service_role still sees 42501 and a bare-42501 reader still says "fine"
create or replace function public.vault_create_secret(p_secret text, p_name text default null::text)
returns uuid language plpgsql set search_path = pg_catalog, public
as $$ begin return null; end; $$;
SQL

w 04 <<'SQL'
-- 4. the tombstone is handed back to service_role
grant execute on function public.vault_create_secret(text, text) to service_role;
SQL

w 05 <<'SQL'
-- 5. ... to anon
grant execute on function public.vault_create_secret(text, text) to anon;
SQL

w 06 <<'SQL'
-- 6. ... to authenticated
grant execute on function public.vault_create_secret(text, text) to authenticated;
SQL

w 07 <<'SQL'
-- 7. ... to PUBLIC. Note that this puts proacl back to NULL, because the
--    resulting ACL is byte-for-byte PostgreSQL's built-in default for a
--    function. A classifier that reads proacl and stops at NULL sees "no
--    grants" here; the right reading of NULL is "PUBLIC may execute".
grant execute on function public.vault_create_secret(text, text) to public;
SQL

w 08 <<'SQL'
-- 8. right message, wrong SQLSTATE
create or replace function public.vault_create_secret(p_secret text, p_name text default null::text)
returns uuid language plpgsql set search_path = pg_catalog, public
as $$
begin
  raise exception
    'vault_create_secret is superseded and must not be called; see supabase/migrations/0022'
    using errcode = '22023';
end;
$$;
SQL

w 09 <<'SQL'
-- 9. right SQLSTATE, wrong message
create or replace function public.vault_create_secret(p_secret text, p_name text default null::text)
returns uuid language plpgsql set search_path = pg_catalog, public
as $$
begin
  raise exception
    'vault_create_secret is superseded and must not be called; see supabase/migrations/0099'
    using errcode = 'P0001';
end;
$$;
SQL

w 10 <<'SQL'
-- 10. the owner changed under us
alter function public.vault_create_secret(text, text) owner to supabase_storage_admin;
SQL

w 11 <<'SQL'
-- 11. security mode flipped (0022's tombstone is SECURITY INVOKER)
alter function public.vault_create_secret(text, text) security definer;
SQL

w 12 <<'SQL'
-- 12. search_path / proconfig changed
alter function public.vault_create_secret(text, text) set search_path = public;
SQL

w 13 <<'SQL'
-- 13. language changed
create or replace function public.vault_create_secret(p_secret text, p_name text default null::text)
returns uuid language sql set search_path = pg_catalog, public
as $$ select null::uuid $$;
SQL

w 14 <<'SQL'
-- 14. volatility changed
alter function public.vault_create_secret(text, text) stable;
SQL

w 15 <<'SQL'
-- 15. return type changed; everything else, including the body, kept exact
drop function public.vault_create_secret(text, text);
create function public.vault_create_secret(p_secret text, p_name text default null::text)
returns text language plpgsql set search_path = pg_catalog, public
as $$
begin
  raise exception
    'vault_create_secret is superseded and must not be called; see supabase/migrations/0022'
    using errcode = 'P0001';
end;
$$;
revoke all on routine public.vault_create_secret(text, text)
  from public, anon, authenticated, service_role;
alter function public.vault_create_secret(text, text) owner to postgres;
SQL

w 16 <<'SQL'
-- 16. an unexpected overload appears beside the tombstone, and it keeps the
--     default-privilege grants a function created in public picks up — so an
--     ordinary role can call something that answers to the tombstoned name
create function public.vault_delete_secret(p_id text) returns void
  language plpgsql set search_path = pg_catalog, public as $$ begin end; $$;
alter function public.vault_delete_secret(text) owner to postgres;
SQL

w 16b <<'SQL'
-- 16b. the same unexpected overload, but locked down: present, not executable.
--      The pair separates UNEXPECTED_EXECUTABLE from UNEXPECTED_PRESENT.
create function public.vault_delete_secret(p_id text) returns void
  language plpgsql set search_path = pg_catalog, public as $$ begin end; $$;
revoke all on routine public.vault_delete_secret(text)
  from public, anon, authenticated, service_role;
alter function public.vault_delete_secret(text) owner to postgres;
SQL

w 17 <<'SQL'
-- 17. THE HEADLINE CASE. A routine 0022 never tombstones has its EXECUTE
--     revoked by accident. service_role now gets 42501 from a perfectly live
--     body. A bare-42501 reader calls that an intentional tombstone. It is not:
--     it is ACL_DRIFT on a live routine.
--
-- Run as the migration owner: REVOKE only removes grants issued by the
-- grantor it runs as, so revoking as anybody else would be a silent no-op and
-- the mutant would prove nothing.
set role postgres;
revoke execute on function public.owns_account(uuid) from authenticated, service_role;
reset role;
SQL

# 18 / 18b / 18c are not SQL mutations: they mutate the HARNESS by disabling or
# breaking the probe.
# 19 restores the pre-0022 live definitions on the latest chain: 0008's create
#    and update, and 0020's FK-aware delete, which is the last live definition
#    of that routine before 0022 tombstoned it.
w 19 <<'SQL'
-- 19. the wrappers are LIVE on the latest schema
create or replace function public.vault_create_secret(p_secret text, p_name text default null)
returns uuid language plpgsql security definer set search_path = public, vault
as $$
declare sid uuid;
begin
  select vault.create_secret(p_secret, p_name) into sid;
  return sid;
end; $$;

create or replace function public.vault_update_secret(p_id uuid, p_secret text)
returns void language plpgsql security definer set search_path = public, vault
as $$
begin
  perform vault.update_secret(p_id, p_secret);
end; $$;

-- migration 0020's body, the live definition on this chain
create or replace function public.vault_delete_secret(p_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public, vault
as $$
declare
  holder uuid;
begin
  if p_id is null then
    raise exception 'a secret id is required' using errcode = '22023';
  end if;
  select account_id into holder
    from account_credential_assignment
   where secret_id = p_id;
  if found then
    raise exception
      'secret % is assigned to account % and cannot be deleted directly; '
      'delete the account, or use purge_unassigned_credential_pair',
      p_id, holder
      using errcode = '23503';
  end if;
  delete from vault.secrets where id = p_id;
end;
$$;

grant execute on function public.vault_create_secret(text, text) to service_role;
grant execute on function public.vault_update_secret(uuid, text) to service_role;
grant execute on function public.vault_delete_secret(uuid)       to service_role;
SQL

# 20 installs the REAL migration-0022 tombstone on a 0001-0008 schema. The SQL
# is sliced out of the migration itself rather than retyped here, so the mutant
# cannot drift away from the thing it is meant to impersonate.
{
  printf -- '-- 20. the 0022 tombstone applied to a 0001-0008 schema (sliced from the migration)\n'
  python3 "$EXTRACTOR" --emit-tombstone-do "$TOMB_MIGRATION"
} > "$WORK/mut/20.sql"
if ! grep -F -q 'is superseded and must not be called' "$WORK/mut/20.sql"; then
  bad "mutant 20 was not sliced out of migration 0022"; exit "$EXIT_CONTROL"
fi

# --- structural surprises ---------------------------------------------------

w 21 <<'SQL'
-- 21. the exact signature is gone and the BARE NAME is now ambiguous
drop function public.vault_delete_secret(uuid);
create function public.vault_delete_secret(p_id text) returns void
  language plpgsql set search_path = pg_catalog, public as $$ begin end; $$;
create function public.vault_delete_secret(p_id integer) returns void
  language plpgsql set search_path = pg_catalog, public as $$ begin end; $$;
alter function public.vault_delete_secret(text)    owner to postgres;
alter function public.vault_delete_secret(integer) owner to postgres;
SQL

w 22 <<'SQL'
-- 22. the signature resolves, but to a PROCEDURE rather than a function
drop function public.vault_create_secret(text, text);
create procedure public.vault_create_secret(p_secret text, p_name text default null::text)
  language plpgsql set search_path = pg_catalog, public as $$ begin end; $$;
alter procedure public.vault_create_secret(text, text) owner to postgres;
SQL

w 23 <<'SQL'
-- 23. the name in that schema now belongs to a RELATION
drop function public.vault_update_secret(uuid, text);
create table public.vault_update_secret(id uuid primary key);
alter table public.vault_update_secret owner to postgres;
SQL

w 24 <<'SQL'
-- 24. alternate-schema spoof, locked down: a same-name routine somewhere else
--     that nothing unexpected can execute
create schema cc_spoof;
create function cc_spoof.vault_create_secret(p_secret text, p_name text default null::text)
returns uuid language plpgsql as $$ begin return null; end; $$;
revoke all on function cc_spoof.vault_create_secret(text, text) from public;
alter function cc_spoof.vault_create_secret(text, text) owner to postgres;
SQL

w 24b <<'SQL'
-- 24b. the same spoof, executable: PostgreSQL's built-in default leaves
--      EXECUTE with PUBLIC, so every role in the cluster can call it
create schema cc_spoof;
create function cc_spoof.vault_create_secret(p_secret text, p_name text default null::text)
returns uuid language plpgsql as $$ begin return null; end; $$;
alter function cc_spoof.vault_create_secret(text, text) owner to postgres;
SQL

# --- the environment surface ------------------------------------------------

w 25 <<'SQL'
-- 25. the DEFAULT-privilege surface is widened. Nothing that exists changes;
--     everything created in public from now on is executable by anon.
alter default privileges for role postgres in schema public
  grant execute on functions to anon;
SQL

w 26 <<'SQL'
-- 26. a brand-new SUPERUSER. It can execute every routine in the database and
--     no per-routine ACL will ever say so.
create role cc_super superuser nologin;
SQL

w 27 <<'SQL'
-- 27. EXECUTE revoked from the tombstone's own owner. Nothing unexpected can
--     call it — something expected can no longer call it.
set role postgres;
revoke execute on function public.vault_create_secret(text, text) from postgres;
reset role;
SQL

# --- the ownership probe ----------------------------------------------------

w 28 <<'SQL'
-- 28. owns_account rewritten to check EXISTENCE instead of OWNERSHIP. Against
--     a one-account fixture this is invisible: it answers true for the seeded
--     account and false for an absent one, which is all a two-answer probe
--     asks. The second seeded account, under a different owner, is what makes
--     it a finding.
create or replace function public.owns_account(acct uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from accounts where id = acct and deleted_at is null);
$$;
SQL

# --- definition drift on the tombstone --------------------------------------

w 29 <<'SQL'
-- 29. the tombstone's argument list changed; body, owner and ACL kept exact
drop function public.vault_update_secret(uuid, text);
create function public.vault_update_secret(p_id uuid, p_secret_text text)
returns void language plpgsql set search_path = pg_catalog, public
as $$
begin
  raise exception
    'vault_update_secret is superseded and must not be called; see supabase/migrations/0022'
    using errcode = 'P0001';
end;
$$;
revoke all on routine public.vault_update_secret(uuid, text)
  from public, anon, authenticated, service_role;
alter function public.vault_update_secret(uuid, text) owner to postgres;
SQL

w 46 <<'SQL'
-- 46. the tombstone body kept, but the object dressed up as the LIVE profile.
--     The structural live gate now matches, so the LIVE probe is selected and
--     the privileged tombstone probe never runs: "the body looks like a
--     tombstone" is left unproven, and unproven is not proven.
alter function public.vault_create_secret(text, text) security definer;
alter function public.vault_create_secret(text, text) set search_path = public, vault;
SQL

w 48 <<'SQL'
-- 48. a LIVE body that raises the tombstone's exact message and SQLSTATE on
--     one input and does real work on every other. Message and SQLSTATE are
--     the two things a naive reader checks.
create or replace function public.vault_create_secret(p_secret text, p_name text default null::text)
returns uuid language plpgsql security definer set search_path = pg_catalog, public, vault
as $$
begin
  if p_secret is null then
    raise exception
      'vault_create_secret is superseded and must not be called; see supabase/migrations/0022'
      using errcode = 'P0001';
  end if;
  return vault.create_secret(p_secret, p_name);
end;
$$;
SQL

# --- definition drift on a LIVE routine -------------------------------------

w 30 <<'SQL'
-- 30. the owner of a LIVE, SECURITY DEFINER routine changed under us
alter function public.owns_account(uuid) owner to supabase_storage_admin;
SQL

w 31 <<'SQL'
-- 31. [0008] the live wrapper's return type changed
drop function public.vault_create_secret(text, text);
create function public.vault_create_secret(p_secret text, p_name text default null::text)
returns text language plpgsql security definer set search_path = public, vault
as $$ begin return null; end; $$;
revoke all on function public.vault_create_secret(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vault_create_secret(text, text) to service_role;
alter function public.vault_create_secret(text, text) owner to postgres;
SQL

w 32 <<'SQL'
-- 32. [0008] the live wrapper's argument list changed
drop function public.vault_create_secret(text, text);
create function public.vault_create_secret(p_secret text, p_name2 text default null::text)
returns uuid language plpgsql security definer set search_path = public, vault
as $$ begin return null; end; $$;
revoke all on function public.vault_create_secret(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vault_create_secret(text, text) to service_role;
alter function public.vault_create_secret(text, text) owner to postgres;
SQL

w 33 <<'SQL'
-- 33. [0008] the live wrapper's language changed
create or replace function public.vault_create_secret(p_secret text, p_name text default null::text)
returns uuid language sql security definer set search_path = public, vault
as $$ select null::uuid $$;
SQL

w 34 <<'SQL'
-- 34. a LIVE SECURITY DEFINER routine becomes SECURITY INVOKER
alter function public.owns_account(uuid) security invoker;
SQL

w 35 <<'SQL'
-- 35. a LIVE STABLE routine becomes VOLATILE
alter function public.owns_account(uuid) volatile;
SQL

w 36 <<'SQL'
-- 36. a LIVE routine's search_path changed
alter function public.owns_account(uuid) set search_path = public;
SQL

# --- privilege drift on a LIVE routine --------------------------------------

w 37 <<'SQL'
-- 37. nothing is granted on the routine at all. anon is simply made a member
--     of authenticated, and inherits EXECUTE on everything authenticated may
--     call. An assertion that reads proacl and stops sees no change.
grant authenticated to anon;
SQL

w 49 <<'SQL'
-- 49. No GRANT on the routine at all: a new role is simply made a member of
--     the tombstone's OWNER, and inherits everything the owner may do.
--
--     THIS LEDGER LINE USED TO SAY the owner's family is treated as entitled
--     "correctly, that is how PostgreSQL works", and that the pinned
--     role-membership graph was the only thing standing between this and a
--     clean INTENTIONALLY_TOMBSTONED — so the frozen expectation was ACL_DRIFT
--     on `env:role_membership_drift` alone. Both halves were wrong, and the
--     prose is the part that made the wrong expectation look considered. A
--     role that has genuinely acquired EXECUTE on a tombstone is
--     UNEXPECTED_EXECUTABLE; ranking it as a fingerprint wobble understates
--     what the attacker got. The entitled set is now PINNED per generation
--     (classifier section 0b), so an owner-family joiner is an unexpected
--     executor by construction, and the role-graph fingerprint stays as the
--     second, independent signal rather than the only one.
--
--     A related trap this mutant exposed and the classifier now avoids: the
--     new role can also execute the ACL-scanner controls' own throwaway probe
--     routine, which used to break C12/C13's exact equalities and downgrade
--     the entire run to CONTROL_FAILED — burying the real blocker behind an
--     exit 3. See `cc_env_family` for why subtracting the role-graph family
--     from those two controls does not weaken them.
--
--     (`grant postgres to anon` would be the obvious form and PostgreSQL
--     refuses it: postgres is already a member of anon, and membership cannot
--     be circular. A role that is not already inside the owner's set is.)
create role cc_family nologin;
grant postgres to cc_family;
SQL

w 38 <<'SQL'
-- 38. EXECUTE on a live routine handed to supabase_auth_admin
grant execute on function public.owns_account(uuid) to supabase_auth_admin;
SQL

w 39 <<'SQL'
-- 39. EXECUTE reached through a group, and through a NOINHERIT member of that
--     group which can still SET ROLE into it
create role cc_side nologin;
grant execute on function public.owns_account(uuid) to cc_side;
grant cc_side to supabase_auth_admin;
SQL

w 40 <<'SQL'
-- 40. EXECUTE on a live routine handed to PUBLIC
grant execute on function public.owns_account(uuid) to public;
SQL

w 41 <<'SQL'
-- 41. an executable overload appears beside a live routine
create function public.owns_account(acct text) returns boolean
  language sql stable as $$ select false $$;
alter function public.owns_account(text) owner to postgres;
SQL

# --- privilege drift on the tombstone ---------------------------------------

w 42 <<'SQL'
-- 42. EXECUTE on the tombstone handed to authenticator — a role the dashboard
--     really does log in as, and one the four-role assertion never named
grant execute on function public.vault_create_secret(text, text) to authenticator;
SQL

w 43 <<'SQL'
-- 43. EXECUTE on the tombstone handed to supabase_auth_admin. This is the
--     exact escape the previous, one-sided assertion classified as
--     INTENTIONALLY_TOMBSTONED.
grant execute on function public.vault_create_secret(text, text) to supabase_auth_admin;
SQL

w 44 <<'SQL'
-- 44. EXECUTE on the tombstone handed to a role that did not exist a moment
--     ago, so no enumerated list could have contained it
create role cc_intruder nologin;
grant execute on function public.vault_create_secret(text, text) to cc_intruder;
SQL

w 45 <<'SQL'
-- 45. EXECUTE on the tombstone reached only through role membership: a group
--     holds the grant, anon inherits it, and a NOINHERIT role can SET ROLE
--     into it
create role cc_grp nologin;
grant execute on function public.vault_create_secret(text, text) to cc_grp;
grant cc_grp to anon;
grant cc_grp to supabase_auth_admin;
SQL

w 47 <<'SQL'
-- 47. EXECUTE reached through a DEFAULT privilege: widen the default first,
--     then create an overload of the tombstoned name, which picks the grant up
--     at creation without a single explicit GRANT on it
alter default privileges for role postgres in schema public
  grant execute on functions to anon;
set role postgres;
create function public.vault_create_secret(p_secret text) returns uuid
  language sql as $$ select null::uuid $$;
reset role;
SQL

# --- the authorization predicate itself -------------------------------------
#
# owns_account is the SECURITY DEFINER function behind RLS on positions,
# performance, equity_snapshots and routine_runs, so "it answers the three
# questions we asked" is not the same claim as "it authorises nobody else".
# 50 and 51 are the two shapes that answer the ORIGINAL three-point truth
# table perfectly. They are caught by different checks, on purpose: 50 by the
# negative probes (no subject must not mean every subject), 51 only by the
# pinned body digest, because a backdoor keyed on a uuid no probe holds
# answers all nine probe questions correctly.

w 50 <<'SQL'
-- 50. owns_account authorises EVERY account whenever there is no JWT subject.
--     owns(own)=true, owns(absent)=false, owns(other owner)=false all hold.
create or replace function public.owns_account(acct uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from accounts
    where id = acct
      and (owner_id = auth.uid() or auth.uid() is null)
      and deleted_at is null
  );
$$;
SQL

w 51 <<'SQL'
-- 51. owns_account with a BACKDOOR SUBJECT: one fixed uuid owns everything.
--     Every probe answer stays correct — no probe holds that uuid — so only
--     the pinned body digest can see this one.
create or replace function public.owns_account(acct uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from accounts
    where id = acct
      and (owner_id = auth.uid()
           or auth.uid() = '99999999-9999-4999-8999-999999999999'::uuid)
      and deleted_at is null
  );
$$;
SQL

# --- the two tombstones the catalogue used to be blind to -------------------
#
# 52-55 exist because this classifier shipped with four expectation rows
# against a migration that tombstones five routines. create_account_atomic and
# record_account_verification received no verdict row at all, so every one of
# these mutations produced a clean PASS.

w 52 <<'SQL'
-- 52. EXECUTE on a 0022 tombstone handed straight back to service_role — the
--     role the dashboard's server code runs as.
grant execute on function
  public.create_account_atomic(uuid,text,account_mode,text,uuid,uuid,text,uuid)
  to service_role;
SQL

w 53 <<'SQL'
-- 53. EXECUTE on the other blind tombstone, handed to anon.
grant execute on function
  public.record_account_verification(uuid,uuid,account_status,text,bigint)
  to anon;
SQL

# 54 FULLY revives a tombstoned routine: migration 0021's own definition, sliced
#    out of the migration rather than retyped, plus EXECUTE back to
#    service_role. Slicing keeps the revival faithful to the thing 0022
#    superseded, exactly as mutant 20 does for the tombstone itself.
cat > "$WORK/slice-routine.py" <<'PY'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
name = sys.argv[2]
m = re.search(r"^create or replace function %s\(\n" % re.escape(name), src, re.M)
if not m:
    sys.stderr.write("slice: no definition of %s in %s\n" % (name, sys.argv[1]))
    sys.exit(1)
start = m.start()
end = src.find("\n$$;\n", start)
if end < 0:
    sys.stderr.write("slice: no terminator for %s\n" % name)
    sys.exit(1)
block = src[start:end + len("\n$$;\n")]
# POSITIVE CONTROL on the slicer: a header-only slice would install nothing.
if ("begin" not in block or "language plpgsql" not in block
        or "security definer" not in block):
    sys.stderr.write("slice: the extracted block is not a full definition\n")
    sys.exit(1)
sys.stdout.write(block)
PY
{
  printf -- '-- 54. a 0022 tombstone fully revived (0021 definition, sliced from the migration)\n'
  python3 "$WORK/slice-routine.py" \
    "${REPO}/supabase/migrations/0021_atomic_create_and_verification.sql" \
    create_account_atomic
  printf 'grant execute on function public.create_account_atomic(uuid,text,account_mode,text,uuid,uuid,text,uuid) to service_role;\n'
} > "$WORK/mut/54.sql"
if ! grep -F -q 'security definer' "$WORK/mut/54.sql"; then
  bad "mutant 54 was not sliced out of migration 0021"; exit "$EXIT_CONTROL"
fi

w 55 <<'SQL'
-- 55. [0008] a routine 0022 tombstones, back-ported onto the reference schema
--     that predates it. On that generation the expectation is ABSENT, so any
--     routine answering the signature is a finding.
create function public.create_account_atomic(
  p_owner uuid, p_nickname text, p_mode account_mode, p_color text,
  p_key_secret uuid, p_secret_secret uuid, p_account_number text, p_operation_id uuid)
returns accounts language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare a public.accounts;
begin
  select * into a from public.accounts limit 1;
  return a;
end; $$;
alter function public.create_account_atomic(uuid,text,account_mode,text,uuid,uuid,text,uuid)
  owner to postgres;
SQL

# --- the three tombstones a SECTION-scoped derivation never saw -------------
#
# 56-59 are the falsification of AUD-1/AUD-2 and of the migration-0017 half of
# the same finding. The derivation used to read migration 0022 SECTION 5 only.
# 0022 ALSO tombstones public.resolve_create_operation(uuid,uuid) INLINE, sixty
# lines above that loop, with a different message ("is superseded: pass the
# expected request fingerprint") and its own SECURITY INVOKER header; migration
# 0017 turns reconcile_cash_flow_mirror and replace_equity_snapshots into the
# same kind of hard failure. None of the three carried an expectation row, so
# every mutation below produced a clean PASS.
#
# resolve_create_operation is the one object with a LIVE SIBLING: 0022 leaves
# the three-argument successor callable by service_role. That is why its
# expectation pins the sibling landscape exactly rather than requiring it
# empty, and why a mutant that touches only the two-argument form must not
# disturb the sibling.

w 56 <<'SQL'
-- 56. AUD-1: EXECUTE on the INLINE 0022 tombstone handed to the two roles a
--     client can arrive as. The three-argument successor is left alone.
grant execute on function public.resolve_create_operation(uuid,uuid)
  to service_role, anon;
SQL

# 57 is AUD-2: the inline tombstone FULLY revived to the definition 0022
#    superseded — migration 0021's own SECURITY DEFINER body, sliced out of the
#    migration rather than retyped — plus EXECUTE back to service_role.
{
  printf -- '-- 57. the INLINE 0022 tombstone fully revived (0021 definition, sliced)\n'
  python3 "$WORK/slice-routine.py" \
    "${REPO}/supabase/migrations/0021_atomic_create_and_verification.sql" \
    resolve_create_operation
  printf 'grant execute on function public.resolve_create_operation(uuid,uuid) to service_role;\n'
} > "$WORK/mut/57.sql"
if ! grep -F -q 'security definer' "$WORK/mut/57.sql" \
   || ! grep -F -q 'lock_create_operation' "$WORK/mut/57.sql"; then
  bad "mutant 57 was not sliced out of migration 0021"; exit "$EXIT_CONTROL"
fi

w 58 <<'SQL'
-- 58. a migration-0017 tombstone handed to anon. 0017 does NOT revoke
--     service_role from these two, so the derived expectation is
--     {service_role} rather than {} — anon is the escape, and a check that
--     demanded an empty set here would have had to be relaxed to pass the
--     pristine schema.
grant execute on function
  public.reconcile_cash_flow_mirror(uuid,uuid,date,jsonb) to anon;
SQL

w 59 <<'SQL'
-- 59. the other migration-0017 tombstone's refusal replaced by a live no-op.
--     Owner, language, security mode, search_path, arguments and return type
--     are all left exactly as the shim's, so the ONLY thing that moved is the
--     body: 0017's shims differ from the live 0014 definitions in nothing else,
--     which is precisely why the tombstone probe cannot be an `else` branch of
--     the live one.
create or replace function public.replace_equity_snapshots(
  p_account uuid, p_owner uuid, p_rows jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$ begin return '[]'::jsonb; end; $$;
SQL

# --- the DEPENDENCY CLOSURE of the authorization predicate ------------------
#
# 60-63 are AUD-3 and the RLS half of the same finding. owns_account is pinned
# by body digest and probed at nine points, and those two were called jointly
# sufficient for "this routine authorises exactly the owner". Every mutation
# below leaves the body BYTE-IDENTICAL and every one of the nine probes
# answering correctly, and destroys the authorization anyway. They are the
# reason AUTHZ_CLOSURE_BROKEN is a state of its own: nothing about this
# object's definition moved.

w 60 <<'SQL'
-- 60. auth.uid() — the only non-trivial term in owns_account's pinned body —
--     redefined with a backdoor claim. owns(A) becomes true for an
--     attacker-chosen identity. No probe sets that claim, so all nine still
--     answer correctly; the digest of owns_account does not move at all.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select case
    when current_setting('request.jwt.claim.cc_backdoor', true) = 'yes'
      then '99999999-9999-4999-8999-999999999999'::uuid
    else nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  end
$$;
SQL

w 61 <<'SQL'
-- 61. public.accounts — the only relation owns_account reads — loses row level
--     security. The predicate still answers correctly; the table it reads is
--     no longer protected by the policies that were supposed to route through
--     it.
alter table public.accounts disable row level security;
SQL

w 62 <<'SQL'
-- 62. the total bypass: RLS switched off on a table whose read policy is the
--     only thing that ever calls owns_account. Touches neither the routine nor
--     its ACL nor its body.
alter table public.positions disable row level security;
SQL

w 63 <<'SQL'
-- 63. RLS stays ON and the policy stays in place, but its predicate no longer
--     routes through owns_account, so every row is readable. The policy SET
--     the closure pins is what notices.
alter policy "read own positions" on public.positions using (true);
SQL

# ADV-1. Mutants 62 and 63 are the two ways of breaking the guard that leave a
# TRACE ON THE THING THE CLOSURE ALREADY WATCHED: 62 turns RLS off, 63 rewrites
# the pinned policy's predicate. Neither is the interesting attack, because both
# are edits to something named in the pin.
#
# 64 adds. PostgreSQL ORs PERMISSIVE policies, so a second `using (true)` beside
# `read own positions` leaves that policy byte-identical, leaves RLS on, leaves
# auth.uid() and public.accounts untouched, and leaves owns_account answering
# every one of the nine probes correctly — while every row of the table is
# readable by anybody. MEASURED before the fix: the classifier returned PASS,
# and in the same clone `authenticated` carrying the OTHER fixture owner's JWT
# subject read the victim account's positions row while owns_account(victim)
# answered false. The pin's shape was "the policy I know about is intact"; the
# property needed is "the policy SET is exactly this".
w 64 <<'SQL'
-- 64. ADV-1: a SECOND permissive policy beside the expected one. Nothing the
--     closure previously pinned changes; the table stops being guarded.
create policy "adv1_read_all_positions" on public.positions
  for select using (true);
SQL

# 65 is the same shape aimed at the arm whose pinned value is the EMPTY SET.
# `public.accounts` is the relation the predicate reads; on the latest schema it
# carries RLS with no policy at all, i.e. deny-all to every client role. "No
# policies" is also exactly what a scanner that stopped scanning would report,
# which is why the pinned empty set needs a mutant of its own rather than a
# count-of-zero nobody ever falsified.
w 65 <<'SQL'
-- 65. ADV-1 against a pinned EMPTY policy set: the relation the predicate reads
--     becomes world-readable, without touching any policy the closure names.
create policy "adv1_read_all_accounts" on public.accounts
  for select using (true);
SQL

# ---------------------------------------------------------------------------
# ADV-2 — 66, 67, 68, 69, 71, 72. RLS ENABLED, THE POLICY SET BYTE-IDENTICAL,
#                                   AND THE ROWS COME OUT ANYWAY
#
# (70 is not in this range: it is the whole-schema counter-scan cell in
# SCHEMA_MUTANTS, which predates this block.)
#
# 62-65 are the four ways of breaking the guard that leave a trace on a POLICY
# or on relrowsecurity. This block is the class that leaves both untouched. All
# SIX were MEASURED as PASS on `catalogue-classify.sh --generation latest`
# before the `guarded` arm and the BYPASSRLS fingerprint existed, and FIVE of
# the six were measured as live cross-tenant reads in the same clone, with
# fixture owner 4444's JWT subject set, while public.owns_account('2222…')
# answered FALSE: 66, 68, 69 and 71 each read all 21 of victim account 2222's
# equity_snapshots rows, and 72 listed both fixture accounts through
# accounts_safe. The sixth, 67, is a HARDENING that is still drift — see its
# own note.
#
# NO MUTANT IN THE SUITE TARGETED A GUARDED-TABLE OWNER OR A ROLE ATTRIBUTE
# BEFORE THIS BLOCK. Mutant 10 and mutant 30 change a ROUTINE's owner; mutant 26
# adds a SUPERUSER and 37/39/45/49 move MEMBERSHIPS. A table owner and the
# BYPASSRLS attribute are neither, and that is why both shapes survived four
# rounds of falsification.
# ---------------------------------------------------------------------------

w 66 <<'SQL'
-- 66. ADV-2(C). The table OWNER is exempt from its own RLS policies unless
--     FORCE ROW LEVEL SECURITY is set, and FORCE is off on every table in this
--     schema. Nothing else moves: RLS stays on, the policy stays byte-identical,
--     owns_account stays correct. MEASURED: 21 of the victim's rows, read by
--     `authenticated`, while owns_account(victim) returned false.
alter table public.equity_snapshots owner to authenticated;
SQL

w 67 <<'SQL'
-- 67. ADV-2(C), the other half of the pair. Turning FORCE ROW LEVEL SECURITY on
--     is a HARDENING, not an attack — and it is still drift from the measured
--     baseline, which is what the pin is for. It is here so the flag is
--     falsified in the direction the schema can actually move today: FORCE is
--     off everywhere, so "somebody turned it off" cannot be planted, and a pin
--     nobody can move is a pin nobody has tested.
alter table public.positions force row level security;
SQL

w 68 <<'SQL'
-- 68. ADV-2(E). An inheritance parent. A query against the PARENT applies the
--     PARENT's policies to the child's rows; the child's own policies are not
--     consulted. The child is untouched — same owner, RLS on, one policy.
--     MEASURED: 21 rows through the parent.
create table public.cc_evil_parent (account_id uuid, equity numeric(18,2));
alter table public.equity_snapshots inherit public.cc_evil_parent;
grant select on public.cc_evil_parent to authenticated;
SQL

w 69 <<'SQL'
-- 69. ADV-2(F). A view over a guarded table runs in the VIEW OWNER's
--     row-security context unless it is declared security_invoker.
--     MEASURED: 21 rows through the view, owner supabase_admin.
create view public.cc_evil_view as select * from public.equity_snapshots;
grant select on public.cc_evil_view to authenticated;
SQL

w 72 <<'SQL'
-- 72. ADV-2(F), the one that is not hypothetical. On generation latest the
--      client's ONLY read path to accounts / cash_flows / trades is three views
--      owned by `postgres` — a BYPASSRLS role — granted SELECT to
--      `authenticated`, whose WHERE clause is the entire tenant boundary.
--      Dropping `owner_id = auth.uid()` from accounts_safe is a total
--      cross-tenant read with RLS still enabled on public.accounts and its
--      pinned EMPTY policy set still empty. MEASURED: the attacker listed both
--      fixture accounts, including the victim's, under a PASS.
create or replace view public.accounts_safe with (security_barrier=true) as
 select id, nickname, mode, status, color, is_active,
        case when alpaca_account_number is null then null::text
             when length(alpaca_account_number) < 4 then null::text
             else '••••'::text || "right"(alpaca_account_number, 4) end
          as broker_account_mask,
        last_verified_at, created_at
   from accounts a
  where deleted_at is null;
SQL

w 75 <<'SQL'
-- 75. R5-CTLPREC(2). relkind was the one property of the ADV-2 guarded arm with
--     no mutant of its own, and the reason-code coverage assertion could not
--     see the gap because all six of that arm's properties report the single
--     code dep:guarded_table_exposed. (The assertion that CAN see it is
--     assert_guarded_property_coverage in this suite, which requires each of
--     the six to be observed not-ok by some mutant; this is the instance that
--     satisfies it for relkind.)
--
--     A table cannot be turned into a view in place, so the swap is: keep the
--     rows under a new name, drop the policy that routes through owns_account
--     (leaving it attached to the renamed table would make the DERIVED routed
--     set name a table the closure does not declare, which is C34's refusal,
--     not a finding), and put an unguarded view back under the original name.
--     The OWNER is restored to postgres so the owner row does not move; relkind
--     is what this mutant is for.
--     MEASURED: `authenticated` with subject 4444… reads all 21 of victim 2222…'s
--     rows through public.equity_snapshots while owns_account(2222…) is false.
drop policy "read own equity" on public.equity_snapshots;
alter table public.equity_snapshots rename to cc_equity_snapshots_base;
alter table public.cc_equity_snapshots_base disable row level security;
create view public.equity_snapshots as select * from public.cc_equity_snapshots_base;
alter view public.equity_snapshots owner to postgres;
grant select on public.equity_snapshots to authenticated;
SQL

w 71 <<'SQL'
-- 71. ADV-2(D). BYPASSRLS is a role ATTRIBUTE — not superuser, not a
--     membership — so neither the superuser fingerprint nor the role graph
--     moves. MEASURED: every guarded table, plus profiles and audit_log, read
--     by `authenticated`; `nobypassrls` puts it back to zero.
alter role authenticated bypassrls;
SQL

# C34n is not a mutant of the SCHEMA — it is the falsification of a CLASSIFIER
# CONTROL, and it has no expected object state, so it is not in MUTANTS.
#
# Mutant 62 proves the closure sees RLS switched off on `positions`. It proves
# nothing about `performance`, `equity_snapshots` or `routine_runs`, because
# which tables the closure watches is a list TYPED INTO the classifier, per
# generation. That is the same shape as the tombstone name list that reported
# itself whole while being short by three. C34 in the classifier checks that
# typed list against the set the DATABASE produces — every table carrying a
# policy whose USING clause routes through owns_account — and this is the
# planted instance proving C34 can see one it was not told about.
w C34n <<'SQL'
-- C34 negative control: a table gains a policy routing through owns_account
-- while the closure's `rls` arm still names only the original four. The run
-- must REFUSE (CONTROL_FAILED), not quietly watch one table fewer than the
-- schema routes through the predicate.
create policy "cc_ctl_routed" on public.trades for select
  using (public.owns_account(account_id));
SQL

# Selectable by id like any other cell, so `--only C34n` works and so a future
# --only list cannot quietly exclude a whole class of check. These assert a
# REFUSAL rather than a finding, so they carry no expected object state.
#
#   id | generation | mutation file | description
CONTROL_FALSIFICATIONS=(
"C34n|latest|C34n|C34+C35: a table the schema routes through owns_account that neither the closure's rls arm nor its policyset arm names"
)

# ---------------------------------------------------------------------------
# 2. the mutant table
#
# id | generation | mutation file (or -) | probe-mode | key | expected final |
#    required reasons | description
#
# A required reason is a reason code that must appear in the object's decisive
# `reasons` list. Prefix it with @<array>/ to require it in one of the JSON
# report's other arrays instead (structural_misses, env_misses, live_misses,
# tomb_misses) — used where a code is real and asserted but, by construction,
# never decisive for the profile expected on that object.
# ---------------------------------------------------------------------------
MUTANTS=(
"01|latest|01|normal|vault_update_secret|MISSING|sig_absent|drop a wrapper"
"02|latest|02|normal|vault_delete_secret|MISSING|sig_only_other_overload|only a different overload remains"
"03|latest|03|normal|vault_create_secret|DEFINITION_DRIFT|tomb:body_not_tombstone,tomb:probe_skipped_unsafe_body|tombstone body replaced by a live no-op, ACL still revoked"
"04|latest|04|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|tomb:acl_service_role_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|EXECUTE granted to service_role"
"05|latest|05|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|tomb:acl_anon_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|EXECUTE granted to anon"
"06|latest|06|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|tomb:acl_authenticated_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|EXECUTE granted to authenticated"
"07|latest|07|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|tomb:acl_public_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|EXECUTE granted to PUBLIC (proacl goes back to NULL)"
"08|latest|08|normal|vault_create_secret|DEFINITION_DRIFT|tomb:body_not_tombstone,tomb:probe_sqlstate_mismatch|right message, wrong SQLSTATE"
"09|latest|09|normal|vault_create_secret|DEFINITION_DRIFT|tomb:body_not_tombstone,tomb:probe_message_mismatch|right SQLSTATE, wrong message"
"10|latest|10|normal|vault_create_secret|DEFINITION_DRIFT|tomb:owner_mismatch|owner changed"
"11|latest|11|normal|vault_create_secret|DEFINITION_DRIFT|tomb:secmode_mismatch|SECURITY INVOKER/DEFINER flipped"
"12|latest|12|normal|vault_create_secret|DEFINITION_DRIFT|tomb:proconfig_mismatch|search_path changed"
"13|latest|13|normal|vault_create_secret|DEFINITION_DRIFT|tomb:language_mismatch,tomb:body_not_tombstone,tomb:probe_skipped_unsafe_body|language changed"
"14|latest|14|normal|vault_create_secret|DEFINITION_DRIFT|tomb:volatility_mismatch|volatility changed"
"15|latest|15|normal|vault_create_secret|DEFINITION_DRIFT|tomb:rettype_mismatch|return type changed"
"16|latest|16|normal|vault_delete_secret|UNEXPECTED_EXECUTABLE|overload_unexpected,tomb:acl_sibling_executable|an executable overload appears"
"16b|latest|16b|normal|vault_delete_secret|UNEXPECTED_PRESENT|overload_unexpected|a locked-down overload appears"
"17|latest|17|normal|owns_account|ACL_DRIFT|live:acl_explicit_mismatch,live:acl_effective_mismatch,live:acl_missing_executor,live:probe_failed,@tomb_misses/tomb:not_applicable|42501 on a LIVE unrelated routine is NOT a tombstone"
"18|latest|-|skip|vault_create_secret|UNPROVEN|tomb:probe_missing|the privileged body probe is skipped"
"18b|latest|-|break|vault_create_secret|DEFINITION_DRIFT|tomb:probe_sqlstate_mismatch|the privileged body probe is broken"
"18c|latest|-|skip|owns_account|UNPROVEN|live:probe_missing|the live semantic probe is skipped"
"19|latest|19|normal|vault_create_secret|UNEXPECTED_PRESENT|tomb:secmode_mismatch,tomb:proconfig_mismatch,tomb:body_not_tombstone,tomb:acl_service_role_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor,tomb:probe_skipped_unsafe_body,expected_state_mismatch|wrappers LIVE on the latest schema"
"19b|latest|19|normal|vault_delete_secret|UNEXPECTED_PRESENT|tomb:secmode_mismatch,tomb:proconfig_mismatch,tomb:body_not_tombstone,tomb:acl_service_role_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor,tomb:probe_skipped_unsafe_body,expected_state_mismatch|wrappers LIVE on the latest schema (0020 body)"
"20|0008|20|normal|vault_create_secret|UNEXPECTED_PRESENT|live:secmode_mismatch,live:proconfig_mismatch,live:body_mismatch,live:probe_skipped_structure,live:acl_explicit_mismatch,live:acl_effective_mismatch,live:acl_missing_executor,expected_state_mismatch|wrappers TOMBSTONED on 0001-0008"
"20b|0008|20|normal|vault_update_secret|UNEXPECTED_PRESENT|live:secmode_mismatch,live:proconfig_mismatch,live:body_mismatch,live:probe_skipped_structure,live:acl_explicit_mismatch,live:acl_effective_mismatch,live:acl_missing_executor,expected_state_mismatch|wrappers TOMBSTONED on 0001-0008"
"21|latest|21|normal|vault_delete_secret|MISSING|sig_name_ambiguous|the bare name is ambiguous"
"22|latest|22|normal|vault_create_secret|MISSING|sig_wrong_object_kind|the name is a PROCEDURE now"
"23|latest|23|normal|vault_update_secret|MISSING|sig_wrong_object_kind|the name is a RELATION now"
"24|latest|24|normal|vault_create_secret|UNEXPECTED_PRESENT|alt_schema_shadow|alternate-schema spoof, locked down"
"24b|latest|24b|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|alt_schema_shadow,tomb:acl_sibling_executable|alternate-schema spoof, executable by PUBLIC"
"25|latest|25|normal|vault_create_secret|ACL_DRIFT|env:default_acl_drift|the default-privilege surface widened"
"26|latest|26|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|env:superuser_set_drift,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|a new superuser role appeared"
"27|latest|27|normal|vault_create_secret|ACL_DRIFT|tomb:acl_missing_executor|EXECUTE revoked from the tombstone's owner"
"28|latest|28|normal|owns_account|DEFINITION_DRIFT|live:probe_effect_mismatch,live:body_mismatch|owns_account checks existence, not ownership"
"29|latest|29|normal|vault_update_secret|DEFINITION_DRIFT|tomb:args_mismatch|the tombstone's argument list changed"
"30|latest|30|normal|owns_account|DEFINITION_DRIFT|live:owner_mismatch,live:probe_skipped_structure|the live routine's owner changed"
"31|0008|31|normal|vault_create_secret|DEFINITION_DRIFT|live:rettype_mismatch,live:body_mismatch,live:probe_skipped_structure|the live wrapper's return type changed"
"32|0008|32|normal|vault_create_secret|DEFINITION_DRIFT|live:args_mismatch,live:body_mismatch,live:probe_skipped_structure|the live wrapper's argument list changed"
"33|0008|33|normal|vault_create_secret|DEFINITION_DRIFT|live:language_mismatch,live:body_mismatch,live:probe_skipped_structure|the live wrapper's language changed"
"34|latest|34|normal|owns_account|DEFINITION_DRIFT|live:secmode_mismatch,live:probe_skipped_structure|the live routine became SECURITY INVOKER"
"35|latest|35|normal|owns_account|DEFINITION_DRIFT|live:volatility_mismatch,live:probe_skipped_structure|the live routine became VOLATILE"
"36|latest|36|normal|owns_account|DEFINITION_DRIFT|live:proconfig_mismatch,live:probe_skipped_structure|the live routine's search_path changed"
"37|latest|37|normal|owns_account|UNEXPECTED_EXECUTABLE|live:acl_effective_mismatch,live:acl_unexpected_executor,env:role_membership_drift|anon made a member of authenticated"
"38|latest|38|normal|owns_account|UNEXPECTED_EXECUTABLE|live:acl_explicit_mismatch,live:acl_unexpected_executor,live:acl_assumable_executor|EXECUTE on a live routine to supabase_auth_admin"
"39|latest|39|normal|owns_account|UNEXPECTED_EXECUTABLE|env:role_membership_drift,live:acl_explicit_mismatch,live:acl_unexpected_executor,live:acl_assumable_executor|EXECUTE on a live routine through a group and a NOINHERIT member"
"40|latest|40|normal|owns_account|UNEXPECTED_EXECUTABLE|live:acl_explicit_mismatch,live:acl_effective_mismatch,live:acl_unexpected_executor,live:acl_assumable_executor,live:acl_public_execute|EXECUTE on a live routine to PUBLIC"
"41|latest|41|normal|owns_account|UNEXPECTED_EXECUTABLE|overload_unexpected,live:acl_sibling_executable|an executable overload beside a live routine"
"42|latest|42|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|EXECUTE on the tombstone to authenticator"
"43|latest|43|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|tomb:acl_unexpected_executor,tomb:acl_assumable_executor|EXECUTE on the tombstone to supabase_auth_admin"
"44|latest|44|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|tomb:acl_unexpected_executor,tomb:acl_assumable_executor|EXECUTE on the tombstone to a brand-new role"
"45|latest|45|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|env:role_membership_drift,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|EXECUTE on the tombstone through group membership"
"46|latest|46|normal|vault_create_secret|DEFINITION_DRIFT|tomb:secmode_mismatch,tomb:proconfig_mismatch|tombstone body dressed up as the live profile — the tomb probe still runs"
"47|latest|47|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|env:default_acl_drift,overload_unexpected,tomb:acl_sibling_executable|EXECUTE reached through a default privilege"
"48|latest|48|normal|vault_create_secret|DEFINITION_DRIFT|tomb:secmode_mismatch,tomb:proconfig_mismatch,tomb:body_not_tombstone,tomb:probe_skipped_unsafe_body|a live body that raises the tombstone's exact message"
"49|latest|49|normal|vault_create_secret|UNEXPECTED_EXECUTABLE|env:role_membership_drift,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|a new role made a member of the tombstone's owner"
"50|latest|50|normal|owns_account|DEFINITION_DRIFT|live:probe_effect_mismatch,live:body_mismatch|owns_account authorises everything when auth.uid() is null"
"51|latest|51|normal|owns_account|DEFINITION_DRIFT|live:body_mismatch|owns_account with a fixed-uuid backdoor subject"
"52|latest|52|normal|create_account_atomic|UNEXPECTED_EXECUTABLE|tomb:acl_service_role_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|EXECUTE on a 0022 tombstone back to service_role"
"53|latest|53|normal|record_account_verification|UNEXPECTED_EXECUTABLE|tomb:acl_anon_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|EXECUTE on the other blind tombstone to anon"
"54|latest|54|normal|create_account_atomic|UNEXPECTED_EXECUTABLE|tomb:secmode_mismatch,tomb:proconfig_mismatch,tomb:body_not_tombstone,tomb:acl_service_role_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor,tomb:probe_skipped_unsafe_body,@live_misses/live:probe_undefined|a 0022 tombstone fully revived from 0021's definition"
"55|0008|55|normal|create_account_atomic|UNEXPECTED_PRESENT|absent:routine_exists,overload_unexpected|a post-0008 routine back-ported onto the reference schema"
"56|latest|56|normal|resolve_create_operation|UNEXPECTED_EXECUTABLE|tomb:acl_anon_execute,tomb:acl_service_role_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|AUD-1: EXECUTE on the INLINE 0022 tombstone to service_role and anon"
"57|latest|57|normal|resolve_create_operation|UNEXPECTED_EXECUTABLE|tomb:secmode_mismatch,tomb:body_not_tombstone,tomb:acl_service_role_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor,tomb:probe_skipped_unsafe_body|AUD-2: the INLINE 0022 tombstone revived from 0021's definition"
"58|latest|58|normal|reconcile_cash_flow_mirror|UNEXPECTED_EXECUTABLE|tomb:acl_anon_execute,tomb:acl_effective_escape,tomb:acl_unexpected_executor,tomb:acl_assumable_executor|a migration-0017 tombstone handed to anon"
"59|latest|59|normal|replace_equity_snapshots|DEFINITION_DRIFT|tomb:body_not_tombstone,tomb:probe_skipped_unsafe_body|the other 0017 tombstone's refusal replaced by a live no-op"
"60|latest|60|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:function_drift|AUD-3: auth.uid() redefined with a backdoor claim"
"61|latest|61|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:relation_drift,dep:guarded_table_exposed|RLS off on public.accounts, the relation the predicate reads — seen twice, by the relation arm and by the ADV-2 guarded arm"
"62|latest|62|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:rls_disabled,dep:guarded_table_exposed|RLS off on positions, a table the predicate is supposed to guard — seen twice, by the rls arm and by the ADV-2 guarded arm"
"63|latest|63|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:policy_set_changed,dep:guarded_policy_set_changed|the positions read policy no longer routes through owns_account"
"64|latest|64|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:guarded_policy_set_changed|ADV-1: a SECOND permissive policy using (true) beside the pinned one"
"65|latest|65|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:guarded_policy_set_changed|ADV-1 against a pinned EMPTY policy set: public.accounts becomes world-readable"
"66|latest|66|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:guarded_table_exposed|ADV-2(C): a guarded table is handed to authenticated as its OWNER, and an owner is exempt from its own policies while FORCE is off"
"67|latest|67|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:guarded_table_exposed|ADV-2(C): FORCE ROW LEVEL SECURITY toggled on a guarded table — a hardening, and still drift from the measured baseline"
"68|latest|68|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:guarded_table_exposed|ADV-2(E): a guarded table gains an unguarded inheritance parent, read with the PARENT's policies"
"69|latest|69|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:guarded_table_exposed|ADV-2(F): a new view over a guarded table, running in the view owner's row-security context"
"71|latest|71|normal|owns_account|ACL_DRIFT|env:bypassrls_set_drift|ADV-2(D): authenticated gains the BYPASSRLS role attribute — not superuser, not a membership"
"72|latest|72|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:guarded_table_exposed|ADV-2(F): the tenant boundary removed from accounts_safe, the client's ONLY read path to accounts on this generation"
"75|latest|75|normal|owns_account|AUTHZ_CLOSURE_BROKEN|dep:rls_disabled,dep:policy_set_changed,dep:guarded_policy_set_changed,dep:guarded_table_exposed|R5-CTLPREC(2): a guarded TABLE replaced in place by a VIEW over an unguarded copy of itself — the only mutant that moves the guarded arm's relkind row"
)

# ---------------------------------------------------------------------------
# 2b. mutants the name-only straw man cannot even address
#
# The straw man models what the previous harness did, and the previous harness
# never knew these two routines existed — which is the whole point of F1. It
# emits no object line for them at all, so the suite would score it RED for
# SILENCE rather than for detection, and "the straw man caught mutant 52" would
# be a false claim in the demonstration. They are therefore excluded from the
# straw-man run entirely, and the exclusion is CHECKED below: every id listed
# here must be keyed on an object the straw man genuinely does not enumerate.
# Teaching the straw man those names would make it stronger than the thing it
# is supposed to model.
# ---------------------------------------------------------------------------
NAIVE_UNADDRESSABLE=("52" "53" "54" "55" "56" "57" "58" "59")

# ---------------------------------------------------------------------------
# 2c. RUN-LEVEL mutants — the whole-schema counter-scan
#
# These do not belong in MUTANTS. Every entry there names a catalogue KEY and
# asserts that object's final state; the counter-scan's findings deliberately
# have no key, because "a routine nobody catalogued is executable by anon" is a
# fact about the schema and pinning it to whichever catalogued object happened
# to be listed first would be a lie about where it lives.
#
# AUD-4 is the reason this array exists. A brand-new SECURITY DEFINER wrapper
# over vault.create_secret, granted to anon, through which anon really did
# create a Vault secret, produced a clean PASS: it is in no catalogue, so no
# cc_verdict row ever mentioned it. Worse, by the time that was measured the
# classifier ALREADY CONTAINED the two scanners that see it, their positive and
# negative controls, and an insert into `cc_schema_finding` — and nothing on
# earth selected from that table. The detector was complete and the verdict
# ignored it.
#
#   id | generation | mutation file | required schema codes | description
#
# READ THE RESIDUAL LIMIT before treating a green line here as "no new
# privileged routine can hide": the scan is complete over `public` in exactly
# two dimensions and no others. It is stated in the classifier at section 2e,
# in `pass_does_not_claim` in every JSON report, and in CATALOGUE-CLASSIFIER.md.
# ---------------------------------------------------------------------------
SCHEMA_MUTANTS=(
"70|latest|70|schema:secdef_vault_reacher_unlisted,schema:client_executable_surface_drift|AUD-4: a NEW SECURITY DEFINER vault wrapper, granted to anon, in no catalogue"
"73|latest|73|schema:client_executable_surface_drift|R5-A1: an EXISTING client-executable routine REPURPOSED into SECURITY DEFINER — same signature, same grants, same owner — reading a guarded table"
"74|latest|74|schema:client_executable_surface_drift|R5-A1: an EXISTING client-executable routine REOWNED to a client role — same signature, same grants, same security mode"
)

w 70 <<'SQL'
-- 70. AUD-4. Nothing that already exists is touched. A brand-new privileged
--     routine is added: SECURITY DEFINER, `vault` on its own search_path, a
--     qualified call into vault.create_secret, and EXECUTE to anon. No
--     catalogue row can ever mention it, so the per-object pipeline is blind
--     to it by construction and only a whole-schema counter-scan can see it.
create function public.vault_create_secret_v2(p_secret text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $fn$
declare v_id uuid;
begin
  select vault.create_secret(p_secret, p_name) into v_id;
  return v_id;
end;
$fn$;

grant execute on function public.vault_create_secret_v2(text, text) to anon;
SQL

w 73 <<'SQL'
-- 73. R5-A1. THE BREAK THIS ROUND CLOSED. Nothing NEW is created: an existing
--     routine that `anon`, `authenticated` and `service_role` could already
--     execute is REPURPOSED. `create or replace function` keeps the signature,
--     keeps the ACL and keeps the owner, so the pinned entry
--       public.jwt_role() => anon+authenticated+service_role
--     was byte-identical under the OLD signature-only descriptor and the run
--     returned rc 0, PASS, 41/41 controls, schema_scan.findings [] and all 50
--     authz_closure rows ok — while in the same clone `authenticated` with
--     subject 4444… got owns_account(2222…)=false, 0 rows from a direct select
--     on public.equity_snapshots, and all 21 of victim 2222…'s rows out of this
--     routine. With `secdef=` in the descriptor the same mutation is
--     schema:client_executable_surface_drift.
--     41 is the control count of the classifier AS IT THEN STOOD; the same
--     round added C39. Reproduced against today's file — descriptor, pin
--     format and the two control clauses R5 added reverted, nothing else — the
--     figure is 42/42, findings [], 50/50 closure rows, 38 pinned entries
--     byte-identical, and the same 21 rows on the wire. Expect 42, not 41,
--     if you rerun the red-before.
create or replace function public.jwt_role() returns text
language sql security definer stable
set search_path = pg_catalog, public
as $fn$
  select coalesce(string_agg(e.account_id::text || ':' || e.snapshot_date::text
                             || ':' || e.equity::text, '|' order by e.snapshot_date), '<none>')
    from public.equity_snapshots e
   where e.account_id = '22222222-2222-4222-8222-222222222222'::uuid
$fn$;
SQL

w 74 <<'SQL'
-- 74. R5-A1, the OWNER half. `alter function ... owner to` keeps the signature,
--     keeps the grant list and keeps `prosecdef`, so this moves ONLY the second
--     of the two properties R5-A1 added to the descriptor. Without a mutant of
--     its own that column would be pinned and never falsified.
--     It is a real escalation and not just drift: the owner of a routine may
--     `create or replace` it, so handing public.is_service_role() to
--     `authenticated` hands every client the ability to redefine a predicate
--     the schema authorises with — mutant 73's body, installed by the client.
alter function public.is_service_role() owner to authenticated;
SQL

# ---------------------------------------------------------------------------
# 3. reason codes declared unreachable
#
# A code may be left without a mutant ONLY by appearing here with a written
# justification. The suite then verifies the declaration two ways: the code
# must still exist in the classifier (so this list cannot be used to retire a
# check quietly), and it must never appear in ANY report the run produces.
# ---------------------------------------------------------------------------
JUSTIFIED=(
"tomb:probe_side_effect|The privileged tombstone probe is invoked only when tomb_probe_safe holds, and that predicate requires the body to match the shape derived from migration 0022 — 'begin raise exception <literal> using errcode = <literal>; end;' and nothing else. Controls C05 and C06 in the classifier prove that shape accepts the derived body and rejects a live one, so a body that reaches the probe cannot write. The check is defence in depth against the shape itself being wrong. Its DETECTOR is proven live by classifier control C17, which wraps the same counter around a statement that really does write to vault.secrets and requires the difference to be seen; and this suite requires the code never to appear in any report."
"tomb:probe_not_invoked|UNREACHABLE BY CONSTRUCTION SINCE THE TOMB PROBE STOPPED BEING AN \`ELSE\` BRANCH. The code fires when tomb_probe_safe holds and no tomb probe row exists. tomb_probe_safe is \`o.body_norm is not null and tt.body_shape is not null and o.body_norm ~ tt.body_shape\`, so it implies a cc_tomb_target row exists, which is exactly tomb_applicable. tomb_gate is \`tomb_applicable and resolved and not wrong_kind and tomb_probe_safe\`, so the only ways to be safe-but-unselected are 'not resolved' or 'wrong_kind' — and both mean there is no routine body to normalise, which makes tomb_probe_safe false. Every other path INSERTS a row (probe_mode=skip, and 'no privileged probe is defined for this key'), so those report tomb:probe_missing instead. Mutant 46 used to elicit this: dressing the tombstone up as the live profile selected the live probe and skipped the privileged one. It no longer can, and that is the improvement — gating the tombstone probe on 'the live structure did not match' left BOTH of migration 0017's shims unprobed, because 0017's shims differ from the live 0014 definitions in nothing but the body. Its DETECTOR is guarded live by assert_mutant_46_evidence in this suite, which requires mutant 46's report to show probe kind=tomb, ran=true, the derived SQLSTATE, and zero side effects; if the tombstone probe ever stops being invoked for a safe body, that assertion goes red in the same run. This suite additionally requires the code never to appear in any report."
"dep:closure_missing|UNREACHABLE BY CONSTRUCTION, and deliberately kept. cc_dep_obs is built as an unfiltered \`create temporary table cc_dep_obs as select ... from cc_dep_expect\`, so it carries exactly one row per declared dependency and can never be empty while cc_dep_expect is not. No schema mutation can make this code fire: the other four dep: codes are what a real closure break produces. It exists as defence in depth against a later edit that filters that SELECT — \`where observed is not null\` would be the obvious one, and it would silently switch off the entire closure check for precisely the dependency that stopped resolving. Its DETECTOR is proven live by classifier control C29, which requires at least ten closure rows to have been observed, none of them null, and a known-good row to read back the right value; if cc_dep_obs ever went empty or filtered, C29 goes red in the same run. This suite additionally requires the code never to appear in any report."
)

# ---------------------------------------------------------------------------
# 4. --only: an empty selection is a hard error
#
# A selection that matches nothing used to run zero mutants and report SUITE
# GREEN, which is the most dangerous possible answer: a typo in an id turned
# the falsification suite into a no-op that still said everything was fine.
# ---------------------------------------------------------------------------
SELECTED_IDS=()
if [[ -n "$ONLY" ]]; then
  IFS=',' read -ra REQ_IDS <<< "$ONLY"
  UNMATCHED=()
  for want_id in "${REQ_IDS[@]}"; do
    [[ -n "$want_id" ]] || continue
    hit=0
    # Run-level counter-scan mutants are selectable too. If they were not in
    # this loop, `--only 70` would be rejected as an unknown id — and worse,
    # any future --only list would quietly exclude a whole class of mutant.
    for spec in "${MUTANTS[@]}" "${SCHEMA_MUTANTS[@]}" "${CONTROL_FALSIFICATIONS[@]}"; do
      [[ "${spec%%|*}" == "$want_id" ]] && { hit=1; break; }
    done
    if [[ "$hit" -eq 1 ]]; then SELECTED_IDS+=("$want_id"); else UNMATCHED+=("$want_id"); fi
  done
  known_ids="$(printf '%s\n' "${MUTANTS[@]}" "${SCHEMA_MUTANTS[@]}" \
                 "${CONTROL_FALSIFICATIONS[@]}" | cut -d'|' -f1 | paste -sd,)"
  if [[ "${#UNMATCHED[@]}" -gt 0 ]]; then
    printf '\n\033[1;31mHARNESS ERROR\033[0m --only names %d id(s) that no mutant carries: %s\n' \
      "${#UNMATCHED[@]}" "$(IFS=,; printf '%s' "${UNMATCHED[*]}")" >&2
    printf 'known ids: %s\n' "$known_ids" >&2
    exit "$EXIT_HARNESS"
  fi
  if [[ "${#SELECTED_IDS[@]}" -eq 0 ]]; then
    printf '\n\033[1;31mHARNESS ERROR\033[0m --only %q selected no mutants at all\n' "$ONLY" >&2
    printf 'known ids: %s\n' "$known_ids" >&2
    exit "$EXIT_HARNESS"
  fi
  info "--only selects ${#SELECTED_IDS[@]} mutant(s): $(IFS=,; printf '%s' "${SELECTED_IDS[*]}")"
fi

# ---------------------------------------------------------------------------
# 5. reason-code coverage
#
# Parsed from the classifier's own registry, so it cannot drift from what the
# classifier can actually emit. Runs before anything is started: it is a
# property of the files, not of the run.
# ---------------------------------------------------------------------------
hdr "1. reason-code coverage"

{
  printf '%s\n' "${MUTANTS[@]}" | cut -d'|' -f7
  # The run-level counter-scan codes are registered in the same registry, so
  # they must face the same coverage requirement. Omitting them here would let
  # a schema code sit in the registry with nothing that falsifies it — which is
  # how `schema:*` came to exist, be inserted, and be read by nothing.
  printf '%s\n' "${SCHEMA_MUTANTS[@]}" | cut -d'|' -f4
} | tr ',' '\n' \
  | sed 's|^@[a-z_]*/||' | grep -v '^$' | LC_ALL=C sort -u > "$WORK/required-codes.txt"
printf '%s\n' "${JUSTIFIED[@]}" | cut -d'|' -f1 | grep -v '^$' \
  | LC_ALL=C sort -u > "$WORK/justified-codes.txt"

if ! python3 - "$REAL_ORACLE" "$WORK/registry-codes.txt" <<'PY'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"insert into cc_reason_registry\(code, category, note\) values\n(.*?);\n",
              src, re.S)
if not m:
    sys.stderr.write("   could not find the reason-code registry in the classifier\n")
    sys.exit(1)
codes = re.findall(r"^\s*\('([^']+)','([^']+)','", m.group(1), re.M)
# POSITIVE CONTROL on this parser: an empty or tiny parse would silently make
# every coverage claim below trivially true.
if len(codes) < 40:
    sys.stderr.write("   the registry parser found only %d codes; it is not working\n" % len(codes))
    sys.exit(1)
names = [c for c, _ in codes]
for must in ("tomb:acl_public_execute", "sig_absent", "expected_state_mismatch"):
    if must not in names:
        sys.stderr.write("   the registry parser did not find %r; it is not working\n" % must)
        sys.exit(1)
if "zz:not_a_real_code" in names:
    sys.stderr.write("   the registry parser invented a code that is not there\n")
    sys.exit(1)
if len(set(names)) != len(names):
    sys.stderr.write("   the registry declares a duplicate code\n")
    sys.exit(1)
open(sys.argv[2], "w", encoding="utf-8").write("\n".join(sorted(names)) + "\n")
print("   registry parsed: %d reason codes the classifier can emit" % len(names))
PY
then
  bad "the reason-code registry could not be read; coverage cannot be asserted"
  exit "$EXIT_CONTROL"
fi

cov_ok=1

UNCOVERED="$(LC_ALL=C comm -23 "$WORK/registry-codes.txt" \
              <(LC_ALL=C sort -u "$WORK/required-codes.txt" "$WORK/justified-codes.txt"))"
if [[ -n "$UNCOVERED" ]]; then
  bad "reason codes the classifier can emit that NO mutant requires and NO"
  bad "justification covers — each of these is a check that could be deleted"
  bad "without turning this suite red:"
  printf '     %s\n' $UNCOVERED
  cov_ok=0
fi

STALE_REQ="$(LC_ALL=C comm -23 "$WORK/required-codes.txt" "$WORK/registry-codes.txt")"
if [[ -n "$STALE_REQ" ]]; then
  bad "mutants require reason codes the classifier cannot emit (deleted check,"
  bad "or a typo in the mutant table):"
  printf '     %s\n' $STALE_REQ
  cov_ok=0
fi

STALE_JUST="$(LC_ALL=C comm -23 "$WORK/justified-codes.txt" "$WORK/registry-codes.txt")"
if [[ -n "$STALE_JUST" ]]; then
  bad "codes declared unreachable that the classifier does not even have:"
  printf '     %s\n' $STALE_JUST
  cov_ok=0
fi

BOTH="$(LC_ALL=C comm -12 "$WORK/required-codes.txt" "$WORK/justified-codes.txt")"
if [[ -n "$BOTH" ]]; then
  bad "codes both required by a mutant and declared unreachable:"
  printf '     %s\n' $BOTH
  cov_ok=0
fi

# Every registered code must appear in the classifier at least twice: once in
# the registry, at least once in a check. Deleting the check leaves one.
# Positive/negative control on the counter itself first.
# THE COUNT IS TAKEN OVER THE CLASSIFIER WITH ITS COMMENTS REMOVED.
#
# This counter is the whole of the "the check behind this code still exists"
# assertion, and it used to `grep` the RAW file. A registered code whose real
# check had been deleted, but which was still NAMED in a comment — a section
# header, a justification, a `-- emits foo:bar` note — counted 2 and passed.
# Four guards in this programme have already fired on their own documentation;
# this one was one comment away from doing the opposite, which is worse,
# because a guard that passes on documentation is silent.
#
# Measured before changing anything: all 62 registered codes currently have two
# or more occurrences even after stripping, so this repair fixes a latent
# weakness rather than an active false green. The controls below are what stop
# it becoming an active one.
strip_sql_comments_to() {  # src, dst — removes -- and /* */ but not strings
  python3 - "$1" "$2" <<'PY'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
out, i, n = [], 0, len(src)
while i < n:
    c = src[i]
    if c == '$':                                   # dollar-quoted body: verbatim
        m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", src[i:])
        if m:
            tag = m.group(0); end = src.find(tag, i + len(tag))
            if end == -1: out.append(src[i:]); break
            out.append(src[i:end + len(tag)]); i = end + len(tag); continue
    if c == "'":                                   # string literal: verbatim
        j = i + 1
        while j < n:
            if src[j] == "'":
                if j + 1 < n and src[j+1] == "'": j += 2; continue
                break
            j += 1
        out.append(src[i:j+1]); i = j + 1; continue
    if src.startswith('--', i):
        j = src.find('\n', i)
        if j == -1: break
        out.append('\n'); i = j + 1; continue
    if src.startswith('/*', i):
        depth, j = 1, i + 2
        while j < n and depth:
            if src.startswith('/*', j): depth += 1; j += 2
            elif src.startswith('*/', j): depth -= 1; j += 2
            else: j += 1
        out.append(' '); i = j; continue
    out.append(c); i += 1
open(sys.argv[2], "w", encoding="utf-8").write(''.join(out))
PY
}

ORACLE_NOCOMMENTS="$WORK/oracle-nocomments.sql"
if ! strip_sql_comments_to "$REAL_ORACLE" "$ORACLE_NOCOMMENTS"; then
  bad "could not strip comments from the classifier; the orphan check cannot run"
  exit "$EXIT_CONTROL"
fi

# NOTE ON WHAT IS COUNTED: `grep -c` counts LINES THAT MATCH, not occurrences.
# That is deliberate and is the stricter reading — "this code appears on at
# least two distinct lines" cannot be satisfied by one line that happens to
# name it twice. The controls below are written in the same units, and the
# first draft of them was wrong about exactly this: it planted four occurrences
# across three lines and demanded 4, and the control fired on its own author.
count_in_oracle() {  # LINES naming a quoted literal, comments excluded
  local n
  # grep -c prints 0 and exits 1 when there is no match. Zero IS the answer
  # here, so it is mapped explicitly; anything that is not a number (a grep
  # that failed for a real reason) becomes -1, which fails every check below.
  n="$(grep -F -c -- "'$1'" "$ORACLE_NOCOMMENTS")" || n=0
  case "$n" in ''|*[!0-9]*) n=-1 ;; esac
  printf '%s' "$n"
}
count_in_file() {  # same matcher, any file — used by the controls below
  local n
  n="$(grep -F -c -- "'$1'" "$2")" || n=0
  case "$n" in ''|*[!0-9]*) n=-1 ;; esac
  printf '%s' "$n"
}

ctl_known="$(count_in_oracle 'tomb:acl_public_execute')"
ctl_absent="$(count_in_oracle 'zz:not_a_real_code')"
if [[ "$ctl_known" -lt 2 || "$ctl_absent" -ne 0 ]]; then
  bad "the occurrence counter is not working (known code counted ${ctl_known}, absent code ${ctl_absent})"
  exit "$EXIT_CONTROL"
fi

# POSITIVE CONTROL ON THE STRIPPER, planted and measured, both directions.
# A stripper that silently returned its input would restore the old defect
# without changing a single count, so it is not enough to check that the file
# is non-empty: an occurrence is PLANTED in a comment and must be invisible
# here while remaining visible in the raw file, and a second one is planted in
# real code and must remain visible in both.
# Three lines name the comment-only probe and must all vanish; two lines name
# the code probe and must both survive. The THIRD planted line is the one that
# matters most: it is half code and half trailing comment, so a stripper that
# threw away whole lines instead of comment spans would lose a real occurrence
# and be caught here rather than by a silently shrinking orphan count.
ctl_plant="$WORK/oracle-stripper-control.sql"
cp "$REAL_ORACLE" "$ctl_plant"
{ printf -- "-- line comment naming 'zz:comment_only_probe'\n"
  printf -- "/* block comment naming 'zz:comment_only_probe' */\n"
  printf -- "select 'zz:code_probe' as x; -- trailing comment naming 'zz:comment_only_probe'\n"
  printf -- "select 'zz:code_probe' as y;\n"; } >> "$ctl_plant"
ctl_plant_stripped="$WORK/oracle-stripper-control.nocomments.sql"
if ! strip_sql_comments_to "$ctl_plant" "$ctl_plant_stripped"; then
  bad "the stripper failed on its own control input"
  exit "$EXIT_CONTROL"
fi
p_raw_comment="$(count_in_file 'zz:comment_only_probe' "$ctl_plant")"
p_str_comment="$(count_in_file 'zz:comment_only_probe' "$ctl_plant_stripped")"
p_raw_code="$(count_in_file 'zz:code_probe' "$ctl_plant")"
p_str_code="$(count_in_file 'zz:code_probe' "$ctl_plant_stripped")"
ctl_known_stripped_src="$(count_in_file 'tomb:acl_public_execute' "$ctl_plant_stripped")"
if [[ "$p_raw_comment" -ne 3 || "$p_str_comment" -ne 0 \
      || "$p_raw_code" -ne 2 || "$p_str_code" -ne 2 \
      || "$ctl_known_stripped_src" -ne "$ctl_known" ]]; then
  bad "the comment stripper is not discriminating: a code planted in comments"
  bad "  counted raw=${p_raw_comment} stripped=${p_str_comment} (want 3/0); planted in code"
  bad "  counted raw=${p_raw_code} stripped=${p_str_code} (want 2/2); and a real code counted"
  bad "  ${ctl_known_stripped_src} where the classifier itself counts ${ctl_known}"
  exit "$EXIT_CONTROL"
fi
info "orphan counter reads the classifier with comments stripped; a code named"
info "  only in a comment counts 0 (planted and measured, both directions)"
ORPHANED=""
while IFS= read -r code; do
  [[ -n "$code" ]] || continue
  n="$(count_in_oracle "$code")"
  if [[ "$n" -lt 2 ]]; then ORPHANED="${ORPHANED} ${code}(${n})"; fi
done < "$WORK/registry-codes.txt"
if [[ -n "$ORPHANED" ]]; then
  bad "registered codes that appear nowhere but the registry — the check behind"
  bad "them is gone:${ORPHANED}"
  cov_ok=0
fi

if [[ "$cov_ok" -eq 1 ]]; then
  good "every one of $(wc -l < "$WORK/registry-codes.txt") reason codes is required by a mutant"
  good "  or declared unreachable, and every declared code still exists in the classifier"
  while IFS='|' read -r jcode jwhy; do
    [[ -n "$jcode" ]] || continue
    info "declared unreachable: ${jcode}"
    printf '%s\n' "$jwhy" | fold -s -w 74 | sed 's/^/       /'
  done < <(printf '%s\n' "${JUSTIFIED[@]}")
fi

# ---------------------------------------------------------------------------
# 5b. tombstone-name coverage IN THIS SUITE
#
# The classifier's control C20 requires an expectation row for every routine
# the MIGRATION SET tombstones — the union over both shim mechanisms, which
# spans 0017 and 0022, not one section of one file. This is the same
# requirement one level up: every one of those names must be the key of at
# least one mutant. Without it, a newly derived tombstone could gain an
# expectation row that nothing ever falsifies — an object the suite watches but
# never tests, which is how a check becomes deletable in silence.
#
# `derived_names` is read out of the extractor in control 0g and pinned there,
# so this loop cannot go vacuous by the name list quietly shrinking.
# ---------------------------------------------------------------------------
hdr "1b. every routine the migration set tombstones is exercised by a mutant"

printf '%s\n' "${MUTANTS[@]}" | cut -d'|' -f5 | LC_ALL=C sort -u > "$WORK/mutant-keys.txt"
untested=""
for n in $(printf '%s' "$derived_names" | tr ',' ' '); do
  grep -qx -- "$n" "$WORK/mutant-keys.txt" || untested="${untested} ${n}"
done
if [[ -n "$untested" ]]; then
  bad "routines the migration set tombstones that NO mutant targets:${untested}"
  bad "  derived tombstones          : ${derived_names}"
  bad "  keys this suite exercises: $(paste -sd, "$WORK/mutant-keys.txt")"
  cov_ok=0
else
  good "every one of the $(printf '%s' "$derived_names" | tr ',' '\n' | grep -c .) tombstoned"
  good "  routines is the key of at least one mutant: ${derived_names}"
fi

# POSITIVE CONTROL on the matcher the exclusion check below uses.
#
# What follows is a NEGATIVE assertion — "the straw man does not mention this
# name" — and its whole weight rests on a grep. A grep that could find nothing
# at all (an emptied or mis-pathed naive-oracle.sql; a matcher that silently
# stopped matching) would report every one of the eight exclusions as
# justified, which is the permissive direction: eight mutants would be dropped
# from the straw-man demonstration on the strength of a scan nobody proved
# works. So the same matcher must first FIND names naive-oracle.sql certainly
# enumerates, and must NOT find one that is certainly absent.
naive_matcher_ok=1
naive_matcher_detail=""
for present in vault_create_secret vault_delete_secret vault_update_secret owns_account; do
  if ! grep -F -q -- "$present" "$NAIVE_ORACLE"; then
    naive_matcher_ok=0
    naive_matcher_detail="${naive_matcher_detail} could-not-find:${present}"
  fi
done
if grep -F -q -- 'zz_not_in_the_straw_man' "$NAIVE_ORACLE"; then
  naive_matcher_ok=0
  naive_matcher_detail="${naive_matcher_detail} matched-an-absent-string"
fi
if [[ "$naive_matcher_ok" -ne 1 ]]; then
  bad "the straw-man exclusion matcher is not working:${naive_matcher_detail}"
  bad "  Every 'this exclusion is justified' verdict below would be vacuous, and"
  bad "  eight mutants would be dropped from the demonstration on that basis."
  cov_ok=0
else
  good "the straw-man exclusion matcher finds all four keys naive-oracle.sql does"
  good "  enumerate, and does not match a string that is absent from it"
fi

# The straw-man exclusions must be exclusions of things the straw man really
# cannot address, not a way to hide mutants it fails.
naive_unaddr_bad=""
for id in "${NAIVE_UNADDRESSABLE[@]}"; do
  k="$(printf '%s\n' "${MUTANTS[@]}" | awk -F'|' -v want="$id" '$1==want {print $5; exit}')"
  if [[ -z "$k" ]]; then
    naive_unaddr_bad="${naive_unaddr_bad} ${id}(no such mutant)"
  elif grep -F -q -- "${k}" "$NAIVE_ORACLE"; then
    # Deliberately a bare substring match: if the straw man mentions the name
    # anywhere, even in a comment, the exclusion stops being obviously safe and
    # a human should look rather than the suite deciding for itself.
    naive_unaddr_bad="${naive_unaddr_bad} ${id}(${k} IS mentioned by the straw man)"
  fi
done
if [[ -n "$naive_unaddr_bad" ]]; then
  bad "straw-man exclusions that are not justified:${naive_unaddr_bad}"
  cov_ok=0
else
  good "the ${#NAIVE_UNADDRESSABLE[@]} mutants excluded from the straw-man run are all keyed on"
  good "  objects naive-oracle.sql does not enumerate at all"
fi

# ---------------------------------------------------------------------------
# 6. runners
# ---------------------------------------------------------------------------
RESULTS_FILE=""
JUSTIFIED_SEEN=""

run_case() {  # oracle-sql, generation, mutation-file-or-empty, probe-mode, label, tag
  local oracle="$1" gen="$2" mut="$3" pmode="$4" label="$5" tag="$6"
  local -a args=( --generation "$gen" --probe-mode "$pmode" --classifier "$oracle"
                  --quiet --out "$WORK/$tag.txt" --json "$WORK/$tag.json"
                  --mutate-label "$label" )
  [[ -z "$mut" ]] || args+=( --mutate "$mut" )
  set +e
  "$DRIVER" "${args[@]}" > "$WORK/$tag.driver.txt" 2>&1
  local rc=$?
  set -e
  printf '%s' "$rc"
}

# Pull one object's fields out of a transcript. A missing line is a harness
# error, never a silent pass.
object_field() {  # transcript, key, field-index (2=expected 3=observed 4=final 5=reasons)
  local file="$1" key="$2" idx="$3" line
  if ! line="$(grep -m1 -F "CATALOGUE_CLASSIFY_OBJECT=${key}|" "$file")"; then
    printf '__NO_SUCH_OBJECT_LINE__'
    return 0
  fi
  printf '%s' "${line#CATALOGUE_CLASSIFY_OBJECT=}" | cut -d'|' -f"$idx"
}

# Required reasons, checked against the JSON report so a scoped requirement
# (@live_misses/…) can be expressed. Prints one line per requirement not met.
#
# THE DECISIVE `reasons` ARRAY IS COMPARED FOR EQUALITY, NOT CONTAINMENT.
# This used to test membership only, in both directions of laxity: a mutant
# listing two codes passed against a report carrying five, and a mutant that
# stopped eliciting one of its codes while eliciting a different one passed as
# long as the named ones survived. Every mutant expectation was therefore a
# LOWER BOUND wearing the words "the exact reason codes" in the verdict banner.
# Concretely: adding the ADV-1 policy-set arm made mutant 63 emit a second
# decisive code, and under containment that was invisible — the suite would
# have gone on printing "exact reason codes" over a profile that had changed
# underneath it.
#
# The `@array/code` form stays CONTAINMENT, deliberately and narrowly: those
# arrays (structural_misses, env_misses, live_misses, tomb_misses) are the raw
# per-profile miss lists, they legitimately carry codes that are not decisive
# for the profile expected on that object, and pinning them exactly would be a
# different and much larger assertion. What is NOT allowed is a mutant with no
# decisive requirement at all — that would make the equality vacuous — so that
# is reported as a failure rather than skipped.
check_reasons() {  # json, key, comma-separated requirements
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
path, key, wanted = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    doc = json.load(open(path))
except Exception as exc:
    print("could not read the JSON report: %s" % exc); sys.exit(0)
objs = {o["key"]: o for o in doc.get("objects") or []}
if key not in objs:
    print("the JSON report has no object %r" % key); sys.exit(0)
obj = objs[key]

exact, scoped = [], []
for req in [r for r in wanted.split(",") if r]:
    if req.startswith("@"):
        field, code = req[1:].split("/", 1)
        scoped.append((field, code))
    else:
        exact.append(req)

if not exact:
    print("this mutant declares no decisive reason code, so its profile is a "
          "lower bound and cannot be asserted exactly; give it at least one "
          "unscoped code")
else:
    got = obj.get("reasons")
    if got is None:
        print("no reasons array in the report for %s" % key)
    else:
        missing  = sorted(set(exact) - set(got))
        unexpect = sorted(set(got) - set(exact))
        if missing:
            print("missing decisive reason(s) %s (reasons were: %s)"
                  % (",".join(missing), ",".join(got) or "-"))
        if unexpect:
            print("UNEXPECTED decisive reason(s) %s: the reasons array is %s but "
                  "this mutant pins exactly %s — a profile that changed under a "
                  "containment check is a profile nobody is asserting"
                  % (",".join(unexpect), ",".join(got) or "-", ",".join(sorted(exact))))

for field, code in scoped:
    got = obj.get(field)
    if got is None:
        print("no %s array in the report for %s" % (field, key)); continue
    if code not in got:
        print("missing %s '%s' (got: %s)" % (field, code, ",".join(got) or "-"))
PY
}

# POSITIVE CONTROL ON check_reasons ITSELF.
#
# check_reasons is rejection-shaped: its passing value is the empty string, and
# so is the value it takes when it silently stops working — a typo in the JSON
# key, an exception swallowed by the `except` above, a report shape that changed.
# Every mutant in the suite would then be scored on `final` alone and the run
# would still print "with the exact state and the exact reason codes". So it is
# driven over synthetic reports here, before anything is started, and required
# to be SILENT on the exact profile and LOUD on each of the four ways a profile
# can be wrong.
assert_check_reasons_works() {
  local dir="$WORK/cr-ctl"; mkdir -p "$dir"
  cat > "$dir/report.json" <<'JSON'
{"objects":[{"key":"k","reasons":["a:one","a:two"],
             "live_misses":["a:one","a:two","a:three"],
             "tomb_misses":["b:one"]}]}
JSON
  local out problems=0
  # 1. the exact profile must be silent
  out="$(check_reasons "$dir/report.json" k "a:one,a:two")"
  if [[ -n "$out" ]]; then
    bad "check_reasons complained about an exactly-matching profile: ${out}"; problems=1
  fi
  # 2. a missing decisive code must be named
  out="$(check_reasons "$dir/report.json" k "a:one,a:two,a:missing")"
  if [[ "$out" != *"missing decisive reason(s) a:missing"* ]]; then
    bad "check_reasons did not report a missing decisive code; said: ${out:-<nothing>}"; problems=1
  fi
  # 3. THE ADV-1 CASE: an unexpected decisive code must be named
  out="$(check_reasons "$dir/report.json" k "a:one")"
  if [[ "$out" != *"UNEXPECTED decisive reason(s) a:two"* ]]; then
    bad "check_reasons accepted a report carrying a decisive code the mutant does"
    bad "  not pin — expectations would be lower bounds again; said: ${out:-<nothing>}"; problems=1
  fi
  # 4. a scoped requirement is containment, and a satisfied one is silent
  out="$(check_reasons "$dir/report.json" k "a:one,a:two,@live_misses/a:three")"
  if [[ -n "$out" ]]; then
    bad "check_reasons rejected a legitimate scoped requirement: ${out}"; problems=1
  fi
  out="$(check_reasons "$dir/report.json" k "a:one,a:two,@tomb_misses/b:nope")"
  if [[ "$out" != *"missing tomb_misses 'b:nope'"* ]]; then
    bad "check_reasons did not report an unmet scoped requirement; said: ${out:-<nothing>}"; problems=1
  fi
  # 5. a mutant with only scoped requirements must be refused, not waved through
  out="$(check_reasons "$dir/report.json" k "@live_misses/a:one")"
  if [[ "$out" != *"declares no decisive reason code"* ]]; then
    bad "check_reasons accepted a mutant with no decisive requirement; said: ${out:-<nothing>}"; problems=1
  fi
  # 6. an absent object must be loud, not silent
  out="$(check_reasons "$dir/report.json" nosuch "a:one")"
  if [[ "$out" != *"has no object"* ]]; then
    bad "check_reasons was silent about an object that is not in the report"; problems=1
  fi
  if [[ "$problems" -eq 0 ]]; then
    good "check_reasons control: silent on the exact profile; loud on a missing code,"
    good "  an UNEXPECTED decisive code, an unmet scoped requirement, a mutant with"
    good "  no decisive code, and an object the report does not carry"
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# The four readers of a results file, defined ONCE.
#
# These were four inline awk one-liners, two in the real half and two in the
# naive half, and the naive half had no count at all. Inline copies cannot be
# controlled: a control that re-types the expression proves the copy in the
# control works. Both halves now call these, and assert_row_readers_work drives
# them over a synthetic file whose answers are known.
# ---------------------------------------------------------------------------
count_mutant_rows()   { awk '$1 !~ /^P/ {n++} END {print n+0}' "$1"; }
count_pristine_rows() { awk '$1 ~  /^P/ {n++} END {print n+0}' "$1"; }
red_mutant_ids()      { awk '$2=="red" && $3 !~ /^harness_rc_/ && $1 !~ /^P/ \
                             {printf "%s%s", sep, $1; sep=","}' "$1"; }
broken_cell_ids()     { awk '($2=="red" && $3 ~ /^harness_rc_/) || ($1 ~ /^P/ && $2=="red") \
                             {printf "%s%s", sep, $1; sep=","}' "$1"; }

# POSITIVE CONTROL on all four. Each is count-shaped or empty-set-shaped, so a
# reader that silently stopped matching would report 0 / "" — the same values a
# clean run produces for the ones that must be empty. The synthetic file below
# has one row of every kind and the expected answers are written out.
assert_row_readers_work() {
  local f="$WORK/row-reader-ctl.txt" problems=0 got
  cat > "$f" <<'ROWS'
P0008 green -
Platest red some_detail
01 red -
02 green -
03 red harness_rc_2
ROWS
  got="$(count_mutant_rows "$f")"
  [[ "$got" == 3 ]] || { bad "count_mutant_rows read ${got}, expected 3"; problems=1; }
  got="$(count_pristine_rows "$f")"
  [[ "$got" == 2 ]] || { bad "count_pristine_rows read ${got}, expected 2"; problems=1; }
  got="$(red_mutant_ids "$f")"
  [[ "$got" == "01" ]] || {
    bad "red_mutant_ids read '${got}', expected '01' — a harness-refused cell (03)"
    bad "  and a red pristine cell (Platest) must not be counted as blindness"
    problems=1; }
  got="$(broken_cell_ids "$f")"
  [[ "$got" == "Platest,03" ]] || {
    bad "broken_cell_ids read '${got}', expected 'Platest,03'"; problems=1; }
  if [[ "$problems" -eq 0 ]]; then
    good "results-file readers: 3 mutant rows, 2 pristine rows, blind=[01],"
    good "  broken=[Platest,03] on a synthetic file with one row of every kind"
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# The documentation's mutant tables are a TRANSCRIPTION of the MUTANTS array,
# and an unchecked transcription drifts silently — which is this directory's
# most-repeated finding, one level sideways. Measured when the ADV-1 exactness
# change landed: repinning 30 mutants left CATALOGUE-CLASSIFIER.md stating 30
# reason profiles that no longer existed, and nothing anywhere would have said
# so. A reader trusts the document; the document must be checked like a pin.
#
# SCOPE: the per-object MUTANTS table only. Run-level cells (SCHEMA_MUTANTS,
# CONTROL_FALSIFICATIONS) are documented in prose rows whose id cell is
# backticked, so this parser does not see them and does not claim to.
# ---------------------------------------------------------------------------
assert_doc_matches_mutants() {
  local doc="${CONTAINMENT}/CATALOGUE-CLASSIFIER.md"
  [[ -f "$doc" ]] || { bad "CATALOGUE-CLASSIFIER.md is missing"; return 1; }
  printf '%s\n' "${MUTANTS[@]}" > "$WORK/mutants.declared.txt"
  doc_mutant_check "$doc" "$WORK/mutants.declared.txt" || return 1

  # RED-BEFORE, on a copy: delete one code from one documented row and the same
  # reader must refuse, naming the row. Without this the check above is another
  # empty-set assertion whose passing value is also its failure-to-run value.
  local doctored="$WORK/doc-redbefore.md"
  python3 - "$doc" "$doctored" <<'PY' || { bad "could not doctor the documentation"; return 1; }
import re, sys
lines = open(sys.argv[1], encoding="utf-8").read().splitlines(keepends=True)
done = False
out = []
for line in lines:
    st = line.rstrip("\n")
    if not done and st.startswith("| 04 |") and st.endswith("|"):
        cells = st[1:-1].split("|")
        codes = re.findall(r"`([^`]+)`", cells[3])
        if len(codes) > 1:
            cells[3] = " " + ", ".join("`%s`" % c for c in codes[:-1]) + " "
            line = "|" + "|".join(cells) + "|\n"
            done = True
    out.append(line)
if not done:
    sys.stderr.write("   could not find a documented row for mutant 04 to doctor\n")
    sys.exit(1)
open(sys.argv[2], "w", encoding="utf-8").write("".join(out))
PY
  local err
  if err="$(doc_mutant_check "$doctored" "$WORK/mutants.declared.txt" 2>&1)"; then
    bad "the documentation reader ACCEPTED a table row missing a reason code;"
    bad "  it is not comparing anything"
    return 1
  fi
  if [[ "$err" != *"mutant 04"* ]]; then
    bad "the documentation reader refused the doctored table for the wrong reason:"
    printf '%s\n' "$err" >&2
    return 1
  fi
  good "documentation: every MUTANTS row is transcribed with the same verdict and"
  good "  the same reason set, and deleting one code from one documented row makes"
  good "  the reader refuse, naming that row"
  return 0
}

doc_mutant_check() {  # doc.md, declared.txt
  python3 - "$1" "$2" <<'PY'
import re, sys
doc = open(sys.argv[1], encoding="utf-8").read().splitlines()
declared = {}
for line in open(sys.argv[2], encoding="utf-8"):
    line = line.strip()
    if not line: continue
    f = line.split("|")
    declared[f[0]] = (f[5], set(c for c in f[6].split(",") if c))

problems = []
rows = {}
for line in doc:
    st = line.rstrip()
    if not (st.startswith("|") and st.endswith("|")): continue
    cells = [c.strip() for c in st[1:-1].split("|")]
    if len(cells) != 4: continue
    if not re.fullmatch(r"[0-9]{2}[a-c]?", cells[0]): continue
    if cells[0] in rows:
        problems.append("mutant %s is documented in two different rows, so one of "
                        "them is unread" % cells[0])
    rows[cells[0]] = (cells[2], set(re.findall(r"`([^`]+)`", cells[3])))

# POSITIVE CONTROL on this parser: a parse that found nothing, or a handful,
# would make every comparison below trivially satisfiable.
if len(rows) < 60:
    problems.append("the documentation-table parser found only %d mutant row(s); it "
                    "is not working" % len(rows))
for must in ("01", "64"):
    if must not in rows:
        problems.append("the parser did not find the documented row for mutant %s; it "
                        "is not working" % must)
if "99" in rows:
    problems.append("the parser invented a row for a mutant that does not exist")

if not problems:
    undocumented = sorted(set(declared) - set(rows))
    phantom     = sorted(set(rows) - set(declared))
    if undocumented:
        problems.append("declared but not documented: %s" % undocumented)
    if phantom:
        problems.append("documented but not declared: %s" % phantom)
    for mid in sorted(set(declared) & set(rows)):
        want_state, want_codes = declared[mid]
        got_state, got_codes = rows[mid]
        if got_state != "`%s`" % want_state:
            problems.append("mutant %s: the document says the verdict is %s, the suite "
                            "asserts `%s`" % (mid, got_state, want_state))
        if got_codes != want_codes:
            problems.append("mutant %s: the document lists %s, the suite asserts %s"
                            % (mid, sorted(got_codes), sorted(want_codes)))
if problems:
    for p in problems:
        sys.stderr.write("   documentation: %s\n" % p)
    sys.exit(1)
print("   documentation: %d mutant row(s) transcribed exactly" % len(rows))
PY
}

# Any code declared unreachable that shows up anywhere in a report falsifies
# the declaration.
scan_justified() {  # json
  local j="$1"
  [[ -f "$j" ]] || return 0
  local hit
  hit="$(python3 - "$j" "$WORK/justified-codes.txt" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
just = {l.strip() for l in open(sys.argv[2]) if l.strip()}
seen = set()
for o in doc.get("objects") or []:
    for f in ("reasons", "structural_misses", "env_misses", "live_misses", "tomb_misses"):
        for c in o.get(f) or []:
            if c in just:
                seen.add("%s:%s" % (o["key"], c))
print(",".join(sorted(seen)))
PY
)"
  [[ -z "$hit" ]] || JUSTIFIED_SEEN="${JUSTIFIED_SEEN}${hit},"
}

run_suite() {  # oracle-name, oracle-sql  -> writes "id status detail" lines
  local oname="$1" oracle="$2"
  local out="$WORK/results.$oname"
  : > "$out"
  RESULTS_FILE="$out"

  hdr "suite against the ${oname} classifier"

  # -- pristine, both generations
  local gen rc final want_live want_tomb
  if [[ "$oname" == real ]]; then want_live=LIVE_EXPECTED; else want_live=LIVE; fi
  for gen in 0008 latest; do
    log "pristine ${gen}"
    rc="$(run_case "$oracle" "$gen" "" normal "pristine-${gen}" "${oname}.pristine-${gen}")"
    local tr="$WORK/${oname}.pristine-${gen}.txt"
    if [[ "$gen" == 0008 ]]; then want_tomb="$want_live"; else want_tomb=INTENTIONALLY_TOMBSTONED; fi
    local ok=1 detail=""
    [[ "$rc" == 0 ]] || { ok=0; detail="driver rc=$rc (expected 0)"; }
    for k in vault_create_secret vault_update_secret vault_delete_secret; do
      final="$(object_field "$tr" "$k" 4)"
      [[ "$final" == "$want_tomb" ]] || { ok=0; detail="${detail} ${k}=${final} (want ${want_tomb})"; }
    done
    final="$(object_field "$tr" owns_account 4)"
    [[ "$final" == "$want_live" ]] || { ok=0; detail="${detail} owns_account=${final} (want ${want_live})"; }
    # The two routines the expectation catalogue used to be blind to. They are
    # asserted only for the real classifier: the straw man does not enumerate
    # them, which is the defect they exist to pin, not something to demand of it.
    if [[ "$oname" == real ]]; then
      local want_new
      if [[ "$gen" == 0008 ]]; then want_new=EXPECTEDLY_ABSENT
      else want_new=INTENTIONALLY_TOMBSTONED; fi
      for k in create_account_atomic record_account_verification; do
        final="$(object_field "$tr" "$k" 4)"
        [[ "$final" == "$want_new" ]] || { ok=0; detail="${detail} ${k}=${final} (want ${want_new})"; }
      done
    fi
    [[ "$oname" != real ]] || scan_justified "$WORK/${oname}.pristine-${gen}.json"
    if [[ "$ok" -eq 1 ]]; then
      good "pristine ${gen}: wrappers ${want_tomb}, owns_account ${want_live}, driver PASS"
      printf 'P%s green -\n' "$gen" >> "$out"
    else
      bad "pristine ${gen}:${detail}"
      printf 'P%s red %s\n' "$gen" "${detail// /_}" >> "$out"
    fi
  done

  # -- mutants
  local spec id gen mutid pmode key wantfinal wantreasons desc mutfile
  for spec in "${MUTANTS[@]}"; do
    IFS='|' read -r id gen mutid pmode key wantfinal wantreasons desc <<< "$spec"
    if [[ -n "$ONLY" && ",${ONLY}," != *",${id},"* ]]; then continue; fi
    if [[ "$oname" == naive ]] \
       && printf '%s\n' "${NAIVE_UNADDRESSABLE[@]}" | grep -qx -- "$id"; then
      info "mutant ${id}: not run against the straw man — it emits no verdict for ${key} at all"
      continue
    fi
    mutfile=""
    [[ "$mutid" == "-" ]] || mutfile="$WORK/mut/${mutid}.sql"

    log "mutant ${id} [${gen}] ${desc}"
    rc="$(run_case "$oracle" "$gen" "$mutfile" "$pmode" "mutant-${id}: ${desc}" "${oname}.m${id}")"
    local tr="$WORK/${oname}.m${id}.txt"
    local ok=1 detail=""

    if [[ "$rc" == 2 || "$rc" == 3 ]]; then
      bad "mutant ${id}: the harness itself failed (rc=$rc)"
      sed -n '1,80p' "$WORK/${oname}.m${id}.driver.txt" >&2
      printf '%s red harness_rc_%s\n' "$id" "$rc" >> "$out"
      continue
    fi

    final="$(object_field "$tr" "$key" 4)"
    if [[ "$final" != "$wantfinal" ]]; then
      ok=0; detail="${detail} ${key} final=${final} want=${wantfinal};"
    fi

    # reason codes are only asserted for the real classifier: the straw man has
    # none by construction, and demanding them would make it fail for the wrong
    # reason
    if [[ "$oname" == real ]]; then
      local missing
      missing="$(check_reasons "$WORK/${oname}.m${id}.json" "$key" "$wantreasons")"
      if [[ -n "$missing" ]]; then
        ok=0
        while IFS= read -r linefail; do detail="${detail} ${linefail};"; done <<< "$missing"
      fi
      scan_justified "$WORK/${oname}.m${id}.json"
      if [[ "$rc" != 1 ]]; then
        ok=0; detail="${detail} driver rc=${rc} want 1;"
      fi
    fi

    if [[ "$ok" -eq 1 ]]; then
      good "mutant ${id}: ${key} -> ${final}${wantreasons:+  [${wantreasons}]}"
      printf '%s green -\n' "$id" >> "$out"
    else
      bad "mutant ${id}:${detail}"
      printf '%s red %s\n' "$id" "${detail// /_}" >> "$out"
    fi
  done
}

# ---------------------------------------------------------------------------
# 7. extra assertions the real classifier must satisfy
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# The whole-schema counter-scan, falsified end to end.
#
# Three things are asserted, in this order, and the order is the point:
#
#   1. NON-VACUITY FIRST. The pristine report must carry a counter-scan with
#      both dimensions and a pin that is not empty. "No findings" from a scan
#      that is absent, or measured against an empty pin, is not a clean result;
#      it is no result. Only after that is the pristine emptiness believed.
#   2. Each run-level mutant must produce the exact finding codes it names —
#      not "some finding", not a non-zero exit.
#   3. EVERY CATALOGUED OBJECT MUST STILL BE EXACTLY AS EXPECTED. This is the
#      load-bearing assertion. It proves the run went red for the counter-scan
#      ALONE: delete the `cc_schema_finding` clause from the result gate and
#      this mutation goes back to the clean PASS the audit obtained.
# ---------------------------------------------------------------------------
schema_scan_json_assert() {  # json, mode(pristine|mutant), required-codes
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
path, mode, wanted = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    doc = json.load(open(path))
except Exception as exc:
    print("could not read the JSON report: %s" % exc); sys.exit(0)
scan = doc.get("schema_scan")
if not isinstance(scan, dict):
    print("the report carries no schema_scan section at all"); sys.exit(0)
kinds = scan.get("kinds") or []
have = {k.get("kind") for k in kinds}
for k in ("client_surface", "secdef_vault"):
    if k not in have:
        print("the counter-scan did not run dimension %r (got: %s)"
              % (k, ",".join(sorted(x or "?" for x in have)) or "-"))
for k in kinds:
    if not (k.get("pinned") or []):
        print("dimension %r is measured against an EMPTY pin; any schema "
              "satisfies that" % k.get("kind"))
    if not (k.get("observed") or []):
        print("dimension %r observed nothing at all; the scan is vacuous"
              % k.get("kind"))
findings = scan.get("findings")
if findings is None:
    print("schema_scan has no findings array"); sys.exit(0)
got = {f.get("code") for f in findings}
if mode == "pristine":
    if got:
        print("the pristine schema already carries findings: %s" % ",".join(sorted(got)))
    if doc.get("result") != "PASS":
        print("the pristine run is %r, so its clean counter-scan proves nothing"
              % doc.get("result"))
else:
    for code in [c for c in wanted.split(",") if c]:
        if code not in got:
            print("missing schema finding %r (got: %s)"
                  % (code, ",".join(sorted(got)) or "-"))
    if doc.get("result") != "FAIL":
        print("result is %r, expected FAIL" % doc.get("result"))
    # THE LOAD-BEARING PART: nothing catalogued moved, so the counter-scan is
    # the only thing that turned this run red.
    want = {"LIVE": "LIVE_EXPECTED", "TOMBSTONED": "INTENTIONALLY_TOMBSTONED",
            "ABSENT": "EXPECTEDLY_ABSENT"}
    moved = [o["key"] for o in doc.get("objects") or []
             if o.get("final") != want.get(o.get("expected"))]
    if moved:
        print("catalogued objects also moved (%s), so this mutant does not "
              "isolate the counter-scan" % ",".join(sorted(moved)))
    bad_ctl = [c["name"] for c in doc.get("controls") or [] if not c.get("ok")]
    if bad_ctl:
        print("controls failed (%s); a CONTROL_FAILED would mask the finding"
              % ",".join(sorted(bad_ctl)))
PY
}

run_schema_mutants() {
  local ok=1 problems spec id gen mutid want desc rc

  # 1. non-vacuity and the pristine negative control
  local pj="$WORK/real.pristine-latest.json"
  if [[ ! -f "$pj" ]]; then
    bad "no pristine latest report; the counter-scan's negative control cannot run"
    return 1
  fi
  problems="$(schema_scan_json_assert "$pj" pristine '')"
  if [[ -n "$problems" ]]; then
    while IFS= read -r l; do bad "counter-scan pristine control: $l"; done <<< "$problems"
    ok=0
  else
    good "counter-scan present on the pristine schema, both dimensions, non-empty"
    good "  pins, no findings — an absence measured by a scan that is really there"
  fi

  # 2/3. the run-level mutants
  for spec in "${SCHEMA_MUTANTS[@]}"; do
    IFS='|' read -r id gen mutid want desc <<< "$spec"
    if [[ -n "$ONLY" && ",${ONLY}," != *",${id},"* ]]; then
      info "schema mutant ${id}: skipped by --only"
      uncertify "schema mutant ${id} (the AUD-4 counter-scan falsification) did not run"
      continue
    fi
    log "schema mutant ${id} [${gen}] ${desc}"
    rc="$(run_case "$REAL_ORACLE" "$gen" "$WORK/mut/${mutid}.sql" normal \
                   "schema-mutant-${id}: ${desc}" "real.s${id}")"
    if [[ "$rc" == 2 || "$rc" == 3 ]]; then
      bad "schema mutant ${id}: the harness itself failed (rc=${rc}); a CONTROL_FAILED"
      bad "  or a harness error is NOT the counter-scan catching anything"
      sed -n '1,60p' "$WORK/real.s${id}.driver.txt" >&2
      ok=0
      continue
    fi
    if [[ "$rc" != 1 ]]; then
      bad "schema mutant ${id}: driver rc=${rc}, want 1 (FAIL)"
      ok=0
    fi
    problems="$(schema_scan_json_assert "$WORK/real.s${id}.json" mutant "$want")"
    if [[ -n "$problems" ]]; then
      while IFS= read -r l; do bad "schema mutant ${id}: $l"; done <<< "$problems"
      ok=0
    elif [[ "$rc" == 1 ]]; then
      good "schema mutant ${id}: FAIL on [${want}] with every catalogued object"
      good "  still exactly as expected — the counter-scan is what turned it red"
    fi
  done
  [[ "$ok" -eq 1 ]]
}

# The falsification of classifier control C34. Every other assertion in this
# suite is about a FINDING; this one is about a REFUSAL. It requires exit 3 and
# CONTROL_FAILED, requires C34 to be the ONLY control that failed — so the
# refusal is attributable to this cause and not to collateral damage — and
# requires C34's own detail to name the planted table.
run_closure_control_falsification() {
  local rc
  rc="$(run_case "$REAL_ORACLE" latest "$WORK/mut/C34n.sql" normal \
                 "C34/C35-negative: a routed table neither completeness arm names" \
                 "real.c34n")"
  if [[ "$rc" != 3 ]]; then
    bad "C34/C35 falsification: driver rc=${rc}, want 3 (CONTROL_FAILED). A table"
    bad "  whose policy routes through owns_account while the closure does not"
    bad "  watch it must make the run refuse, not merely report a finding."
    sed -n '1,40p' "$WORK/real.c34n.driver.txt" >&2
    return 1
  fi
  python3 - "$WORK/real.c34n.json" <<'PY' || return 1
import json, sys
doc = json.load(open(sys.argv[1]))
problems = []
if doc.get("result") != "CONTROL_FAILED":
    problems.append("result is %r, expected CONTROL_FAILED" % doc.get("result"))
# ALL THREE completeness arms are keyed on the same derived `routed` set — C34
# for the rls rows, C35 for the policy-set rows, C37 for the ADV-2 guarded rows
# — so a table none of them was told about must break all three. Expecting only
# C34 here would have let the ADV-1 arm be added with no falsification of its
# own list ever running; expecting only C34+C35 would have done the same for
# ADV-2's.
failed = sorted(c["name"] for c in doc.get("controls") or [] if not c.get("ok"))
want = ["C34_rls_arm_covers_every_routed_table",
        "C35_policyset_arm_covers_every_routed_table",
        "C37_guarded_arm_covers_every_closure_table"]
if failed != want:
    problems.append("failing controls are %s; expected exactly %s, or the refusal "
                    "is not attributable to the planted policy" % (failed, want))
for prefix, needle in (("C34_", "routed but NOT guarded: public.trades"),
                       ("C35_", "routed-or-rls but NOT pinned: public.trades"),
                       ("C37_", "uncovered or invented: public.trades")):
    detail = next((c["detail"] for c in doc.get("controls") or []
                   if c["name"].startswith(prefix)), "")
    if needle not in detail:
        problems.append("%s did not name the planted table; detail was %r"
                        % (prefix.rstrip("_"), detail))
if problems:
    for p in problems:
        sys.stderr.write("   C34/C35 falsification: %s\n" % p)
    sys.exit(1)
print("   C34/C35/C37 falsification: CONTROL_FAILED, those three the only failing "
      "controls, and all three name public.trades")
PY
  good "C34/C35 falsification: a table the schema routes through owns_account but"
  good "  neither completeness arm names makes the run REFUSE, naming that table"
  return 0
}

# Mutant 46 dresses the tombstone up as the LIVE profile. It used to be the sole
# carrier of `tomb:probe_not_invoked`, because the privileged tombstone probe was
# the `else` branch of the live probe and a matching live structure skipped it.
# It is not any more: both profiles can be probed for one object, which is what
# lets migration 0017's two shims be probed at all — they differ from the live
# 0014 definitions in NOTHING but the body, so an `else` gate left them unproven.
#
# That makes `tomb:probe_not_invoked` unreachable, and this is the assertion
# that keeps its justification honest. Dropping the code from mutant 46's
# expected list on its own would only record that it stopped appearing; this
# records WHY, by requiring the probe that replaced it to have actually run.
assert_mutant_46_evidence() {
  local json="$WORK/real.m46.json"
  [[ -f "$json" ]] || { bad "mutant 46 produced no JSON report"; return 1; }
  python3 - "$json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
obj = {o["key"]: o for o in doc["objects"]}["vault_create_secret"]
probe = obj["probe"]
problems = []
if probe.get("kind") != "tomb":
    problems.append("probe kind is %r, expected 'tomb' — the privileged tombstone "
                    "probe was not the one selected" % probe.get("kind"))
if probe.get("ran") is not True:
    problems.append("probe.ran is %r, expected True" % probe.get("ran"))
if probe.get("sqlstate") != "P0001":
    problems.append("probe sqlstate is %r, expected P0001" % probe.get("sqlstate"))
if probe.get("effect_ok") is not True:
    problems.append("probe.effect_ok is %r: the privileged invocation had a side "
                    "effect" % probe.get("effect_ok"))
if "tomb:probe_not_invoked" in obj["tomb_misses"]:
    problems.append("tomb:probe_not_invoked was emitted; it is declared unreachable")
if problems:
    for p in problems:
        sys.stderr.write("   mutant 46 evidence: %s\n" % p)
    sys.exit(1)
print("   mutant 46 evidence: the privileged tombstone probe RAN (kind=tomb, "
      "P0001, no side effect) even though the live structure matched — which is "
      "why tomb:probe_not_invoked is unreachable rather than merely unasserted")
PY
}

assert_mutant_17_evidence() {
  local json="$WORK/real.m17.json"
  [[ -f "$json" ]] || { bad "mutant 17 produced no JSON report"; return 1; }
  python3 - "$json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
obj = {o["key"]: o for o in doc["objects"]}["owns_account"]
problems = []
if obj["probe"]["sqlstate"] != "42501":
    problems.append("probe sqlstate is %r, expected 42501" % obj["probe"]["sqlstate"])
if obj["tomb_applicable"] is not False:
    problems.append("tomb_applicable is %r, expected False" % obj["tomb_applicable"])
if obj["final"] == "INTENTIONALLY_TOMBSTONED":
    problems.append("a 42501 on a live routine was called an intentional tombstone")
if obj["final"] != "ACL_DRIFT":
    problems.append("final is %r, expected ACL_DRIFT" % obj["final"])
if problems:
    for p in problems:
        sys.stderr.write("   mutant 17 evidence: %s\n" % p)
    sys.exit(1)
print("   mutant 17 evidence: SQLSTATE 42501 recorded, tomb_applicable=false, "
      "final=ACL_DRIFT — 42501 was NOT read as a tombstone")
PY
}

# Mutant 07 grants EXECUTE to PUBLIC. The verdict must come from reading what
# PUBLIC means — every role in the cluster — and not from the four names the
# previous assertion happened to enumerate.
#
# The NULL-proacl case is NOT this mutant: measured on this image, granting to
# PUBLIC leaves an explicit `=X/postgres` entry rather than collapsing proacl
# back to NULL. A null proacl is produced by CREATE, so it is proven inside the
# classifier by control C16 on a freshly created routine, and asserted here from
# the pristine report.
assert_mutant_07_public_execute() {
  local json="$WORK/real.m07.json" pristine="$WORK/real.pristine-latest.json"
  [[ -f "$json" ]] || { bad "mutant 07 produced no JSON report"; return 1; }
  [[ -f "$pristine" ]] || { bad "no pristine-latest JSON report"; return 1; }
  python3 - "$json" "$pristine" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
obj = {o["key"]: o for o in doc["objects"]}["vault_create_secret"]
problems = []
if obj["exec_public"] is not True:
    problems.append("exec_public is %r; the PUBLIC grant was not read" % obj["exec_public"])
if "PUBLIC" not in (obj["grants_explicit"] or []):
    problems.append("PUBLIC is not in grants_explicit: %r" % obj["grants_explicit"])
for role in ("anon", "authenticated", "service_role", "supabase_auth_admin"):
    if role not in (obj["exec_inherited"] or []):
        problems.append("%s is not among the executors: %r" % (role, obj["exec_inherited"]))
    if role not in (obj["exec_unexpected_tomb"] or []):
        problems.append("%s is not reported as unexpected: %r" % (role, obj["exec_unexpected_tomb"]))

# and, from the pristine run, the classifier's own proof that a NULL proacl is
# read as PostgreSQL's built-in default rather than as "no privileges"
pri = json.load(open(sys.argv[2]))
c16 = {c["name"]: c for c in pri["controls"]}.get("C16_null_proacl_is_public")
if c16 is None or not c16["ok"]:
    problems.append("control C16 (a NULL proacl is PUBLIC-executable) did not pass")
elif "proacl=<null>" not in c16["detail"]:
    problems.append("control C16 did not actually test a NULL proacl: %s" % c16["detail"])

if problems:
    for p in problems:
        sys.stderr.write("   mutant 07 evidence: %s\n" % p)
    sys.exit(1)
print("   mutant 07 evidence: PUBLIC holds EXECUTE and every ordinary role — "
      "supabase_auth_admin included — is named as an unexpected executor; and "
      "control C16 proves a NULL proacl is read as PUBLIC-executable")
PY
}

# The pristine role scan must be non-vacuous: a scan of two roles could not
# have found supabase_auth_admin even if it were granted.
assert_role_scan_non_vacuous() {
  local json="$WORK/real.pristine-latest.json"
  [[ -f "$json" ]] || { bad "no pristine-latest JSON report"; return 1; }
  python3 - "$json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
n = doc["environment"]["roles_scanned"]
if n < 20:
    sys.stderr.write("   the role scan saw only %d roles; that is not the cluster\n" % n)
    sys.exit(1)
ctl = {c["name"]: c for c in doc["controls"]}
for name in ("C13_acl_scanner_sees_auth_admin", "C14_acl_scanner_sees_membership",
             "C15_acl_scanner_sees_public", "C16_null_proacl_is_public",
             "C17_side_effect_detector_works"):
    if name not in ctl:
        sys.stderr.write("   control %s did not run\n" % name); sys.exit(1)
    if not ctl[name]["ok"]:
        sys.stderr.write("   control %s failed: %s\n" % (name, ctl[name]["detail"])); sys.exit(1)
print("   role scan: %d roles enumerated; the scanner's positive controls "
      "(supabase_auth_admin, group membership, PUBLIC, NULL proacl, side-effect "
      "detector) all passed" % n)
PY
}

# ---------------------------------------------------------------------------
# THE CONTROL ROSTER, not just the control failures.
#
# `pg_temp.cc_result()` refuses on `exists (select 1 from cc_control where not
# ok)`. That is an absence claim over a table the controls populate
# THEMSELVES: a control whose `insert` never executes contributes no row, and
# the gate reads that as "no failed control". The classifier does guard verdict
# CARDINALITY — `count(cc_verdict) <> count(cc_expect)` — and then does not ask
# the same question about its own controls. Nothing in the classifier, the
# driver, or this suite ever counted them; the two readers that come closest
# (assert_coverage_controls, assert_role_scan_non_vacuous) name eleven of the
# thirty-six between them and say nothing about the other twenty-five.
#
# The count really does move without anything noticing. Measured on reports
# this directory produced on 2026-08-16 and kept in the evidence folder:
# real.m60/61/62/63.json each carry 35 controls and report `failed: []`,
# because they were produced before C34 existed; final-latest.json and
# c34-neg.json from the same folder carry 36. Four of those 35-control reports
# are the AUD-3 green-after evidence. A roster that can be short by one while
# every check stays green is the same "a list nobody can see is short" shape as
# AUD-1 itself.
#
# The roster is DERIVED from the classifier's own text — never typed here, or
# it would be one more hand-written list that can quietly shrink — with a
# positive control on the parser, and every real-classifier report the run
# produced must carry EXACTLY it, in both directions.
#
# TWO LAYERS, because one is not enough and the first draft of this check was
# the proof. A roster derived from the classifier's own text cannot notice a
# control DELETED from that text: measured on a disposable copy, excising C22's
# whole `insert into cc_control` statement left this check reporting
# "all 35 controls the classifier defines are present in every report" and the
# run exit 0. Deriving and comparing against the derivation is a counter
# compared with itself.
#
#   layer 1  the DERIVED roster must equal the roster PINNED below. A control
#            removed from the classifier makes this red; so does a new one,
#            which is the point — adding a control is a deliberate edit here
#            too. This is the same shape as section 2e's argument for the
#            counter-scan pins: an omission from the pin makes the run RED, not
#            green, which is the opposite failure direction from a watch-list.
#   layer 2  every real-classifier report the run produced must carry exactly
#            the derived roster. A control whose insert is conditional and did
#            not fire, or a report produced by a different build of the
#            classifier, makes this red.
#
# SCOPE: together these prove that the set of controls is what it was pinned to
# be and that none of them silently stopped running. Neither is a claim that
# the pinned set is the RIGHT set of controls.
# ---------------------------------------------------------------------------
readonly CC_CONTROL_ROSTER_PINNED="\
C01_normaliser,C02_resolver_positive,C03_resolver_negative,C04_exact_signature,\
C05_derived_body_matches_shape,C06_shape_rejects_live_body,C07_body_is_name_bound,\
C08_inputs_present,C09_fixture_seeded,C10_known_generation,C11_two_owners_seeded,\
C12_acl_scanner_negative,C13_acl_scanner_sees_auth_admin,C14_acl_scanner_sees_membership,\
C15_acl_scanner_sees_public,C16_null_proacl_is_public,C17_side_effect_detector_works,\
C18_declared_grantees_exist,C19_reasons_registered,C19b_schema_findings_registered,\
C20_tombstone_names_expected,C20b_targets_match_names,C21_tombstone_state_agreement,\
C22_third_subject_owns_nothing,C23_coverage_comparator,C24_owns_account_body_pin_readable,\
C25_tombstone_names_verdicted,C26_live_body_pins_derived,C27_closure_is_complete,\
C28_closure_parser_works,C29_closure_observer_reads,C30_client_surface_scanner_works,\
C31_vault_reacher_scanner_works,C32_schema_pin_non_vacuous,\
C33_schema_findings_gate_the_result,C34_rls_arm_covers_every_routed_table,\
C35_policyset_arm_covers_every_routed_table,C36_policyset_comparator_discriminates,\
C37_guarded_arm_covers_every_closure_table,C38_guarded_observers_discriminate,\
C38b_guarded_control_left_nothing_behind,C39_outside_closure_scope_derived"

# ---------------------------------------------------------------------------
# R5-DOC1. THE DOCUMENT'S SCOPE ROW MUST BE THE REPORT'S SCOPE ROW.
#
# CATALOGUE-CLASSIFIER.md carried a table that called itself "measured" and
# concluded "two tables, one policy each … a two-row scope", while line 320 of
# the SAME file and `pass_does_not_claim` bullet 3 both said SEVEN. A document
# that contradicts itself and its own machine-readable output is worse than one
# that says nothing, and the wrong half understated the gap by five tables.
#
# The classifier now DERIVES that set (control C39) and publishes it as
# authz_closure.outside_closure_policy_bearing. This function requires the
# document's table row to name exactly those relations — in both directions —
# so the two cannot diverge again without a red run.
#
# The row is located by its marker cell, not by line number: the table row whose
# last cell contains "outside the closure". A parser that finds no such row
# fails loudly rather than passing on an empty comparison.
assert_doc_matches_closure_scope() {
  local doc="${CONTAINMENT}/CATALOGUE-CLASSIFIER.md"
  local pj="$WORK/real.pristine-latest.json"
  [[ -f "$doc" ]] || { bad "CATALOGUE-CLASSIFIER.md is missing"; return 1; }
  if [[ ! -f "$pj" ]]; then
    bad "no pristine latest report; the document's scope row cannot be checked"
    return 1
  fi
  doc_scope_check "$doc" "$pj" || return 1

  # RED-BEFORE, on a copy: drop one relation from the documented row and the
  # same reader must refuse, naming it. Without this the check above is one more
  # assertion whose passing value is also its failure-to-run value.
  local doctored="$WORK/doc-scope-redbefore.md"
  python3 - "$doc" "$doctored" <<'PY' || { bad "could not doctor the scope row"; return 1; }
import re, sys
lines = open(sys.argv[1], encoding="utf-8").read().splitlines(keepends=True)
out, done = [], False
for line in lines:
    st = line.rstrip("\n")
    if (not done and st.startswith("|") and st.endswith("|")
            and "outside the closure" in st):
        cells = st[1:-1].split("|")
        names = re.findall(r"`([a-z_][a-z0-9_]*)`", cells[0])
        if len(names) > 1:
            cells[0] = " " + ", ".join("`%s`" % n for n in names[:-1]) + " "
            line = "|" + "|".join(cells) + "|\n"
            done = True
    out.append(line)
if not done:
    sys.stderr.write("   could not find a scope row to doctor\n")
    sys.exit(1)
open(sys.argv[2], "w", encoding="utf-8").write("".join(out))
PY
  local err
  if err="$(doc_scope_check "$doctored" "$pj" 2>&1)"; then
    bad "the scope-row reader ACCEPTED a row missing one relation; it is not"
    bad "  comparing anything"
    return 1
  fi
  if [[ "$err" != *"In the report only"* ]]; then
    bad "the scope-row reader refused the doctored row for the wrong reason:"
    printf '%s\n' "$err" >&2
    return 1
  fi
  good "the document's outside-closure row is the report's derived set, and"
  good "  deleting one relation from it makes the reader refuse, naming it"
  return 0
}

doc_scope_check() {  # doc.md, pristine-latest.json
  python3 - "$1" "$2" <<'PY'
import json, re, sys
doc = open(sys.argv[1], encoding="utf-8").read().splitlines()
rep = json.load(open(sys.argv[2]))

az = rep.get("authz_closure") or {}
raw = az.get("outside_closure_policy_bearing")
if raw is None:
    sys.stderr.write("   scope row: the report carries no "
                     "authz_closure.outside_closure_policy_bearing\n")
    sys.exit(1)
reported = sorted(e.split("/", 1)[0] for e in raw)
if not reported:
    sys.stderr.write("   scope row: the report's outside-closure set is EMPTY, so "
                     "matching the document against it would prove nothing\n")
    sys.exit(1)
if az.get("outside_closure_policy_bearing_count") != len(raw):
    sys.stderr.write("   scope row: the report's count (%r) disagrees with its own "
                     "array (%d)\n" % (az.get("outside_closure_policy_bearing_count"),
                                       len(raw)))
    sys.exit(1)

rows = [l.rstrip() for l in doc
        if l.startswith("|") and l.rstrip().endswith("|")
        and "outside the closure" in l]
if len(rows) != 1:
    sys.stderr.write("   scope row: found %d table row(s) marked 'outside the "
                     "closure' in CATALOGUE-CLASSIFIER.md; expected exactly one\n"
                     % len(rows))
    sys.exit(1)
cells = [c.strip() for c in rows[0][1:-1].split("|")]
named = sorted("public." + n for n in re.findall(r"`([a-z_][a-z0-9_]*)`", cells[0]))
# POSITIVE CONTROL on this parser: the cell must have yielded something, or the
# set comparison below would be satisfiable by a row with no names in it.
if not named:
    sys.stderr.write("   scope row: parsed no relation names out of %r; the parser "
                     "is not working\n" % cells[0])
    sys.exit(1)

if named != reported:
    sys.stderr.write("   scope row: the document names %s; the report derives %s. "
                     "In the document only: %s. In the report only: %s.\n"
                     % (named, reported,
                        sorted(set(named) - set(reported)),
                        sorted(set(reported) - set(named))))
    sys.exit(1)
print("   scope row: the document's outside-closure row names exactly the %d "
      "relation(s) the pristine report derives (%s)"
      % (len(reported), ", ".join(reported)))
PY
}

# ---------------------------------------------------------------------------
# R5-CTLPREC(2). PROPERTY-LEVEL COVERAGE OF THE ADV-2 `guarded` ARM.
#
# The reason-code coverage assertion in section 1 is the only thing that says
# "every check the classifier can emit is falsified by some mutant", and it
# works on REASON CODES. All six properties of the guarded arm — relkind, owner,
# rowsecurity, forcerowsecurity, inheritance, dependent_rels — report the single
# code `dep:guarded_table_exposed`. One mutant satisfies the code, and the other
# five properties can be deleted from the cross join in the classifier with
# nothing anywhere going red. MEASURED before this function existed: `relkind`
# was pinned by C37, observed by cc_dep_obs, published in every report — and no
# mutant in the suite moved it.
#
# So the assertion is made in the units the gap lives in. Every real-classifier
# report this run produced is read, the closure rows with kind=`guarded` and
# ok=false are collected, and each of the six properties must appear at least
# once. A property nothing falsifies names itself.
#
# The property LIST is not typed here: it is taken from the pristine report's
# own closure rows, so adding a seventh property to the classifier's cross join
# without a mutant for it makes this red rather than silently unmeasured. C37
# separately pins that list by name, so the two cannot drift apart.
assert_guarded_property_coverage() {
  local f
  local -a reports=()
  for f in "$WORK"/real.*.json; do [[ -e "$f" ]] && reports+=("$f"); done
  if [[ "${#reports[@]}" -eq 0 ]]; then
    bad "no real-classifier JSON report exists; guarded-property coverage cannot be checked"
    return 1
  fi
  python3 - "$WORK/real.pristine-latest.json" "${reports[@]}" <<'PY'
import json, os, sys
pristine = sys.argv[1]
problems = []

def closure_rows(path):
    try:
        doc = json.load(open(path))
    except Exception:
        return None
    az = doc.get("authz_closure") or {}
    return az.get("rows")

prows = closure_rows(pristine)
if not prows:
    sys.stderr.write("   guarded coverage: the pristine latest report has no closure "
                     "rows; the property list cannot be derived\n")
    sys.exit(1)
props = sorted({r["property"] for r in prows if r.get("kind") == "guarded"})
# POSITIVE CONTROL on the derivation: an empty or tiny list would make the
# coverage requirement below trivially satisfiable.
if len(props) < 6 or "relkind" not in props or "dependent_rels" not in props:
    sys.stderr.write("   guarded coverage: derived only %r from the pristine report; "
                     "the derivation is not working\n" % (props,))
    sys.exit(1)

# The pristine report must have every one of them OK, or "not ok somewhere"
# would be satisfiable by the baseline rather than by a mutant.
bad_pristine = sorted({r["property"] for r in prows
                       if r.get("kind") == "guarded" and not r.get("ok")})
if bad_pristine:
    problems.append("the pristine latest report already has %s not ok" % bad_pristine)

seen = {}
for path in sys.argv[2:]:
    if os.path.realpath(path) == os.path.realpath(pristine):
        continue
    rows = closure_rows(path)
    if not rows:
        continue
    for r in rows:
        if r.get("kind") == "guarded" and not r.get("ok"):
            seen.setdefault(r["property"], set()).add(os.path.basename(path))

missing = [p for p in props if p not in seen]
if missing:
    problems.append("no mutant in this run moved the guarded arm's %s row; the "
                    "reason-code assertion cannot see it, because all six "
                    "properties report the same code" % missing)

if problems:
    for p in problems:
        sys.stderr.write("   guarded coverage: %s\n" % p)
    sys.exit(1)
print("   guarded coverage: all %d propert(ies) of the ADV-2 arm — %s — were "
      "observed NOT ok by at least one mutant this run (%s)"
      % (len(props), ",".join(props),
         "; ".join("%s<-%s" % (p, ",".join(sorted(seen[p]))) for p in props)))
PY
}

assert_control_roster() {
  local f
  local -a reports=()
  for f in "$WORK"/real.*.json; do [[ -e "$f" ]] && reports+=("$f"); done
  if [[ "${#reports[@]}" -eq 0 ]]; then
    bad "no real-classifier JSON report exists; the control roster cannot be checked"
    return 1
  fi
  python3 - "$REAL_ORACLE" "$CC_CONTROL_ROSTER_PINNED" "${reports[@]}" <<'PY'
import json, os, re, sys
src = open(sys.argv[1], encoding="utf-8").read()
pinned = sorted(x for x in sys.argv[2].split(",") if x)
# Line-anchored, so a commented-out `-- insert into cc_control ...` is not read
# as a declared control. The inserts live inside dollar-quoted DO blocks, which
# this suite's comment stripper preserves verbatim by design, so the anchoring
# has to happen here rather than by stripping.
roster = sorted(set(re.findall(
    r"^\s*insert into cc_control values \('([^']+)'", src, re.M)))
# POSITIVE CONTROL ON THIS PARSER. An empty or tiny parse would make the set
# comparison below satisfiable by a report carrying no controls at all.
if len(roster) < 30:
    sys.stderr.write("   the control-roster parser found only %d control(s); it is "
                     "not working\n" % len(roster))
    sys.exit(1)
for must in ("C01_normaliser", "C20_tombstone_names_expected",
             "C33_schema_findings_gate_the_result",
             "C34_rls_arm_covers_every_routed_table"):
    if must not in roster:
        sys.stderr.write("   the control-roster parser did not find %r; it is not "
                         "working\n" % must)
        sys.exit(1)
if "zz_not_a_control" in roster:
    sys.stderr.write("   the control-roster parser invented a control\n")
    sys.exit(1)
# LAYER 1 — derived vs pinned. Without this, deleting a control from the
# classifier deletes it from the derivation too and everything below agrees
# with itself. Measured: excising C22's insert left the report comparison
# green at 35 of 35.
gone  = sorted(set(pinned) - set(roster))
added = sorted(set(roster) - set(pinned))
if gone or added:
    sys.stderr.write("   the set of controls the classifier defines is not the pinned set:\n")
    if gone:
        sys.stderr.write("     no longer defined anywhere in the classifier: %s\n" % gone)
        sys.stderr.write("     a control deleted from the file is a check that is gone, not one that passed\n")
    if added:
        sys.stderr.write("     defined but not pinned: %s\n" % added)
        sys.stderr.write("     add it to CC_CONTROL_ROSTER_PINNED deliberately\n")
    sys.exit(1)
# LAYER 2 — derived vs what every report actually carried.
problems = []
for p in sys.argv[3:]:
    try:
        doc = json.load(open(p))
    except Exception as exc:
        problems.append("%s: unreadable (%s)" % (os.path.basename(p), exc)); continue
    got = {c["name"] for c in doc.get("controls") or []}
    did_not_run = sorted(set(roster) - got)
    unknown     = sorted(got - set(roster))
    if did_not_run or unknown:
        problems.append("%s: %d of %d; did not run: %s; unknown: %s"
                        % (os.path.basename(p), len(got), len(roster),
                           did_not_run or "-", unknown or "-"))
if problems:
    sys.stderr.write("   a control the classifier DEFINES did not run, and a control "
                     "that does not run is not a control that passed —\n")
    sys.stderr.write("   cc_result() only ever asks whether a control that ran FAILED:\n")
    for p in problems:
        sys.stderr.write("     %s\n" % p)
    sys.exit(1)
print("   control roster: the classifier defines exactly the %d pinned controls, and all "
      "%d are" % (len(roster), len(roster)))
print("   present in every one of the %d real-classifier report(s) this run produced"
      % (len(sys.argv) - 3))
PY
}

# The coverage controls must have RUN and PASSED on both pristine generations,
# and the report must show every name the MIGRATION SET tombstones carrying a
# verdict. A control that silently did not run is indistinguishable from one
# that passed.
#
# THIS READER WAS LEFT BEHIND BY THE AUD-5 RENAME AND IS THE SECOND HALF OF THAT
# FIX. The classifier used to publish `coverage.tombstoned_by_0022` (the narrow
# migration-0022-section-5 list) and `coverage.uncovered` (computed against that
# same list, so it printed [] whatever the catalogue covered). AUD-5 replaced
# both: `derived_tombstone_set` is the extractor's union over both shim
# mechanisms across every migration file, and `uncovered_by_expectation` /
# `uncovered_by_verdict` are differences between THAT independently derived set
# and what the hand-written catalogue and the verdict pipeline actually reached.
# This function still read the two removed keys — a KeyError, i.e. the coverage
# assertion had stopped asserting anything about coverage and was dying on a
# traceback instead. Both halves of a rename have to land or neither did.
#
# The hard-coded floor of five names went with them. Five was the section-5 loop
# count; the derived set is larger because 0017 and 0022 also tombstone inline,
# and a floor that a NARROWED derivation would still clear is not a floor. The
# check is now relative to the report's own section-5 list: the union must be a
# strict superset of it, which is exactly what collapsing back to one mechanism
# would break.
#
# AND THE PIN COMPARISON, WHICH WAS THE HOLE. Everything below used to be a
# self-consistency check: derived_tombstone_set was compared against
# section5_loop_names, against verdicts_reached_for, and against the report's
# own subtractions — all keys of the SAME report, all descended from the SAME
# extractor invocation the driver made. Control 0g pins the extractor's output
# against a literal written in this file, but nothing ever put that literal next
# to what the classifier published, so a driver that handed the classifier a
# narrowed name list would have satisfied every check here while 0g stayed green
# on its own separate extractor run. The three pins are now passed in and
# compared, and assert_coverage_pin_falsifiable below is their red-before.
coverage_json_assert() {  # json, gen  -> problems on stderr, exit 1 if any
  python3 - "$1" "$2" "$TOMB_EXPECTED_NAMES" "$TOMB_EXPECTED_MECHANISMS" \
             "$TOMB_EXPECTED_BY_SOURCE" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1])); gen = sys.argv[2]
pin_names  = sorted(x for x in sys.argv[3].split(",") if x)
pin_mechs  = sys.argv[4]
pin_by_src = sys.argv[5]
problems = []
ctl = {c["name"]: c for c in doc["controls"]}
for name in ("C20_tombstone_names_expected", "C21_tombstone_state_agreement",
             "C22_third_subject_owns_nothing", "C23_coverage_comparator",
             "C24_owns_account_body_pin_readable", "C25_tombstone_names_verdicted"):
    if name not in ctl:
        problems.append("control %s did not run" % name)
    elif not ctl[name]["ok"]:
        problems.append("control %s failed: %s" % (name, ctl[name]["detail"]))
cov = doc.get("coverage")
if not cov:
    problems.append("the report carries no coverage block")
else:
    # Every key read here is asserted PRESENT first. A rename that lands in the
    # classifier and not in this reader used to surface as a KeyError traceback
    # — a coverage assertion that had stopped asserting coverage. Naming the
    # missing key is the difference between "the contract changed" and "the
    # suite crashed".
    required = ("derived_tombstone_set", "verdicts_reached_for", "expectation_covers",
                "section5_loop_names", "uncovered_by_expectation", "uncovered_by_verdict",
                "derived_from")
    absent = [k for k in required if k not in cov]
    if absent:
        problems.append("the coverage block is missing %s; the classifier's key names and "
                        "this reader have diverged" % sorted(absent))
        tombed = verdicted = section5 = set()
    else:
        tombed    = set(cov["derived_tombstone_set"])
        verdicted = set(cov["verdicts_reached_for"])
        expected_by_catalogue = set(cov["expectation_covers"] or [])
        section5  = set(cov["section5_loop_names"])
        # THE PIN COMPARISON. `tombed` is what the CLASSIFIER published, i.e.
        # what the driver's own extractor run handed it. `pin_names` is a
        # literal in this suite file. Everything else in this function relates
        # report keys to other report keys; only these three lines relate the
        # report to something written outside it.
        if sorted(tombed) != pin_names:
            problems.append("coverage.derived_tombstone_set is %s but this suite pins "
                            "%s; the set the classifier was handed is not the set 0g "
                            "measured" % (sorted(tombed), pin_names))
        got_mechs = (cov.get("derived_from") or {}).get("mechanisms") or ""
        if got_mechs != pin_mechs:
            problems.append("coverage.derived_from.mechanisms is %r but this suite pins "
                            "%r; a union with an arm that changed size is not the union "
                            "0g measured" % (got_mechs, pin_mechs))
        got_by_src = (cov.get("derived_from") or {}).get("names_by_source") or ""
        if got_by_src != pin_by_src:
            problems.append("coverage.derived_from.names_by_source is %r but this suite "
                            "pins %r" % (got_by_src, pin_by_src))
        # NON-VACUITY, relative to the report itself rather than to a magic
        # number. The published set is the union over both shim mechanisms
        # across the whole migration set, so it must be a STRICT superset of
        # the 0022 section-5 loop; a derivation that quietly narrowed back to
        # one mechanism — the AUD-1 defect — makes this equal, not larger.
        if not section5:
            problems.append("the report publishes no section5_loop_names, so the union "
                            "cannot be shown to be wider than one mechanism")
        elif not section5 < tombed:
            problems.append("the derived set %s is not a strict superset of the 0022 "
                            "section-5 loop %s; the derivation has narrowed back to one "
                            "mechanism" % (sorted(tombed), sorted(section5)))
        # ...and the mechanisms/sources it says it used must name more than one
        # file, for the same reason.
        mech = (cov.get("derived_from") or {}).get("mechanisms") or ""
        srcs = (cov.get("derived_from") or {}).get("sources") or ""
        if "inline=" not in mech or "template=" not in mech:
            problems.append("derived_from.mechanisms=%r does not report both shim "
                            "mechanisms" % mech)
        if len([s for s in srcs.split(",") if s.strip()]) < 2:
            problems.append("derived_from.sources=%r names fewer than two migration "
                            "files" % srcs)
        missing = tombed - verdicted
        if missing:
            problems.append("no verdict reached for %s" % sorted(missing))
        # The two independently computed differences. These are the AUD-5 keys:
        # the derived set MINUS the hand-written catalogue, and the derived set
        # MINUS what a verdict was actually reached for. The old single
        # `uncovered` was computed against the same narrow list it published,
        # so it printed [] whatever the catalogue did.
        if cov["uncovered_by_expectation"]:
            problems.append("the report lists names the expectation catalogue does not "
                            "cover: %s" % cov["uncovered_by_expectation"])
        if cov["uncovered_by_verdict"]:
            problems.append("the report lists names no verdict was reached for: %s"
                            % cov["uncovered_by_verdict"])
        # cross-check the classifier's own subtraction against ours, so a
        # uncovered_* computed from the wrong side would not read as empty
        if set(cov["uncovered_by_verdict"]) != (tombed - verdicted):
            problems.append("uncovered_by_verdict=%s but derived-minus-verdicted=%s; the "
                            "report's own subtraction disagrees with this reader's"
                            % (sorted(cov["uncovered_by_verdict"]), sorted(tombed - verdicted)))
        if set(cov["uncovered_by_expectation"]) != (tombed - expected_by_catalogue):
            problems.append("uncovered_by_expectation=%s but derived-minus-catalogued=%s"
                            % (sorted(cov["uncovered_by_expectation"]),
                               sorted(tombed - expected_by_catalogue)))
    # the two names F1 was about must be there, in the state this generation calls for
    want = "EXPECTEDLY_ABSENT" if gen == "0008" else "INTENTIONALLY_TOMBSTONED"
    objs = {o["key"]: o for o in doc["objects"]}
    for k in ("create_account_atomic", "record_account_verification"):
        if k not in objs:
            problems.append("%s has no verdict row on the %s schema" % (k, gen))
        elif objs[k]["final"] != want:
            problems.append("%s is %r on %s, expected %r" % (k, objs[k]["final"], gen, want))
if problems:
    for p in problems:
        sys.stderr.write("   coverage [%s]: %s\n" % (gen, p))
    sys.exit(1)
# The success line reports the NUMBERS it actually checked. It used to say
# "all five routines 0022 tombstones", which was the section-5 count and stopped
# being true when the derivation widened to the union over both mechanisms; a
# green line that misstates its own scope is how a narrowing goes unnoticed.
print("   coverage [%s]: %d derived tombstone name(s) from %s across [%s], all "
      "catalogued and all verdicted; %d in the 0022 section-5 loop; "
      "uncovered_by_expectation=%s uncovered_by_verdict=%s; C20-C25 passed"
      % (gen, len(tombed),
         (cov.get("derived_from") or {}).get("mechanisms", "?"),
         (cov.get("derived_from") or {}).get("sources", "?"),
         len(section5),
         cov.get("uncovered_by_expectation"), cov.get("uncovered_by_verdict")))
PY
}

assert_coverage_controls() {
  local gen json
  for gen in latest 0008; do
    json="$WORK/real.pristine-${gen}.json"
    [[ -f "$json" ]] || { bad "no pristine-${gen} JSON report"; return 1; }
    coverage_json_assert "$json" "$gen" || return 1
  done
  return 0
}

# RED-BEFORE FOR THE PIN COMPARISON ITSELF.
#
# `sorted(tombed) == pin_names` is a rejection-shaped assertion: on a healthy
# report it produces nothing, and so would a version of it that read the wrong
# key, compared the wrong pair, or never ran. So a copy of the pristine report
# is doctored — one tombstone name renamed, the set size left alone — and the
# same reader is required to REFUSE it, naming the pin. Cheap: no container, no
# classifier, just the artefact the real run already produced.
assert_coverage_pin_falsifiable() {
  local src="$WORK/real.pristine-latest.json"
  local doctored="$WORK/coverage-pin-redbefore.json"
  [[ -f "$src" ]] || { bad "no pristine-latest report to doctor"; return 1; }
  python3 - "$src" "$doctored" <<'PY' || { bad "could not doctor the coverage report"; return 1; }
import json, sys
doc = json.load(open(sys.argv[1]))
names = doc["coverage"]["derived_tombstone_set"]
if not names:
    sys.stderr.write("   the pristine report publishes no derived_tombstone_set\n")
    sys.exit(1)
# rename, do not remove: the set SIZE is unchanged, so only a comparison against
# the suite's literal pin can see it.
names[0] = "zz_not_a_tombstone"
doc["coverage"]["derived_tombstone_set"] = names
json.dump(doc, open(sys.argv[2], "w"))
PY
  local err
  if err="$(coverage_json_assert "$doctored" latest 2>&1)"; then
    bad "the coverage reader ACCEPTED a report whose derived_tombstone_set does not"
    bad "  match the suite's pin. The pin comparison is not running."
    return 1
  fi
  if [[ "$err" != *"but this suite pins"* || "$err" != *"zz_not_a_tombstone"* ]]; then
    bad "the coverage reader rejected the doctored report for the wrong reason:"
    printf '%s\n' "$err" >&2
    return 1
  fi
  good "coverage pin red-before: renaming one name in derived_tombstone_set makes the"
  good "  reader refuse, naming the pin and the planted name"
  return 0
}

# ...and the coverage control must have a RED-BEFORE of its own. A control
# nobody has watched fail is a control nobody has watched. Doctor the
# classifier so that one expectation row is missing — the exact shape of the
# defect F1 reported — and require the run to come back CONTROL_FAILED naming
# that routine. "some non-zero exit" is not enough: the reason string is
# asserted.
assert_coverage_control_fails_closed() {
  local doctored="$WORK/coverage-redbefore.sql" rc=0
  python3 - "$REAL_ORACLE" "$doctored" <<'PY' || return 1
import sys
src = open(sys.argv[1], encoding="utf-8").read()
head = ("  ('create_account_atomic','public','create_account_atomic',\n"
        "   'public.create_account_atomic(uuid,text,account_mode,text,uuid,uuid,text,uuid)',\n"
        "   'TOMBSTONED'")
tail = ("  ('record_account_verification','public','record_account_verification',\n"
        "   'public.record_account_verification(uuid,uuid,account_status,text,bigint)',\n"
        "   'TOMBSTONED'")
try:
    start = src.index(head)
    end = src.index(tail, start)
except ValueError:
    sys.stderr.write("   could not locate the expectation row to remove; the "
                     "coverage red-before cannot be built\n")
    sys.exit(1)
out = src[:start] + src[end:]
if out == src or len(out) >= len(src):
    sys.stderr.write("   the doctoring removed nothing\n"); sys.exit(1)
open(sys.argv[2], "w", encoding="utf-8").write(out)
PY
  set +e
  "$DRIVER" --generation latest --probe-mode normal --classifier "$doctored" \
    --quiet --out "$WORK/coverage-redbefore.txt" \
    --mutate-label 'coverage control red-before' > "$WORK/coverage-redbefore.driver.txt" 2>&1
  rc=$?
  set -e
  if [[ "$rc" -ne 3 ]]; then
    bad "a classifier missing one tombstone expectation exited ${rc}; expected 3 (control failure)"
    sed -n '1,40p' "$WORK/coverage-redbefore.driver.txt" >&2
    return 1
  fi
  if ! grep -F -q 'CATALOGUE_CLASSIFY_RESULT=CONTROL_FAILED' "$WORK/coverage-redbefore.txt"; then
    bad "the doctored run did not report CONTROL_FAILED"
    return 1
  fi
  local line
  if ! line="$(grep -m1 -F 'CATALOGUE_CLASSIFY_CONTROL=C20_tombstone_names_expected' \
               "$WORK/coverage-redbefore.txt")"; then
    bad "C20 did not fail when a tombstone expectation row was removed"
    grep -F 'CATALOGUE_CLASSIFY_CONTROL=' "$WORK/coverage-redbefore.txt" >&2 || true
    return 1
  fi
  if [[ "$line" != *"uncovered: create_account_atomic"* ]]; then
    bad "C20 failed, but not with the expected reason string"
    bad "  got: ${line}"
    return 1
  fi
  if ! grep -F -q 'CATALOGUE_CLASSIFY_CONTROL=C25_tombstone_names_verdicted' \
       "$WORK/coverage-redbefore.txt"; then
    bad "C25 did not fail alongside C20; the verdict-side half of the check is inert"
    return 1
  fi
  good "coverage control red-before: removing one expectation row turns the run"
  good "  CONTROL_FAILED, and C20 names create_account_atomic as uncovered"
  return 0
}

# ---------------------------------------------------------------------------
# 8. drive
# ---------------------------------------------------------------------------
REAL_RED=0
NAIVE_BLIND=""
NAIVE_BROKEN=""
NAIVE_MUTANTS_RUN=0
NAIVE_PRISTINE_RUN=0
NAIVE_EXPECTED_CELLS=0
rc_naive_count=0
COVERAGE_RED=0
DOC_RED=0
REAL_MUTANTS_RUN=0
REAL_PRISTINE_RUN=0
DECLARED_MUTANTS="${#MUTANTS[@]}"

# Coverage is a property of the files, not of the oracle under test, so a
# coverage failure fails the run whatever --oracle asked for. Folding it into
# REAL_RED alone would have let `--oracle naive` exit 0 over a reason code that
# no mutant pins — which is the defect this assertion exists to prevent.
if [[ "$cov_ok" -ne 1 ]]; then COVERAGE_RED=1; REAL_RED=1; fi

# The mechanism that scores every mutant, proven before any mutant is scored.
# It runs whatever --oracle asked for and under --only too: it costs
# milliseconds, it needs no container, and a broken scorer invalidates every
# cell whichever subset ran. A failure here is EXIT_CONTROL, not EXIT_RED — the
# suite cannot be trusted this run, which is a different statement from "the
# classifier is wrong".
hdr "1c. the scoring machinery, falsified before anything is scored"
if ! assert_check_reasons_works; then
  bad "check_reasons cannot be trusted, so no mutant's reason profile means"
  bad "  anything this run"
  exit "$EXIT_CONTROL"
fi
if ! assert_row_readers_work; then
  bad "the results-file readers cannot be trusted, so neither the cell counts nor"
  bad "  the straw man's blind set means anything this run"
  exit "$EXIT_CONTROL"
fi

hdr "1d. the documentation says what the suite asserts"
if ! assert_doc_matches_mutants; then
  bad "CATALOGUE-CLASSIFIER.md and the MUTANTS array have diverged. That is a"
  bad "  defect in the same family as everything this suite exists to catch: a"
  bad "  transcription nobody compares. Fix the document, or the array, and say"
  bad "  which one was wrong."
  DOC_RED=1
fi

if [[ "$ORACLE" == real || "$ORACLE" == both ]]; then
  run_suite real "$REAL_ORACLE"
  REAL_RESULTS="$RESULTS_FILE"
  hdr "real classifier — summary"
  column -t "$REAL_RESULTS" 2>/dev/null || cat "$REAL_RESULTS"
  if grep -q ' red ' "$REAL_RESULTS"; then REAL_RED=1; fi

  # MEASURED from the file the loop wrote, not from the loop's own bookkeeping.
  # A count taken from the array that drove the loop cannot detect the loop not
  # running; this one can, and the verdict below quotes it instead of the word
  # "every".
  REAL_MUTANTS_RUN="$(count_mutant_rows "$REAL_RESULTS")"
  REAL_PRISTINE_RUN="$(count_pristine_rows "$REAL_RESULTS")"
  DECLARED_MUTANTS="${#MUTANTS[@]}"
  if [[ "$REAL_MUTANTS_RUN" -ne "$DECLARED_MUTANTS" ]]; then
    uncertify "$((DECLARED_MUTANTS - REAL_MUTANTS_RUN)) of the ${DECLARED_MUTANTS} declared mutants did not run against the real classifier"
  fi
  # Two pristine generations must always be exercised. If they were not, the
  # baseline the mutants are measured against does not exist this run.
  if [[ "$REAL_PRISTINE_RUN" -ne 2 ]]; then
    bad "only ${REAL_PRISTINE_RUN} pristine generation(s) produced a result row; expected 2"
    REAL_RED=1
  fi

  log "the role scan behind every absence claim"
  if ! assert_role_scan_non_vacuous; then REAL_RED=1; fi

  if [[ -z "$ONLY" ]]; then
    log "every routine 0022 tombstones carries a verdict"
    if ! assert_coverage_controls; then REAL_RED=1; fi

    log "the coverage control's own red-before"
    if ! assert_coverage_control_fails_closed; then REAL_RED=1; fi

    log "the coverage PIN's own red-before"
    if ! assert_coverage_pin_falsifiable; then REAL_RED=1; fi
  else
    info "--only in effect: the coverage assertions and their red-before are not run"
    uncertify "the tombstone-coverage assertion (C20/C23), the derived-set pin comparison and both their red-befores did not run"
  fi

  if [[ -z "$ONLY" || ",${ONLY}," == *",17,"* ]]; then
    log "mutant 17 — the evidence behind the verdict"
    if ! assert_mutant_17_evidence; then REAL_RED=1; fi
  else
    uncertify "the mutant-17 evidence assertion did not run"
  fi
  if [[ -z "$ONLY" || ",${ONLY}," == *",46,"* ]]; then
    log "mutant 46 — the tombstone probe runs even when the live structure matches"
    if ! assert_mutant_46_evidence; then REAL_RED=1; fi
  else
    # This one is load-bearing for a JUSTIFIED code: the justification for
    # tomb:probe_not_invoked names assert_mutant_46_evidence as its live
    # detector. Skipping it silently would leave that justification unbacked
    # while the coverage section still printed "declared unreachable".
    uncertify "the mutant-46 evidence assertion did not run — it is the live detector named in the tomb:probe_not_invoked justification"
  fi
  if [[ -z "$ONLY" || ",${ONLY}," == *",07,"* ]]; then
    log "mutant 07 — PUBLIC means every role, and a NULL proacl is not an empty ACL"
    if ! assert_mutant_07_public_execute; then REAL_RED=1; fi
  else
    uncertify "the mutant-07 PUBLIC/NULL-proacl evidence assertion did not run"
  fi

  log "whole-schema counter-scan — run-level mutants"
  if ! run_schema_mutants; then REAL_RED=1; fi

  # Skipped under --only for the same reason the coverage assertions are: it
  # costs a full container run and is a property of the classifier, not of any
  # one mutant. `--only C34n` selects it explicitly.
  if [[ -z "$ONLY" || ",${ONLY}," == *",C34n,"* ]]; then
    log "the closure's rls arm is derived-complete, or the run refuses"
    if ! run_closure_control_falsification; then REAL_RED=1; fi
  else
    info "C34 falsification: skipped by --only (select it with --only C34n)"
    uncertify "the C34 closure-rls-arm falsification did not run"
  fi

  log "every control the classifier defines actually ran, in every report"
  if ! assert_control_roster; then REAL_RED=1; fi

  # Only meaningful over a whole run: under --only the reports that would carry
  # the other properties were never produced, so a red here would be an
  # artefact of the selection rather than a gap in the suite.
  if [[ -z "$ONLY" ]]; then
    log "every property of the ADV-2 guarded arm is falsified by some mutant"
    if ! assert_guarded_property_coverage; then REAL_RED=1; fi
  else
    uncertify "the guarded-arm property coverage assertion did not run (--only)"
  fi

  log "the document's outside-closure scope row is the report's derived set"
  if ! assert_doc_matches_closure_scope; then REAL_RED=1; fi

  log "codes declared unreachable must stay unreached"
  if [[ -n "$JUSTIFIED_SEEN" ]]; then
    bad "a code declared unreachable was emitted: ${JUSTIFIED_SEEN%,}"
    bad "the justification is false; give it a mutant instead"
    REAL_RED=1
  else
    good "no code declared unreachable appeared in any report this run"
  fi
fi

if [[ "$ORACLE" == naive || "$ORACLE" == both ]]; then
  run_suite naive "$NAIVE_ORACLE"
  NAIVE_RESULTS="$RESULTS_FILE"
  hdr "name-only straw man — summary"
  column -t "$NAIVE_RESULTS" 2>/dev/null || cat "$NAIVE_RESULTS"
  # A straw-man cell that is RED because the DRIVER refused to run is not
  # evidence of blindness — it is evidence that the demonstration did not
  # happen. Scoring the two the same way is how "the oracle crashed" becomes
  # "the oracle saw nothing", which would let the whole load-bearing argument
  # go vacuous in silence. They are separated here and the second is fatal.
  NAIVE_BLIND="$(red_mutant_ids "$NAIVE_RESULTS")"
  NAIVE_BROKEN="$(broken_cell_ids "$NAIVE_RESULTS")"

  # THE CELL COUNT, MEASURED — the real half has had one since B8(iii) and this
  # half had none. Everything above is derived from the ROWS THE LOOP WROTE, so
  # a cell that never ran contributes nothing and is invisible to all of it.
  # For the 60-odd mutants the straw man is blind to that is survivable — a
  # missing row drops an id out of NAIVE_BLIND and the frozen-set comparison
  # goes red — but for the two it CATCHES (01 and 23, the only two where the
  # name itself leaves pg_proc) it is not: those ids are absent from the frozen
  # set whether they ran and were caught or never ran at all. So the count is
  # taken from the file and reconciled against the declaration.
  NAIVE_MUTANTS_RUN="$(count_mutant_rows "$NAIVE_RESULTS")"
  NAIVE_PRISTINE_RUN="$(count_pristine_rows "$NAIVE_RESULTS")"
  NAIVE_EXPECTED_CELLS=$(( ${#MUTANTS[@]} - ${#NAIVE_UNADDRESSABLE[@]} ))
  if [[ -n "$ONLY" ]]; then
    info "straw man: ${NAIVE_MUTANTS_RUN} mutant cell(s) and ${NAIVE_PRISTINE_RUN} pristine cell(s) ran (--only in effect)"
    uncertify "the straw-man cell count was not reconciled against the declaration (--only)"
  else
    if [[ "$NAIVE_MUTANTS_RUN" -ne "$NAIVE_EXPECTED_CELLS" ]]; then
      bad "the straw-man run produced ${NAIVE_MUTANTS_RUN} mutant cell(s); the declaration"
      bad "  calls for ${NAIVE_EXPECTED_CELLS} (${#MUTANTS[@]} declared minus ${#NAIVE_UNADDRESSABLE[@]} the straw man cannot address)."
      bad "  A cell that did not run is invisible to the blind-set comparison whenever"
      bad "  it is one of the two the straw man catches, so the demonstration is not"
      bad "  available this run."
      rc_naive_count=1
    fi
    if [[ "$NAIVE_PRISTINE_RUN" -ne 2 ]]; then
      bad "the straw-man run produced ${NAIVE_PRISTINE_RUN} pristine cell(s); 2 are required,"
      bad "  or the baseline the blind set is measured against does not exist"
      rc_naive_count=1
    fi
    if [[ "${rc_naive_count:-0}" -eq 0 ]]; then
      good "straw man: ${NAIVE_MUTANTS_RUN} of ${NAIVE_EXPECTED_CELLS} addressable mutant cells and both pristine"
      good "  cells produced a measured row"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 9. verdict
# ---------------------------------------------------------------------------
hdr "verdict"
rc=0

if [[ "$COVERAGE_RED" -eq 1 ]]; then
  bad "reason-code coverage is incomplete; see section 1"
  rc="$EXIT_RED"
fi

# A document that misstates what the suite asserts fails the run whatever
# --oracle or --only asked for: it is a property of the files, it costs
# milliseconds, and it is the artefact a reader actually reads.
if [[ "$DOC_RED" -eq 1 ]]; then
  bad "the documentation and the MUTANTS array have diverged; see section 1c"
  rc="$EXIT_RED"
fi

if [[ "$ORACLE" == real || "$ORACLE" == both ]]; then
  if [[ "$REAL_RED" -eq 0 ]]; then
    if [[ "${#NOT_CERTIFYING[@]}" -eq 0 ]]; then
      good "the classifier is green on both pristine schemas, RED on all"
      good "  ${REAL_MUTANTS_RUN} of ${DECLARED_MUTANTS} declared mutants with the exact state and the exact"
      good "  reason codes, and every reason code it can emit is pinned by a mutant"
      good "  or by a verified justification"
    else
      # The measured numbers, and nothing that sounds like "every".
      good "the classifier is green on ${REAL_PRISTINE_RUN} pristine schema(s) and RED on the"
      good "  ${REAL_MUTANTS_RUN} of ${DECLARED_MUTANTS} declared mutants that RAN THIS TIME, with the exact state"
      good "  and the exact reason codes"
    fi
  else
    bad  "the classifier did not behave as required"
    rc="$EXIT_RED"
  fi
fi

if [[ "$ORACLE" == naive || "$ORACLE" == both ]]; then
  if [[ "$rc_naive_count" -ne 0 ]]; then
    bad "the straw-man half did not drive the cells it declares, so its blind set is"
    bad "  not a measurement of blindness — see the count above"
    rc="$EXIT_CONTROL"
  fi
  if [[ -n "$NAIVE_BROKEN" ]]; then
    bad "the straw-man run did not happen: the driver refused these cells"
    bad "  outright (harness error, or a red PRISTINE run) — ${NAIVE_BROKEN}"
    bad "  A cell the driver would not run says NOTHING about what a name-only"
    bad "  classifier can and cannot see, so the 'this classifier's strength is"
    bad "  load-bearing' demonstration is not available this run and must not be"
    bad "  reported as if it were."
    bad "  Read $WORK/naive.pristine-latest.driver.txt for the refusal itself."
    bad "  KNOWN CAUSE at the time of writing: the driver requires every"
    bad "  classifier it runs to emit schema_scan.kinds with at least two"
    bad "  entries, and naive-oracle.sql performs no whole-schema counter-scan"
    bad "  because the harness it models performed none. Do NOT resolve this by"
    bad "  making the straw man emit an empty scan_kinds — that is precisely the"
    bad "  'an absent counter-scan reads as a clean counter-scan' failure the"
    bad "  driver check exists to prevent. Resolve it in the driver/classifier"
    bad "  contract, by distinguishing 'declared no counter-scan, therefore not"
    bad "  eligible to be the gate' from 'claimed one and produced nothing'."
    rc="$EXIT_CONTROL"
  elif [[ -z "$NAIVE_BLIND" ]]; then
    bad "the name-only straw man caught every mutant — the demonstration is broken,"
    bad "because that would mean the strong classifier buys nothing"
    rc="$EXIT_CONTROL"
  elif [[ -n "$ONLY" ]]; then
    info "straw man blind to: ${NAIVE_BLIND}  (--only in effect; frozen set not asserted)"
    uncertify "the straw man's frozen blind set was not asserted"
  elif [[ "$NAIVE_BLIND" != "$NAIVE_BLIND_EXPECTED" ]]; then
    bad "the straw man's blind set changed"
    bad "  expected: $NAIVE_BLIND_EXPECTED"
    bad "  observed: $NAIVE_BLIND"
    rc="$EXIT_CONTROL"
  else
    good "reverting to name-only / bare-42501 logic, over ${NAIVE_MUTANTS_RUN} measured mutant cell(s)"
    good "  and ${NAIVE_PRISTINE_RUN} pristine cell(s), turns the suite RED on exactly"
    good "  ${NAIVE_BLIND}"
    good "  The only mutants it still catches are the ones where the NAME itself"
    good "  leaves pg_proc — a dropped function, and a name taken over by a table —"
    good "  because an absent name is the whole reach of a name-only check."
    good "  Everything the strong classifier reads — the exact signature, the owner,"
    good "  language, security mode, volatility, search_path, the derived body, the"
    good "  complete role landscape, the environment surface and the privileged"
    good "  probe — is load-bearing."
  fi
fi

if [[ "$rc" -eq 0 ]]; then
  if [[ "${#NOT_CERTIFYING[@]}" -eq 0 ]]; then
    printf '\n\033[1;32mSUITE GREEN\033[0m  (full run: certification)\n'
  else
    # A green partial run is a useful thing and is not an error. It is simply
    # not the claim the full run makes, and it must not be quotable as one.
    printf '\n\033[1;32mSUITE GREEN\033[0m \033[1;33m— NOT A CERTIFICATION\033[0m\n'
    printf '\033[1;33mThis run did not exercise the whole suite. It says nothing about:\033[0m\n'
    printf '  - %s\n' "${NOT_CERTIFYING[@]}"
    printf 'Re-run with no --only and --oracle both for the certifying run.\n'
  fi
else
  printf '\n\033[1;31mSUITE RED\033[0m\n'
  if [[ "${#NOT_CERTIFYING[@]}" -gt 0 ]]; then
    printf '\033[1;33m(this was also a partial run; %d assertion group(s) did not execute)\033[0m\n' \
      "${#NOT_CERTIFYING[@]}"
  fi
fi
exit "$rc"
