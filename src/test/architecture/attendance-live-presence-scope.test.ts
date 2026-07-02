/**
 * Live Presence is company-wide (Odoo parity). Branch is a soft scope:
 * select-and-highlight, never a hard filter that hides legacy/shared rows
 * (branch_id IS NULL).
 *
 * This guard locks two invariants on LivePresenceCard:
 *  1. It must NOT use a raw `.eq("branch_id", ...)` filter.
 *  2. It must route any branch scoping through `applyBranchFilter`, which
 *     emits `branch_id = X OR branch_id IS NULL`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(__dirname, "../../components/attendance/LivePresenceCard.tsx"),
  "utf8",
);

describe("LivePresenceCard — Odoo presence scope", () => {
  it("does not hard-filter by branch_id with .eq", () => {
    expect(SRC).not.toMatch(/\.eq\(\s*["']branch_id["']/);
  });

  it("routes branch scoping through applyBranchFilter", () => {
    expect(SRC).toMatch(/applyBranchFilter\s*\(/);
    expect(SRC).toMatch(/from\s+["']@\/lib\/branchScope["']/);
  });
});
