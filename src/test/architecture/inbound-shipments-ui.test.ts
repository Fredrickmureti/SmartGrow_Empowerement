/**
 * Phase D.3 architecture guard — Inbound Shipments (ASN) UI surface.
 *
 * The ASN backend (`createAsnBatchImportHandler`, `inbound_shipments`,
 * `inbound_shipment_items`) was complete for turns before any operator
 * could see it. This guard pins the user-facing pieces so the pipeline
 * cannot silently regress to headless again:
 *
 *   1. List and detail pages exist and read the right tables.
 *   2. The list wires the CSV import to the existing
 *      `createAsnBatchImportHandler` + `ASN_IMPORT_FIELDS` — no parallel
 *      import machinery.
 *   3. The detail page's "Start Goods Receipt" action hits the GRN
 *      wizard URL contract (`?po=<id>`) already pinned by the
 *      `grn-asn-prefill` guard.
 *   4. The inventory router and nav both expose the surface.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8");

describe("Phase D.3 — InboundShipments list page", () => {
  const src = read("src/pages/inventory/InboundShipments.tsx");

  it("reads from inbound_shipments scoped by organization + business", () => {
    expect(src).toMatch(/from\("inbound_shipments"\)/);
    expect(src).toMatch(/\.eq\("organization_id"/);
    expect(src).toMatch(/\.eq\("business_id"/);
  });

  it("imports the ASN batch import handler + fields (no parallel machinery)", () => {
    expect(src).toMatch(/createAsnBatchImportHandler/);
    expect(src).toMatch(/ASN_IMPORT_FIELDS/);
    expect(src).toMatch(/from\s+["']@\/lib\/importConfigs["']/);
  });

  it("mounts <ImportWizard/> and wires it to onBatchImport", () => {
    expect(src).toMatch(/<ImportWizard[\s\S]*?onBatchImport=/);
  });

  it("exposes an Import ASN entry point", () => {
    expect(src).toMatch(/Import ASN/);
  });
});

describe("Phase D.3 — InboundShipmentDetail page", () => {
  const src = read("src/pages/inventory/InboundShipmentDetail.tsx");

  it("reads the shipment header + items in one round-trip", () => {
    expect(src).toMatch(/from\("inbound_shipments"\)/);
    expect(src).toMatch(/inbound_shipment_items/);
  });

  it("launches the GRN wizard with the ?po= contract pinned by grn-asn-prefill", () => {
    expect(src).toMatch(/\/purchases\/goods-receipt\/new\?po=\$\{[^}]+\}/);
  });

  it("gates Start Goods Receipt behind a linked PO in an active status", () => {
    expect(src).toMatch(/purchase_order_id/);
    expect(src).toMatch(/received|cancelled/);
  });
});

describe("Phase D.3 — inventory router exposes inbound-shipments", () => {
  const src = read("src/apps/inventory/routes.tsx");

  it("lazy-imports both pages", () => {
    expect(src).toMatch(/InboundShipments\s*=\s*lazy\(/);
    expect(src).toMatch(/InboundShipmentDetail\s*=\s*lazy\(/);
  });

  it("registers list + detail routes under inbound-shipments", () => {
    expect(src).toMatch(/path="inbound-shipments"/);
    expect(src).toMatch(/path="inbound-shipments\/:id"/);
  });
});

describe("Phase D.3 — inventory nav surfaces Inbound (ASN)", () => {
  const src = read("src/apps/inventory/nav.ts");

  it("has a nav entry pointing at /inventory-app/inbound-shipments", () => {
    expect(src).toMatch(/inbound-shipments/);
  });
});
