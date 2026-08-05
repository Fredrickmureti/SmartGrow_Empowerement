/**
 * ADR-0110 Phase 8 — supplier identity is scoped, and discovery is a seam.
 *
 * A supplier's own part number belongs to that supplier: it may only resolve
 * when the capture surface knows which vendor the goods came from. These
 * guards keep the invariants in place:
 *
 *   - the resolver hook forwards supplier context to the RPC and caches per
 *     supplier (otherwise vendor A's answer leaks into vendor B's scan);
 *   - the WMS gate accepts and forwards that context;
 *   - the `supplier_scoped` outcome has shared operator copy and blocks;
 *   - linking a discovered code goes through the ONE identifier write seam.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  describeIdentityOutcome,
  IDENTITY_STATUSES,
} from "@/features/products/identity/identityOutcome";
import { describeEvidence } from "@/features/products/identity/useSupplierCodeDiscovery";

const read = (rel: string) => readFileSync(resolve(__dirname, "../../", rel), "utf-8");

describe("supplier_scoped outcome", () => {
  it("is part of the shared taxonomy", () => {
    expect(IDENTITY_STATUSES).toContain("supplier_scoped");
  });

  it("blocks the line and offers linking rather than enrolment", () => {
    const copy = describeIdentityOutcome({ status: "supplier_scoped", code: "AB-991" });
    expect(copy.blocking).toBe(true);
    expect(copy.title).toContain("AB-991");
    expect(copy.detail).toMatch(/supplier/i);
    expect(copy.remediation.action).toBe("link_supplier_code");
  });

  it("never leaks RPC or SQL detail", () => {
    for (const status of IDENTITY_STATUSES) {
      const copy = describeIdentityOutcome({ status, code: "X1" });
      expect(`${copy.title} ${copy.detail}`).not.toMatch(
        /rpc|postgrest|sqlstate|resolve_product_identity|discover_supplier_identity/i,
      );
    }
  });
});

describe("evidence copy", () => {
  it("explains every evidence kind in operator language", () => {
    for (const e of ["open_po", "supplier_catalogue", "other_supplier"] as const) {
      const line = describeEvidence(e);
      expect(line.length).toBeGreaterThan(10);
      expect(line).not.toMatch(/_|purchase_order_items|vendor_pricelists/);
    }
  });
});

describe("supplier context flows through the seams", () => {
  it("the resolver hook sends p_supplier_id and keys its cache on it", () => {
    const src = read("hooks/inventory/useResolveProductIdentity.ts");
    expect(src).toMatch(/p_supplier_id/);
    expect(src).toMatch(/supplierId \?\? "-"/);
    expect(src).toMatch(/case "supplier_scoped"/);
  });

  it("the WMS gate forwards supplier context", () => {
    const src = read("features/warehouse/scanning/useWmsIdentityGate.ts");
    expect(src).toMatch(/supplierId/);
    expect(src).toMatch(/useResolveProductIdentity\(businessId, branchId, \{/);
  });

  it("receiving resolves the vendor from the inbound document", () => {
    const src = read("features/warehouse/receiving/ReceivingSessionWorkspace.tsx");
    expect(src).toMatch(/useReceivingSessionSupplier/);
    expect(src).toMatch(/supplierId: supplierCtx\.supplierId/);
    expect(src).toMatch(/discovery\.discover\(/);
  });
});

describe("discovery never bypasses the write seam", () => {
  const src = read("features/products/identity/useSupplierCodeDiscovery.ts");

  it("links through writeIdentifier with kind supplier", () => {
    expect(src).toMatch(/from "\.\/writeIdentifier"/);
    expect(src).toMatch(/kind: "supplier"/);
    expect(src).not.toMatch(/from\(\s*["']product_identifiers["']/);
  });

  it("refuses to link without a supplier", () => {
    expect(src).toMatch(/Choose the supplier before linking their code\./);
  });

  it("reads discovery only through the discovery RPC", () => {
    expect(src).toMatch(/discover_supplier_identity/);
    expect(src).not.toMatch(/from\(\s*["'](purchase_order_items|vendor_pricelists)["']/);
  });
});
