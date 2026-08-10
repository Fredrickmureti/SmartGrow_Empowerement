/**
 * Ratchet — the Bills list reads through a bounded, server-paged query.
 *
 * AP Step 5: an AP ledger grows without bound, so the list must never pull
 * every bill into the browser. `useBillsPaginated` does `.range()` +
 * `count: "exact"` with the filters pushed to the database, and `useBills`
 * (the write surface) is capped to a working set.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const paginated = readFileSync(
  join(process.cwd(), "src", "hooks", "useBillsPaginated.ts"),
  "utf8",
);
const writeSurface = readFileSync(
  join(process.cwd(), "src", "hooks", "useBills.ts"),
  "utf8",
);
const page = readFileSync(join(process.cwd(), "src", "pages", "Bills.tsx"), "utf8");

describe("Bills list — server-side pagination", () => {
  it("the paged hook ranges and counts server-side", () => {
    expect(paginated).toContain(".range(from, to)");
    expect(paginated).toContain('count: "exact"');
  });

  it("filters are pushed to the server, not applied after the fetch", () => {
    expect(paginated).toContain('gte("bill_date"');
    expect(paginated).toContain('lte("bill_date"');
    expect(paginated).toContain("bill_number.ilike");
  });

  it("branch isolation still goes through applyBranchFilter", () => {
    expect(paginated).toContain("applyBranchFilter");
    expect(writeSurface).toContain("applyBranchFilter");
  });

  it("the write surface is bounded", () => {
    expect(writeSurface).toContain("BILLS_WORKING_SET");
    expect(writeSurface).toContain(".range(0, BILLS_WORKING_SET - 1)");
  });

  it("the page renders rows from the paged hook with pagination controls", () => {
    expect(page).toContain("useBillsPaginated");
    expect(page).toContain("DataTablePagination");
  });
});
