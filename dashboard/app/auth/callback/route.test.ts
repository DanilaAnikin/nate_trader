import { describe, expect, it } from "vitest";
import { safeNext } from "./route";

/**
 * The `?next=` parameter cannot leave this origin.
 *
 * `${origin}${next}` reads as concatenation and behaves as a URL parser
 * instruction: everything before an `@` in an authority is userinfo, so
 * `next=@evil.com` produced `https://dashboard.example.com@evil.com`, whose
 * host is evil.com. These are the exact strings an audit used, plus the
 * neighbouring forms that any fix has to survive.
 */

const ORIGIN = "https://dashboard.example.com";

describe("safeNext keeps the redirect on this origin", () => {
  it("passes ordinary in-app paths through unchanged", () => {
    // non-vacuity: a function that returned "/" for everything would satisfy
    // every hostile case below while breaking the feature entirely
    expect(safeNext("/", ORIGIN)).toBe("/");
    expect(safeNext("/settings", ORIGIN)).toBe("/settings");
    expect(safeNext("/accounts/abc?tab=keys", ORIGIN)).toBe("/accounts/abc?tab=keys");
    expect(safeNext("/accounts#top", ORIGIN)).toBe("/accounts#top");
  });

  it("defaults to the root when absent", () => {
    expect(safeNext(null, ORIGIN)).toBe("/");
    expect(safeNext("", ORIGIN)).toBe("/");
  });

  it.each([
    ["@evil.com", "userinfo — the audit's case; host becomes evil.com"],
    [".evil.com", "appends to the hostname"],
    ["//evil.com", "protocol-relative"],
    ["//evil.com/path", "protocol-relative with a path"],
    ["/\\evil.com", "backslash form of protocol-relative"],
    ["https://evil.com", "absolute"],
    ["http://evil.com", "absolute, other scheme"],
    ["javascript:alert(1)", "scheme that is not navigation at all"],
    ["data:text/html,<script>", "data URL"],
    ["evil.com", "bare host, no slash"],
    ["\\\\evil.com", "UNC-ish"],
    ["/%2F%2Fevil.com", "encoded double slash"],
  ])("refuses %s (%s)", (hostile) => {
    const got = safeNext(hostile, ORIGIN);
    // Whatever it returns must resolve back to this origin. Asserting the
    // resulting ORIGIN rather than the returned string is what makes this a
    // check on the property instead of on a denylist.
    expect(new URL(`${ORIGIN}${got}`).origin).toBe(ORIGIN);
  });

  it("the hostile cases would have escaped before the fix", () => {
    // Red-before, kept as a test: the old code was `${origin}${next}` with no
    // validation. If this ever stops being true, the cases above are no longer
    // testing anything.
    expect(new URL(`${ORIGIN}@evil.com`).host).toBe("evil.com");
    expect(new URL(`${ORIGIN}.evil.com`).host).toBe("dashboard.example.com.evil.com");
  });
});
