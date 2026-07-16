/**
 * Architecture guard · Phase D.3 — ASN CSV import contract.
 *
 * Pins:
 *  - the canonical CSV field set for `inbound_shipments` + `inbound_shipment_items`
 *  - the batch handler's grouping-by-shipment-number contract
 *  - tenant scoping (org/business/branch) on every inserted row
 *  - duplicate detection + line-error rollback
 *  - re-export from the import-configs barrel
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASN_IMPORT_FIELDS,
  createAsnBatchImportHandler,
} from "@/lib/importConfigs";

const HANDLER_SRC = readFileSync(
  resolve(__dirname, "../../lib/importConfigs/asnImportBatch.ts"),
  "utf-8",
);

describe("ASN CSV import · field definitions (Phase D.3)", () => {
  const keys = new Set(ASN_IMPORT_FIELDS.map((f) => f.key));

  it("covers every required header and line-level field", () => {
    for (const key of [
      "shipment_number",
      "product_sku",
      "expected_quantity",
    ]) {
      expect(keys.has(key)).toBe(true);
      const def = ASN_IMPORT_FIELDS.find((f) => f.key === key)!;
      expect(def.required).toBe(true);
    }
  });

  it("carries optional lot / expiry / manufacture / carrier / tracking columns", () => {
    for (const key of [
      "expected_lot_number",
      "expected_expiry_date",
      "expected_manufacture_date",
      "carrier",
      "tracking_number",
      "dispatched_at",
      "expected_arrival",
      "po_number",
      "vendor_name",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it("uses the canonical FieldDefinition shape", () => {
    for (const def of ASN_IMPORT_FIELDS) {
      expect(typeof def.key).toBe("string");
      expect(typeof def.label).toBe("string");
      expect(typeof def.required).toBe("boolean");
      expect(["text", "number", "date", "email", "select", "category"]).toContain(def.type);
      expect(Array.isArray(def.aliases)).toBe(true);
    }
  });
});

describe("ASN CSV import · batch handler (Phase D.3)", () => {
  it("is exported from the import-configs barrel", () => {
    expect(typeof createAsnBatchImportHandler).toBe("function");
  });

  it("groups rows by shipment_number", () => {
    expect(HANDLER_SRC).toMatch(/row\.shipment_number/);
    expect(HANDLER_SRC).toMatch(/new Map<string,/);
  });

  it("checks for existing shipments before insert (idempotency)", () => {
    expect(HANDLER_SRC).toMatch(
      /from\(["']inbound_shipments["']\)[\s\S]*?\.select\(["']shipment_number["']\)[\s\S]*?\.in\(["']shipment_number["']/,
    );
  });

  it("resolves every SKU via the product resolver before any insert", () => {
    expect(HANDLER_SRC).toMatch(/productResolver\.resolveBySku/);
    expect(HANDLER_SRC).toMatch(/unknown SKU/);
  });

  it("inserts headers into inbound_shipments with full tenant scoping", () => {
    const headerBlock = HANDLER_SRC.match(
      /from\(["']inbound_shipments["']\)\s*\.insert\(\{[\s\S]*?\}\)/,
    )?.[0];
    expect(headerBlock).toBeTruthy();
    expect(headerBlock!).toMatch(/organization_id:/);
    expect(headerBlock!).toMatch(/business_id:/);
    expect(headerBlock!).toMatch(/branch_id:/);
    expect(headerBlock!).toMatch(/shipment_number:/);
    expect(headerBlock!).toMatch(/\bstatus\b/);
  });

  it("inserts lines into inbound_shipment_items with expected_* fields", () => {
    expect(HANDLER_SRC).toMatch(/from\(["']inbound_shipment_items["']\)/);
    expect(HANDLER_SRC).toMatch(/expected_quantity:/);
    expect(HANDLER_SRC).toMatch(/expected_lot_number:/);
    expect(HANDLER_SRC).toMatch(/expected_expiry_date:/);
    expect(HANDLER_SRC).toMatch(/expected_manufacture_date:/);
  });

  it("rolls the header back when line insert fails (no orphans)", () => {
    expect(HANDLER_SRC).toMatch(
      /from\(["']inbound_shipments["']\)\.delete\(\)\.eq\(["']id["']/,
    );
  });

  it("emits ImportResults-shaped errors ({ rowIndex, data, errors })", () => {
    expect(HANDLER_SRC).toMatch(/rowIndex/);
    expect(HANDLER_SRC).toMatch(/errors:\s*message/);
  });
});
