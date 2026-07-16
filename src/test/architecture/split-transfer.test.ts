/**
 * ADR-0068 · Phase C — Split stock transfers.
 *
 * Architecture guard. Pure source-of-migration inspection — no Postgres,
 * no React tree. Pins the current split-transfer contract on the two
 * transfer RPCs. If a future migration reintroduces the legacy generic
 * 'transfer' movement_type or drops location stamping, this test fails.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function latestDef(fnName: string): string {
  const dir = "supabase/migrations";
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const re = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fnName}\\s*\\(`,
    "i",
  );
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(dir, files[i]), "utf8");
    if (re.test(sql)) return sql;
  }
  throw new Error(`No migration defines ${fnName}`);
}

describe("ADR-0068 · split stock transfers", () => {
  const approveSrc = latestDef("approve_stock_transfer_atomic");
  const completeSrc = latestDef("complete_stock_transfer_atomic");
  const helperSrc = latestDef("get_business_transit_location");

  describe("get_business_transit_location helper", () => {
    it("is defined and returns a uuid", () => {
      expect(helperSrc).toMatch(/get_business_transit_location\s*\(/);
      expect(helperSrc).toMatch(/RETURNS\s+uuid/i);
    });

    it("resolves the business-scoped virtual transit location", () => {
      expect(helperSrc).toMatch(/location_type\s*=\s*'transit'/);
      expect(helperSrc).toMatch(/warehouse_id\s+IS\s+NULL/i);
    });
  });

  describe("approve_stock_transfer_atomic (dispatch leg)", () => {
    it("resolves the business transit location", () => {
      expect(approveSrc).toMatch(/get_business_transit_location\s*\(/);
    });

    it("emits directional transfer_out and transfer_in tokens", () => {
      expect(approveSrc).toMatch(/'transfer_out'/);
      expect(approveSrc).toMatch(/'transfer_in'/);
    });

    it("does not emit the legacy generic 'transfer' token", () => {
      // Strip comments and string-literal 'stock_transfer' before checking.
      const stripped = approveSrc
        .replace(/--[^\n]*\n/g, "\n")
        .replace(/'stock_transfer'/g, "");
      expect(stripped).not.toMatch(/'transfer'/);
    });

    it("stamps source_location_id and destination_location_id on movements", () => {
      expect(approveSrc).toMatch(/source_location_id/);
      expect(approveSrc).toMatch(/destination_location_id/);
    });
  });

  describe("complete_stock_transfer_atomic (receive leg)", () => {
    it("resolves the business transit location", () => {
      expect(completeSrc).toMatch(/get_business_transit_location\s*\(/);
    });

    it("emits directional transfer_out and transfer_in tokens", () => {
      expect(completeSrc).toMatch(/'transfer_out'/);
      expect(completeSrc).toMatch(/'transfer_in'/);
    });

    it("does not emit the legacy generic 'transfer' token", () => {
      const stripped = completeSrc
        .replace(/--[^\n]*\n/g, "\n")
        .replace(/'stock_transfer'/g, "");
      expect(stripped).not.toMatch(/'transfer'/);
    });

    it("stamps source_location_id and destination_location_id on movements", () => {
      expect(completeSrc).toMatch(/source_location_id/);
      expect(completeSrc).toMatch(/destination_location_id/);
    });
  });
});
