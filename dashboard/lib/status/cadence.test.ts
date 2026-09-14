import { describe, expect, it } from "vitest";
import { buildPayload } from "@/test/payload-builder";
import { paperCadenceNotice } from "./cadence";

describe("paper weekday cadence observation", () => {
  it.each(["2026-09-14T15:34:59Z", "2026-09-13T19:00:00Z", "2026-09-12T19:00:00Z"])("does not warn before the weekday deadline: %s", (collectedAt) => {
    expect(paperCadenceNotice(buildPayload({ collectedAt }))).toBeNull();
  });
  it("explains absent weekday evidence without asserting a broker or holiday failure", () => {
    const notice = paperCadenceNotice(buildPayload({ collectedAt: "2026-09-14T15:35:00Z" }));
    expect(notice?.pending).toBe(false);
    expect(notice?.detail).toContain("No paper executor record is available for today");
  });
  it("does not warn when today's executor record exists", () => {
    const payload = buildPayload({ collectedAt: "2026-09-14T16:00:00Z" });
    expect(paperCadenceNotice({ ...payload,
      execution: { ...payload.execution, data: { ...payload.execution.data!, completedAt: "2026-09-14T15:06:00Z" } },
    })).toBeNull();
  });
  it("distinguishes a running workflow from missing evidence", () => {
    const payload = buildPayload({ collectedAt: "2026-09-14T16:00:00Z" });
    const operations = { ...payload.operations, data: { ...payload.operations.data!, latestAttempt: {
      ...payload.operations.data!.latestAttempt!, status: "in_progress", startedAt: "2026-09-14T15:55:00Z",
    } } };
    expect(paperCadenceNotice({ ...payload, operations })?.pending).toBe(true);
  });
  it("never schedules the manual-only live account or an unauthorized observer", () => {
    const payload = buildPayload({ collectedAt: "2026-09-14T16:00:00Z" });
    expect(paperCadenceNotice({ ...payload, accountMode: "live" })).toBeNull();
    expect(paperCadenceNotice({ ...payload, authorization: { ...payload.authorization, data: null } })).toBeNull();
  });
});
