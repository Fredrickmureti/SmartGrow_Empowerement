/**
 * Phase G+ architecture guard — Product Recall RPC (ADR 0073).
 *
 * Locks the doctrine: `recall_lot` is the single writer for recall
 * state; the UI never touches the recall tables directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

describe("Phase G+ — Product Recall RPC (ADR 0073)", () => {
  it("ADR 0073 is present and accepted", () => {
    const p = join(ROOT, "docs/adr/0073-product-recall-rpc.md");
    expect(existsSync(p)).toBe(true);
    const body = readFileSync(p, "utf8");
    expect(body).toMatch(/Status:\**\s*Accepted/);
    expect(body).toMatch(/recall_lot/);
  });

  it("migration creates recall_lot with the six-arg signature and correct grants", () => {
    const dir = join(ROOT, "supabase/migrations");
    const hits = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .filter(
        (b) =>
          b.includes("CREATE OR REPLACE FUNCTION public.recall_lot") &&
          b.includes("p_business_id") &&
          b.includes("p_product_id") &&
          b.includes("p_lot_number") &&
          b.includes("p_reason") &&
          b.includes("p_severity") &&
          b.includes("p_reference"),
      );
      expect(hits.length).toBeGreaterThan(0);
      const migration = hits[0];
      expect(migration).toMatch(/SECURITY DEFINER/);
      expect(migration).toMatch(/user_can_access_business/);
      expect(migration).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.recall_lot[\s\S]+authenticated/,
      );
      expect(migration).toMatch(
        /REVOKE EXECUTE ON FUNCTION public\.recall_lot[\s\S]+anon/,
      );
      // Header + item rows written atomically.
      expect(migration).toMatch(/INSERT INTO public\.product_recalls/);
      expect(migration).toMatch(/INSERT INTO public\.product_recall_items/);
      expect(migration).toMatch(/INSERT INTO public\.lot_quarantine/);
  });

  it("LotDetail invokes the RPC and never writes recall tables directly", () => {
    const src = readFileSync(
      join(ROOT, "src/pages/inventory/LotDetail.tsx"),
      "utf8",
    );
    expect(src).toMatch(/rpc\(\s*["']recall_lot["']/);
    // The UI must not bypass the RPC.
    expect(src).not.toMatch(/from\(\s*["']product_recalls["']\s*\)/);
    expect(src).not.toMatch(/from\(\s*["']lot_quarantine["']\s*\)/);
    expect(src).not.toMatch(/from\(\s*["']product_recall_items["']\s*\)/);
  });
});
