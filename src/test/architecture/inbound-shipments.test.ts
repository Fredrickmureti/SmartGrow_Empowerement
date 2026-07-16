/**
 * ADR-0069 · Phase D — Inbound shipments (ASN) + GRN discrepancies.
 *
 * Architecture guard. Confirms the migration ships three tables with the
 * canonical inventory RLS shape (business + branch + module permission),
 * plus the expected discrepancy types and lifecycle enums. Fails if a
 * future migration weakens any of those contracts.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function latestCreateSql(tableName: string): string {
  const dir = "supabase/migrations";
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+public\\.${tableName}\\b`,
    "i",
  );
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(dir, files[i]), "utf8");
    if (re.test(sql)) return sql;
  }
  throw new Error(`No migration creates ${tableName}`);
}

const TABLES = [
  "inbound_shipments",
  "inbound_shipment_items",
  "goods_receipt_discrepancies",
];

describe("ADR-0069 · inbound shipments + GRN discrepancies", () => {
  for (const table of TABLES) {
    const sql = latestCreateSql(table);

    describe(table, () => {
      it("creates the table", () => {
        expect(sql).toMatch(new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+public\\.${table}`, "i"));
      });

      it("grants scoped privileges to authenticated + full to service_role", () => {
        expect(sql).toMatch(new RegExp(`GRANT[^;]+ON\\s+public\\.${table}\\s+TO\\s+authenticated`, "i"));
        expect(sql).toMatch(new RegExp(`GRANT\\s+ALL\\s+ON\\s+public\\.${table}\\s+TO\\s+service_role`, "i"));
      });

      it("enables row-level security", () => {
        expect(sql).toMatch(new RegExp(`ALTER\\s+TABLE\\s+public\\.${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i"));
      });

      it("policies scope through user_can_access_business + can_access_branch", () => {
        const selectPolicy = new RegExp(
          `CREATE\\s+POLICY\\s+${table}_select[\\s\\S]*?FOR\\s+SELECT[\\s\\S]*?user_can_access_business[\\s\\S]*?can_access_branch`,
          "i",
        );
        expect(sql).toMatch(selectPolicy);

        const writePolicy = new RegExp(
          `CREATE\\s+POLICY\\s+${table}_write[\\s\\S]*?FOR\\s+ALL`,
          "i",
        );
        expect(sql).toMatch(writePolicy);
        // Write policy must also gate on the inventory-write module permission.
        expect(sql).toMatch(
          new RegExp(`${table}_write[\\s\\S]*?user_has_module_permission[\\s\\S]*?'inventory'[\\s\\S]*?'write'`, "i"),
        );
      });
    });
  }

  describe("enums", () => {
    // Grab the earliest migration in this range that creates them (single one).
    const dir = "supabase/migrations";
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().reverse();
    let enumSql = "";
    for (const f of files) {
      const s = readFileSync(join(dir, f), "utf8");
      if (s.includes("inbound_shipment_status") && s.includes("goods_receipt_discrepancy_type")) {
        enumSql = s;
        break;
      }
    }

    it("inbound_shipment_status covers the lifecycle", () => {
      expect(enumSql).toMatch(/'draft'/);
      expect(enumSql).toMatch(/'dispatched'/);
      expect(enumSql).toMatch(/'in_transit'/);
      expect(enumSql).toMatch(/'arrived'/);
      expect(enumSql).toMatch(/'received'/);
      expect(enumSql).toMatch(/'cancelled'/);
    });

    it("goods_receipt_discrepancy_type covers the primary categories", () => {
      for (const t of ["over", "short", "damaged", "wrong_item", "expired", "quality_hold"]) {
        expect(enumSql).toMatch(new RegExp(`'${t}'`));
      }
    });

    it("goods_receipt_discrepancy_resolution covers the resolution paths", () => {
      for (const t of ["pending", "vendor_credit", "insurance_claim", "accept_and_move_on", "return_to_vendor"]) {
        expect(enumSql).toMatch(new RegExp(`'${t}'`));
      }
    });
  });

  describe("linkage", () => {
    const shipItems = latestCreateSql("inbound_shipment_items");
    const discrepancies = latestCreateSql("goods_receipt_discrepancies");

    it("inbound_shipment_items links to inbound_shipments and purchase_order_items", () => {
      expect(shipItems).toMatch(/REFERENCES\s+public\.inbound_shipments/i);
      expect(shipItems).toMatch(/REFERENCES\s+public\.purchase_order_items/i);
      expect(shipItems).toMatch(/REFERENCES\s+public\.products/i);
    });

    it("goods_receipt_discrepancies links back to goods_receipts and (optionally) shipment items", () => {
      expect(discrepancies).toMatch(/REFERENCES\s+public\.goods_receipts/i);
      expect(discrepancies).toMatch(/REFERENCES\s+public\.inbound_shipment_items/i);
      expect(discrepancies).toMatch(/REFERENCES\s+public\.products/i);
    });
  });
});
