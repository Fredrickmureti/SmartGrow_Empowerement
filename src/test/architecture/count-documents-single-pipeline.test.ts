/**
 * Cycle-count paperwork has exactly ONE builder.
 *
 * The legacy fetchers inside `generate-document` read `wms_count_lines`
 * directly, ignored the approval resolution (so a posted count still printed
 * "awaiting approval") and joined people on `profiles.id` when the key is
 * `profiles.user_id` — which is why COUNTED / REVIEWED / APPROVED BY rendered
 * blank. The canonical builder is `src/services/documents/snapshots/wmsCount.ts`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const EDGE = readFileSync("supabase/functions/generate-document/index.ts", "utf8");

describe("cycle-count documents have a single pipeline", () => {
  it("generate-document holds no count fetchers", () => {
    for (const marker of [
      "fetchCountSheet",
      "fetchCountVarianceReport",
      "fetchCountAuditReport",
      "loadCountBundle",
      "COUNT_LINE_COLS",
    ]) {
      expect(EDGE).not.toContain(marker);
    }
  });

  it("count document types are not registered in the edge FETCHER_MAP", () => {
    for (const type of [
      "count_sheet",
      "count_sheet_blind",
      "count_variance_report",
      "count_audit_report",
    ]) {
      expect(EDGE).not.toContain(`${type}:`);
    }
  });

  it("the canonical snapshot builder still resolves sign-offs", () => {
    const snap = readFileSync("src/services/documents/snapshots/wmsCount.ts", "utf8");
    expect(snap).toContain("get_count_signoffs");
    expect(snap).toContain("approval_state");
  });
});
