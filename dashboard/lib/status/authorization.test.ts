/**
 * A pass must be *constructed*, not inferred from an empty list.
 *
 * The gate used to compute `effective = reasons.length === 0 ? "PASS" : "FAIL"`.
 * That makes silence authorizing: every future condition has to remember to
 * push a reason, and the one that forgets produces a green gate. The direction
 * of the default is the whole bug — nothing has to go right for `[]`, it only
 * has to be the case that nothing pushed.
 *
 * `AuthorizedExecutionEvidence` inverts it. Each mandatory proof must be
 * present and literally `true`; anything else — a missing key, a null, a
 * truthy non-boolean, an extra key — yields no evidence and therefore no pass.
 */

import { describe, expect, it } from "vitest";
import {
  AuthorizedExecutionEvidence,
  REQUIRED_AUTHORIZATION_PROOFS,
} from "./authorization";
import { deriveAuthorizationClaims } from "./proof";
import { parseLastRun, parsePerformanceRuntime } from "./parse";
import { parsePositionsRuntime } from "./positions";
import {
  APPROVED_SHA,
  healthyValidationInfo,
  healthyPreflightInfo,
  lastRunJson,
  performanceJson,
  positionsJson,
} from "@/test/fixtures";

const RUN_ID = 31407157501;
const NOW = new Date("2026-08-07T17:00:00Z");

/**
 * A complete, honest claim set — built the only way one can be built.
 *
 * There is no way to hand-write this any more, which is the point. Two proofs
 * used to be passed as the literal `true`, and a literal is indistinguishable
 * from a derivation right up until the code it stands in for changes.
 */
function completeClaims(): Record<string, unknown> {
  const lastRun = parseLastRun(lastRunJson());
  const performance = parsePerformanceRuntime(performanceJson());
  const positions = parsePositionsRuntime(positionsJson());
  if (!lastRun || !performance || !positions) {
    throw new Error("the runtime fixtures must parse for this test to mean anything");
  }
  return deriveAuthorizationClaims({
    report: healthyValidationInfo(),
    paperEligibleMode: "paper-validation-eligible",
    approvedReleaseSha: APPROVED_SHA,
    approvedReleaseAuthoritative: true,
    lineageOk: true,
    preflight: healthyPreflightInfo(),
    preflightProblems: [],
    preflightRunId: RUN_ID,
    preflightAttempt: 1,
    executionRunId: RUN_ID,
    executionAttempt: 1,
    lastRun,
    performance,
    positions,
    cycle: {
      lastRunCompletedAt: lastRun.completedAt,
      executeStep: {
        startedAt: "2026-08-07T16:04:00.000Z",
        completedAt: "2026-08-07T16:06:00.000Z",
      },
      now: NOW,
    },
    sameCycleToleranceMs: 60 * 60 * 1000,
    now: NOW,
  });
}

describe("REQUIRED_AUTHORIZATION_PROOFS", () => {
  it("is the exact, ordered set of proofs a paper buy requires", () => {
    // Pinned deliberately. Adding or removing a proof is a change to what the
    // dashboard claims to have verified, and must be made on purpose.
    expect([...REQUIRED_AUTHORIZATION_PROOFS]).toEqual([
      "approvedReleaseAuthoritative",
      "canonicalReportPass",
      "canonicalReportPaperEligible",
      "canonicalReportContractIntact",
      "canonicalReportEvidenceComplete",
      "canonicalReportChecksCounted",
      "canonicalReportFresh",
      "canonicalReportBoundToRuntime",
      "preflightContractComplete",
      "preflightCycleExact",
      "lineageConsistent",
      "runIdentified",
      "attemptIdentified",
      "runtimeArtifactComplete",
      "lastRunStatusPass",
      "marketEntryAllowed",
      "noBlockingOrUnclassifiedAction",
      "performanceCurrentAndConsistent",
      "frozenPlanValid",
      "cycleTimestampsExact",
      "positionsInCycle",
      "riskTierAgrees",
    ]);
  });

  it("contains no duplicates", () => {
    expect(new Set(REQUIRED_AUTHORIZATION_PROOFS).size).toBe(
      REQUIRED_AUTHORIZATION_PROOFS.length,
    );
  });
});

