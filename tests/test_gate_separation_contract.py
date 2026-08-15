"""The four gates must stay separate, and only one of them can authorize paper.

Splitting `release-gate` into a deterministic `repository-regression` job plus a
strategy-eligibility job unblocked main. It would be a disaster if that split
also made it easier to trade. These tests pin the separation as a property of
the checked-in workflow files, so a future edit that blurs it fails here rather
than in production.

DELIBERATELY NO YAML PARSER. The first version of this file used PyYAML behind
`pytest.importorskip("yaml")`. PyYAML is in neither requirements.txt nor
requirements.lock — it was importable on the development machine purely as a
system package. Under CI, which installs `--require-hashes -r requirements.lock`
and nothing else, every test here would have SKIPPED, and a skipped test reports
no failure. The entire contract would have been vacuous in the only place it
matters. Adding PyYAML to the lock was not an option either: requirements.lock
is a strategy-identity source, and changing it invalidates the canonical
validation artifact.

So the assertions below read the workflow files as text. That is less elegant
and strictly more honest: it has no import that can vanish, and it cannot skip.
"""

from __future__ import annotations

import re
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
PAPER = WORKFLOWS / "paper-production.yml"
RELEASE = WORKFLOWS / "v11-release.yml"
CONTAINMENT = WORKFLOWS / "dashboard-containment-gate.yml"


def _job_block(text: str, job: str) -> str:
    """The lines belonging to one top-level job.

    Top-level jobs sit at exactly two spaces of indentation under `jobs:`, so a
    block runs from its own header to the next two-space key.
    """
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if re.match(rf"^  {re.escape(job)}:\s*$", line):
            start = i
            break
    assert start is not None, f"job {job!r} not found"
    out = []
    for line in lines[start + 1 :]:
        if re.match(r"^  \S", line):
            break
        out.append(line)
    return "\n".join(out)


def test_all_three_workflows_exist_and_are_non_trivial():
    # non-vacuity for everything below: an empty or missing file would make the
    # "forbidden string is absent" assertions trivially true
    for p in (PAPER, RELEASE, CONTAINMENT):
        assert p.is_file(), f"missing workflow: {p}"
        assert len(p.read_text()) > 500, f"suspiciously small workflow: {p}"


def test_job_block_helper_actually_isolates_a_job():
    """A positive control for the parser these tests depend on.

    If `_job_block` silently returned the whole file, several assertions below
    would pass for the wrong reason.
    """
    block = _job_block(RELEASE.read_text(), "repository-regression")
    assert "pytest" in block, "helper did not capture the job it was asked for"
    assert "supabase/tests/run_postgrest.sh" not in block, (
        "helper leaked into a neighbouring job"
    )


# ── only v11-release.yml can gate paper ─────────────────────────────────────


def test_paper_production_gates_on_v11_release_only():
    """paper-production must consult v11-release.yml and nothing else.

    The whole point of adding a second trusted workflow is that a green
    containment result must be unable to authorize trading. The cheapest way for
    that to go wrong is for someone to add the new workflow name to this query.
    """
    text = PAPER.read_text()
    assert "actions/workflows/v11-release.yml/runs" in text, (
        "paper-production no longer gates on the v11-release workflow"
    )
    for forbidden in (
        "dashboard-containment-gate",
        "repository-regression",
        "strategy-evidence-integrity",
        "NOT_APPLICABLE",
    ):
        assert forbidden not in text, (
            f"paper-production references {forbidden!r}; a containment or "
            "engineering result must never be able to satisfy the paper gate"
        )


def test_paper_production_requires_success_push_and_exact_sha():
    """The three qualifiers that make the gate meaningful.

    Dropping any one silently widens it: without status=success a red run
    counts, without event=push a workflow_dispatch on any branch counts, and
    without the head_sha filter any successful run at all counts.
    """
    text = PAPER.read_text()
    assert "status=success" in text, "the paper gate no longer requires success"
    assert "event=push" in text, "the paper gate no longer requires a push event"
    assert "head_sha ==" in text, "the paper gate no longer pins the exact SHA"
    assert "APPROVED_RELEASE_SHA" in text


def test_paper_production_still_pins_a_full_sha_and_verifies_the_checkout():
    text = PAPER.read_text()
    assert "^[0-9a-f]{40}$" in text, "the approved SHA is no longer shape-checked"
    assert "checkout does not match the approved paper release" in text


# ── the split itself ────────────────────────────────────────────────────────


