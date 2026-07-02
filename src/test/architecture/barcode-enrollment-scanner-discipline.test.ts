/**
 * Architecture guard — Barcode Enrollment Workspace must never bypass
 * `scanRouter` by subscribing to `scanBus` directly. Scans flow through
 * the single top-priority `useScanTarget` registered by the page; a raw
 * `scanBus.on(...)` in this file would race POS consumers and break the
 * focus-aware contract (ADR 0013).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const PAGE = path.resolve(__dirname, "../../pages/inventory/BarcodeEnrollment.tsx");
const REDUCER = path.resolve(__dirname, "../../hooks/inventory/useEnrollmentWorkflow.ts");

describe("barcode enrollment scanner discipline", () => {
  it("page does not import scanBus directly", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).not.toMatch(/from\s+["']@\/services\/pos\/scanBus["']/);
    expect(src).not.toMatch(/scanBus\.on\s*\(/);
  });

  it("reducer does not import scanBus directly", () => {
    const src = readFileSync(REDUCER, "utf8");
    expect(src).not.toMatch(/from\s+["']@\/services\/pos\/scanBus["']/);
    expect(src).not.toMatch(/scanBus\.on\s*\(/);
  });
});