describe("AuthorizedExecutionEvidence", () => {
  it("is established when every mandatory proof holds", () => {
    const evidence = AuthorizedExecutionEvidence.establish(completeClaims());
    expect(evidence).not.toBeNull();
    expect(evidence!.runId).toBe(RUN_ID);
    expect(evidence!.attempt).toBe(1);
  });

  it("cannot be constructed directly", () => {
    // The only route is `establish`, which is what makes the proof set
    // unavoidable. A public constructor would let a caller mint a pass.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new (AuthorizedExecutionEvidence as any)(1, 1);
    }).toThrow();
  });

  it.each([...REQUIRED_AUTHORIZATION_PROOFS])(
    "is refused when the %s proof is removed",
    (proof) => {
      const claims = completeClaims();
      delete claims[proof];
      expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
    },
  );

  it.each([...REQUIRED_AUTHORIZATION_PROOFS])(
    "is refused when the %s proof is null",
    (proof) => {
      const claims = completeClaims();
      claims[proof] = null;
      expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
    },
  );

  it.each([...REQUIRED_AUTHORIZATION_PROOFS])(
    "is refused when the %s proof is false",
    (proof) => {
      const claims = completeClaims();
      claims[proof] = false;
      expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
    },
  );

  it.each([...REQUIRED_AUTHORIZATION_PROOFS])(
    "is refused when the %s proof is a truthy non-boolean",
    (proof) => {
      for (const truthy of [1, "true", "PASS", {}, [], "yes"]) {
        const claims = completeClaims();
        claims[proof] = truthy;
        expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
      }
    },
  );

  it.each([...REQUIRED_AUTHORIZATION_PROOFS])(
    "is refused when the %s proof is the literal true",
    (proof) => {
      // The specific regression. `runtimeArtifactComplete` and
      // `frozenPlanValid` were passed exactly like this, and no mutation test
      // could see it: the matrix only checked that a `false` was rejected.
      const claims = completeClaims();
      claims[proof] = true;
      expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
    },
  );

  it("is refused when a proof is a hand-built object wearing the right shape", () => {
    // The brand is a module-private symbol, not `Symbol.for`, so a forgery
    // cannot carry it. This is what stops a caller re-implementing `mint`.
    const claims = completeClaims();
    claims.runtimeArtifactComplete = {
      tag: Symbol("nate-trader.authorization-proof"),
      name: "runtimeArtifactComplete",
      held: true,
      detail: null,
    };
    expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
  });

  it("is refused when a held proof carries someone else's name", () => {
    // A real proof, moved to the wrong key. Without the name check a single
    // genuine proof could satisfy every slot.
    const claims = completeClaims();
    claims.frozenPlanValid = claims.runtimeArtifactComplete;
    expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
  });

  it("is refused when an unrecognised proof key is added", () => {
    // An extra key means the caller and this module disagree about what is
    // being proved. Ignoring it would let a renamed proof pass as satisfied
    // while its real key silently defaults away.
    const claims = { ...completeClaims(), somethingElse: true };
    expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
  });

  it.each([
    ["a missing run id", { runId: undefined }],
    ["a null run id", { runId: null }],
    ["a zero run id", { runId: 0 }],
    ["a negative run id", { runId: -1 }],
    ["a fractional run id", { runId: 1.5 }],
    ["a string run id", { runId: "31407157501" }],
    ["a missing attempt", { attempt: undefined }],
    ["a zero attempt", { attempt: 0 }],
    ["a fractional attempt", { attempt: 1.5 }],
    ["a string attempt", { attempt: "1" }],
  ])("is refused with %s", (_label, patch) => {
    const claims: Record<string, unknown> = { ...completeClaims(), ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete claims[key];
    }
    expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["a string", "authorized"],
    ["a number", 1],
  ])("is refused when the claim set is %s", (_label, claims) => {
    expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
  });

  it("is refused when a proof is inherited rather than owned", () => {
    // `Object.create` puts the proofs on the prototype. `in` would find them;
    // an authorization must be built from the object's own claims.
    const claims = Object.create(completeClaims()) as Record<string, unknown>;
    claims.runId = 1;
    claims.attempt = 1;
    expect(AuthorizedExecutionEvidence.establish(claims)).toBeNull();
  });
});