def test_release_workflow_separates_regression_from_eligibility():
    text = RELEASE.read_text()
    regression = _job_block(text, "repository-regression")
    eligibility = _job_block(text, "release-gate")

    # The deterministic job must NOT consult the promotion artifact: that is the
    # single thing in the old combined job whose result depended on the calendar
    # and on how fresh the market-data cache happened to be.
    assert "sanity_check.py" not in regression, (
        "repository-regression runs sanity_check.py, so it is no longer "
        "deterministic and re-couples merging to strategy eligibility"
    )
    assert "sanity_check.py" in eligibility, (
        "release-gate no longer verifies the canonical promotion artifact"
    )
    assert "pytest" in regression, "the regression suite is no longer run"
    assert "compileall" in regression
    assert "ruff check" in regression


def test_eligibility_job_cannot_run_before_the_regression_job():
    """Ordering, so a green eligibility result never stands on unrun tests."""
    eligibility = _job_block(RELEASE.read_text(), "release-gate")
    assert re.search(r"^\s*needs:\s*repository-regression\s*$", eligibility, re.M), (
        "release-gate does not declare needs: repository-regression"
    )


# ── the containment gate cannot authorize paper ─────────────────────────────


def test_containment_gate_declares_paper_not_promotable():
    text = CONTAINMENT.read_text()
    for claim in (
        "paper_promotable",
        "dashboard_containment_promotable",
        "paper_validation_required",
        "paper_validation_result",
        "strategy_identity_unchanged",
        "containment_scope_valid",
    ):
        assert claim in text, f"the containment attestation omits {claim!r}"
    assert "NOT_APPLICABLE is not PASS" in text, (
        "the containment gate no longer states that NOT_APPLICABLE is not a pass"
    )


def test_containment_gate_never_runs_candidate_code_with_secrets():
    """No pull_request_target, and read-only permissions.

    pull_request_target runs the candidate's code with the base repository's
    secrets. For a gate whose entire job is to judge untrusted candidates, that
    would hand the candidate the keys it is being checked for.
    """
    text = CONTAINMENT.read_text()
    # Match CODE, not prose. The workflow documents why it does NOT use
    # pull_request_target, so a naive substring check fires on its own
    # explanation — the same way the R0 wiring guard once fired on the comments
    # describing the defects it replaced. A guard that flags its own
    # documentation gets deleted, so it has to read only what YAML would.
    code = "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    )
    assert "pull_request_target" not in code, (
        "the containment gate uses pull_request_target"
    )
    perms = re.search(r"^permissions:\n((?:  .*\n)+)", text, re.M)
    assert perms, "the containment gate declares no explicit permissions block"
    body = perms.group(1)
    assert re.search(r"^  contents:\s*read\s*$", body, re.M), (
        f"contents is not read-only: {body!r}"
    )
    granted = re.findall(r"^  ([a-z-]+):", body, re.M)
    assert granted == ["contents"], (
        f"containment gate requests more than contents: {granted}"
    )


def test_containment_verdict_is_always_evaluated_and_needs_every_job():
    """A mandatory job that is skipped must fail the verdict, not be ignored."""
    verdict = _job_block(CONTAINMENT.read_text(), "containment-verdict")
    assert re.search(r"^\s*if:\s*always\(\)\s*$", verdict, re.M), (
        "the verdict job is not if: always(), so a cancelled or skipped "
        "mandatory job would leave it silently green"
    )
    needs = re.search(r"^\s*needs:\s*\[(.*?)\]", verdict, re.M)
    assert needs, "the verdict job declares no needs list"
    declared = {n.strip() for n in needs.group(1).split(",")}
    mandatory = {
        "identity-boundary",
        "dashboard-suite",
        "bundle-scan",
        "schema-compatibility",
    }
    assert mandatory <= declared, f"verdict does not depend on {mandatory - declared}"


def test_identity_boundary_runs_the_trusted_policy_from_main():
    text = CONTAINMENT.read_text()
    assert "refs/heads/main" in text, (
        "the containment gate does not refuse to run from a non-trusted ref, so "
        "a candidate branch could supply the policy that judges it"
    )
    assert ".github/containment/trusted-policy.sh" in text
    policy = WORKFLOWS.parent / "containment" / "trusted-policy.sh"
    assert policy.is_file(), "the trusted policy script is missing"
    body = policy.read_text()
    # the two lineage constants are the whole reason the policy exists
    assert "7b9c55806ec79e2f56b5831063fea4c613e62d50" in body, "bridge base unpinned"
    assert "0f6c415324625767f4b03c0cbfeda63b37d8c753" in body, (
        "the post-0014 candidate line is no longer rejected by ancestry"
    )
