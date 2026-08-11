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

/** A complete, honest claim set. Every mutation below starts from this. */
function completeClaims(): Record<string, unknown> {
  const claims: Record<string, unknown> = { runId: 31407157501, attempt: 1 };
  for (const proof of REQUIRED_AUTHORIZATION_PROOFS) claims[proof] = true;
  return claims;
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
    expect(evidence!.runId).toBe(31407157501);
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
