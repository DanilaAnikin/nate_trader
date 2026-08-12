/**
 * The positive authorization object.
 *
 * The validation gate used to decide `effective = reasons.length === 0`. That
 * is a negative test, and a negative test has the wrong default: nothing has to
 * be established for `[]` to occur, only nothing has to have objected. Every
 * condition added afterwards has to remember to push a reason, and the one that
 * forgets ships a green gate.
 *
 * This module inverts the default. A pass is a value of
 * `AuthorizedExecutionEvidence`, and the only way to obtain one is to satisfy
 * every proof in `REQUIRED_AUTHORIZATION_PROOFS` at once. A new mandatory
 * condition is added by adding its proof here, and every caller then fails to
 * compile until it supplies it — which is the property the reason list could
 * not give.
 *
 * Nothing in this module reads a document. It is the assembly point: the
 * conditions are evaluated where the evidence lives, and arrive here as claims
 * that must all be literally `true`.
 */

/**
 * Every proof a paper buy authorization requires, in the order they are
 * established. The set is pinned by a test, so adding or removing one is a
 * deliberate change to what the dashboard claims to have verified.
 */
import { isHeldProof } from "./proof";

export const REQUIRED_AUTHORIZATION_PROOFS = [
  /** The approved release SHA came from an authoritative source. */
  "approvedReleaseAuthoritative",
  /** The canonical validation report's stored assessment is PASS. */
  "canonicalReportPass",
  /** Its `allowed_mode` is the paper-eligible one, not a shadow-only run. */
  "canonicalReportPaperEligible",
  /** Its whole-report contract digest is present and well-formed. */
  "canonicalReportContractIntact",
  /** Strategy identity, ranking universe and bar prefix hashes all present. */
  "canonicalReportEvidenceComplete",
  /** Its check counts are positive and fully passing. */
  "canonicalReportChecksCounted",
  /** Generated in the past, bar boundary in the past, not past expiry. */
  "canonicalReportFresh",
  /** Its identity and universe both match the running runtime. */
  "canonicalReportBoundToRuntime",
  /** The exact 18-check preflight contract, all passing, fresh, paper mode. */
  "preflightContractComplete",
  /** That preflight is from this run id *and* this attempt. */
  "preflightCycleExact",
  /** Preflight, frozen plan and executor record agree on what they describe. */
  "lineageConsistent",
  /** A workflow run backs the runtime state. */
  "runIdentified",
  /** And a specific attempt of it — a re-run is a different execution. */
  "attemptIdentified",
  /** The runtime artifact was downloaded and every document in it parsed. */
  "runtimeArtifactComplete",
  /** `last_run.status` is PASS and the document does not contradict itself. */
  "lastRunStatusPass",
  /** The executor's own answer to "may this cycle buy" is `true`. */
  "marketEntryAllowed",
  /** No abort/error count, no disabled sleeve, no unclassified action name. */
  "noBlockingOrUnclassifiedAction",
  /** Performance history is present, current and agrees with scalar equity. */
  "performanceCurrentAndConsistent",
  /** Any `adaptive_rebalance_pending` present is fully valid. */
  "frozenPlanValid",
  /** Performance, run and step timestamps place one cycle, not a mixture. */
  "cycleTimestampsExact",
  /** positions.json is stamped in the same cycle as performance.json. */
  "positionsInCycle",
  /** last_run and performance state the same tier, and it is not HALT. */
  "riskTierAgrees",
] as const;

export type AuthorizationProof = (typeof REQUIRED_AUTHORIZATION_PROOFS)[number];

/**
 * The claim set a caller assembles.
 *
 * The values are **not** booleans. Two proofs used to be passed as the literal
 * `true` — `runtimeArtifactComplete` and `frozenPlanValid` — on the reasoning
 * that reaching that branch already established them. That reasoning was
 * correct when written and is exactly the kind that rots: relax an upstream
 * guard and the literal keeps saying `true`, with no test able to notice.
 *
 * A proof is now a branded value carrying a symbol private to `proof.ts`, and
 * the only functions that produce one take the parsed documents as arguments.
 * `true` does not type-check, and cannot be forged at runtime either.
 */
export type AuthorizationClaims = {
  readonly [K in AuthorizationProof]: unknown;
} & {
  readonly runId: number;
  readonly attempt: number;
};

const PROOF_SET: ReadonlySet<string> = new Set(REQUIRED_AUTHORIZATION_PROOFS);
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_AUTHORIZATION_PROOFS,
  "runId",
  "attempt",
]);

/** Enforces that the only route to an instance is `establish`. */
const CONSTRUCTION_KEY = Symbol("authorized-execution-evidence");

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Proof that one specific workflow attempt is authorized to have bought.
 *
 * Holding an instance means every condition in `REQUIRED_AUTHORIZATION_PROOFS`
 * was established for the cycle it names. There is no partial instance and no
 * way to construct one without the full set.
 */
export class AuthorizedExecutionEvidence {
  readonly runId: number;
  readonly attempt: number;

  private constructor(key: symbol, runId: number, attempt: number) {
    if (key !== CONSTRUCTION_KEY) {
      throw new TypeError(
        "AuthorizedExecutionEvidence must be obtained from establish()",
      );
    }
    this.runId = runId;
    this.attempt = attempt;
  }

  /**
   * Establish the evidence, or refuse.
   *
   * The parameter is deliberately `unknown`: the type system is not the
   * enforcement here. A caller assembling claims from parsed JSON, a partially
   * populated object, or a renamed field has to survive the same runtime check
   * as everyone else.
   */
  static establish(claims: unknown): AuthorizedExecutionEvidence | null {
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
      return null;
    }
    const record = claims as Record<string, unknown>;

    // Own keys only. A proof inherited from a prototype is not a claim this
    // object made.
    const own = Object.keys(record).filter((key) =>
      Object.prototype.hasOwnProperty.call(record, key),
    );

    // An unrecognised key means the caller and this module disagree about what
    // is being proved — most likely a proof was renamed on one side, and the
    // real key would then silently default to absent.
    if (own.some((key) => !ALLOWED_KEYS.has(key))) return null;

    for (const proof of PROOF_SET) {
      if (!Object.prototype.hasOwnProperty.call(record, proof)) return null;
      // A held proof of *this* name, minted by `proof.ts` from the documents.
      // A boolean — even `true` — is refused: it is an assertion, and the
      // whole point is that an assertion is not evidence.
      if (!isHeldProof(record[proof], proof as AuthorizationProof)) return null;
    }

    if (!isPositiveInteger(record.runId)) return null;
    if (!isPositiveInteger(record.attempt)) return null;

    return new AuthorizedExecutionEvidence(
      CONSTRUCTION_KEY,
      record.runId,
      record.attempt,
    );
  }
}
