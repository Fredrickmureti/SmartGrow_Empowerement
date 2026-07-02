import { describe, it, expect } from "vitest";
import { canReverseRun, getLineageBadge, getRunLifecycle } from "../runLifecycle";

describe("canReverseRun", () => {
  it.each([
    [{ status: "paid" }, true],
    [{ status: "posted" }, true],
    [{ status: "draft" }, false],
    [{ status: "approved" }, false],
    [{ status: "reversed" }, false],
    [{ status: "paid", is_reversal: true }, false],
    [{ status: "paid", run_type: "correction" }, false],
    [{ status: "paid", reversed_at: "2026-01-01" }, false],
  ] as const)("evaluates %o", (run, allowed) => {
    expect(canReverseRun(run as any).allowed).toBe(allowed);
  });

  it("returns a reason when blocked", () => {
    const r = canReverseRun({ status: "paid", is_reversal: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/reversal/i);
  });
});

describe("getRunLifecycle", () => {
  it("prioritises is_reversal over status", () => {
    expect(getRunLifecycle({ status: "paid", is_reversal: true })).toBe("reversal");
  });
  it("detects correction runs", () => {
    expect(getRunLifecycle({ status: "paid", run_type: "correction" })).toBe("correction");
  });
  it("detects reversed originals", () => {
    expect(getRunLifecycle({ status: "reversed" })).toBe("reversed");
    expect(getRunLifecycle({ status: "paid", reversed_at: "x" })).toBe("reversed");
  });
});

describe("getLineageBadge", () => {
  it("badges reversal runs", () => {
    expect(getLineageBadge({ is_reversal: true })?.label).toBe("Reversal");
  });
  it("badges reversed originals", () => {
    expect(getLineageBadge({ status: "reversed" })?.label).toBe("Reversed");
  });
  it("returns null for plain posted runs", () => {
    expect(getLineageBadge({ status: "posted" })).toBeNull();
  });
});
