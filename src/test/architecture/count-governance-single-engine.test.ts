/**
 * Cycle count governance — one engine, no hardcoded gate (2026-08-17 wave).
 *
 * Origin: Warehouse told the operator "a manager must approve this" regardless
 * of the tenant's governance mode, because the demand came from a local
 * tolerance classification instead of the canonical approval engine. These are
 * source-level ratchets; the behavioural ones live in
 * supabase/tests/cycle_count_governance_test.sql.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("cycle count governance is server-authoritative", () => {
  const review = read("src/pages/warehouse/CountReview.tsx");
  const session = read("src/pages/warehouse/CountSession.tsx");

  it("never hardcodes an approval demand in Warehouse copy", () => {
    for (const src of [review, session]) {
      expect(src).not.toMatch(/manager'?s? approval/i);
      expect(src).not.toMatch(/needs? (a )?(manager|supervisor) to approve/i);
    }
  });

  it("never branches on the governance mode in the client", () => {
    for (const src of [review, session]) {
      expect(src).not.toMatch(/===\s*["']SOLO["']/);
      expect(src).not.toMatch(/governance_mode\s*===/);
    }
  });

  it("renders the server's routing outcome via the preview RPC", () => {
    const hook = read(
      "src/features/warehouse/counts/useCountGovernancePreview.ts",
    );
    expect(hook).toContain("wms_count_governance_preview");
    expect(review).toContain("useCountGovernancePreview");
  });
});

describe("the count governance regression suite stays in place", () => {
  const sql = read("supabase/tests/cycle_count_governance_test.sql");

  it("asserts the variance action is registered and routed", () => {
    expect(sql).toContain("warehouse.count_variance");
    expect(sql).toContain("approval_route");
  });

  it("asserts the engine's decision is mirrored and cannot be bypassed", () => {
    expect(sql).toContain("trg_mirror_approval_to_physical_count");
    expect(sql).toContain("GOV_USE_APPROVAL_ENGINE");
  });

  it("asserts count paperwork supersedes stale snapshots", () => {
    expect(sql).toContain("ensure_document_record");
    expect(sql).toContain("superseded_by = v_id");
  });
});
