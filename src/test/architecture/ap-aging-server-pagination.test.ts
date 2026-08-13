/**
 * Phase 5.5 guard — Aged Payables pages and searches on the SERVER.
 *
 * The failure mode this prevents: fetching every vendor and every open bill
 * into the browser and then slicing. On a large tenant that is a multi-MB
 * payload, and it silently makes the export a re-aggregation of whatever was
 * loaded instead of the accounting dataset. Search, paging and export all go
 * back to `get_ap_aging_summary`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const root = process.cwd();
const page = readFileSync(join(root, "src/pages/purchases/AgedPayables.tsx"), "utf8");
const hook = readFileSync(join(root, "src/hooks/useApAging.ts"), "utf8");

describe("AP aging — server-side pagination", () => {
  it("hook forwards search/limit/offset to the aging RPC", () => {
    expect(hook).toContain("p_search");
    expect(hook).toContain("p_limit");
    expect(hook).toContain("p_offset");
  });

  it("hook exposes the searched-cohort counters the UI needs for paging", () => {
    expect(hook).toContain("filteredVendorCount");
    expect(hook).toContain("hasMore");
  });

  it("page requests a bounded page instead of the whole vendor list", () => {
    expect(page).toMatch(/limit:\s*pageLimit/);
  });

  it("page never filters or slices vendors in the browser", () => {
    expect(page).not.toMatch(/vendors\s*\.filter\(/);
    expect(page).not.toMatch(/\.slice\(0,\s*visibleCount\)/);
    expect(page).not.toContain("visibleVendors");
  });

  it("export re-runs the engine with no page limit", () => {
    expect(page).toContain("fetchApAging(");
    expect(page).toMatch(/limit:\s*null/);
  });
});
