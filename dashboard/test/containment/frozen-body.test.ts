import { describe, expect, it } from "vitest";
import { ARTIFACT_ROLE, FROZEN_BODY, WRITES_ENABLED, frozenResponse } from "../../lib/frozen";

/**
 * The frozen body is frozen, and what that is and is not worth.
 *
 * WHY THIS EXISTS
 * ---------------
 * `lib/frozen.ts` calls `Object.freeze(FROZEN_BODY)` and its own comment
 * explains why: an artifact whose self-description can be edited at runtime is
 * an artifact whose description and behaviour can disagree, with the
 * description being the part operators read.
 *
 * A proof-honesty audit then asked the obvious question and found the answer
 * embarrassing: `grep -rn isFrozen` over the whole tree returned NOTHING. No
 * test asserted the freeze at all, so deleting `Object.freeze` would have been
 * a silent change — the file would still say it was frozen, in a comment.
 *
 * The same audit falsified the stronger reading of the claim, which is why the
 * limit is asserted here rather than left implied.
 */
describe("the frozen response body", () => {
  it("is frozen, and its fields cannot be reassigned", () => {
    expect(Object.isFrozen(FROZEN_BODY)).toBe(true);
    // Strict mode (ES modules are always strict) makes the write throw rather
    // than fail silently, which is the behaviour worth having.
    expect(() => {
      (FROZEN_BODY as unknown as { writes_enabled: boolean }).writes_enabled = true;
    }).toThrow();
    expect(FROZEN_BODY.writes_enabled).toBe(false);
    expect(FROZEN_BODY.artifact_role).toBe(ARTIFACT_ROLE);
    expect(WRITES_ENABLED).toBe(false);
  });

  it("serializes to the same thing the handlers send", async () => {
    const r = frozenResponse();
    expect(r.status).toBe(503);
    expect(r.headers.get("X-Artifact-Role")).toBe(ARTIFACT_ROLE);
    expect(r.headers.get("X-Writes-Enabled")).toBe("false");
    await expect(r.json()).resolves.toEqual(FROZEN_BODY);
  });

  it("STATES ITS LIMIT: Object.freeze does not make the SERIALIZATION immutable", () => {
    // Both emitters go through JSON.stringify, and `Object.freeze` does not
    // shadow an inherited `toJSON`. Measured by an audit against this exact
    // code: after polluting Object.prototype, the baseline
    //   {"error":"frozen","reason":"FROZEN_CONTAINMENT_BRIDGE","writes_enabled":false}
    // became
    //   {"error":"ok","reason":"UNFROZEN","writes_enabled":true}
    // while `Object.isFrozen(FROZEN_BODY)` still reported true.
    //
    // This needs in-process code execution, which is strictly more access than
    // any control in this artifact defends against — an attacker who has it
    // does not need to lie about the response. So the finding is recorded as a
    // BOUND on what the freeze proves, not as a hole to be plugged: the freeze
    // stops a refactor from reassigning a field, and nothing more.
    const proto = Object.prototype as unknown as { toJSON?: () => unknown };
    const had = Object.prototype.hasOwnProperty.call(Object.prototype, "toJSON");
    try {
      proto.toJSON = () => ({ error: "ok", reason: "UNFROZEN", writes_enabled: true });
      const polluted = JSON.parse(JSON.stringify(FROZEN_BODY));
      expect(polluted.reason, "the serialization is NOT protected by Object.freeze").toBe("UNFROZEN");
      expect(Object.isFrozen(FROZEN_BODY), "and the object still reports itself frozen").toBe(true);
    } finally {
      if (!had) delete proto.toJSON;
    }
    // and the pollution really is gone, so this case cannot poison the others
    expect(JSON.parse(JSON.stringify(FROZEN_BODY)).reason).toBe("FROZEN_CONTAINMENT_BRIDGE");
  });
});
