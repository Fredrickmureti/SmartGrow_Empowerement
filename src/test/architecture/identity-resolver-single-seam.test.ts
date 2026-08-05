/**
 * Architecture guard — Phase C of the product identification plan.
 *
 * Every surface in the repo must resolve product identity ONLY through the
 * canonical client seams:
 *
 *   useResolveProductIdentity / resolveProductIdentityOnce  (identity)
 *   useWmsIdentityGate         (WMS wrapper, adds block-the-line feedback)
 *   useResolveBarcode          (POS, over `pos_resolve_scan`)
 *   useSupplierCodeDiscovery   (supplier-code discovery)
 *
 * They must never hand-roll a `product_identifiers` query nor call an
 * identity RPC by name: those paths skip packaging-level conversion, GS1
 * handling, the tenant gate, the decision envelope and the shared operator
 * copy — exactly the drift this programme removed. The scan is repo-wide on
 * purpose: a hardcoded file list cannot see a NEW bypass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

/** The only module allowed to call each identity RPC by name. */
const RPC_OWNERS: Record<string, string> = {
  resolve_product_identity: "hooks/inventory/useResolveProductIdentity.ts",
  pos_resolve_scan: "hooks/pos/useResolveBarcode.ts",
  discover_supplier_identity: "features/products/identity/useSupplierCodeDiscovery.ts",
  upsert_product_identifier: "features/products/identity/writeIdentifier.ts",
  retire_product_identifier: "features/products/identity/writeIdentifier.ts",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "test") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !full.endsWith("integrations/supabase/types.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Capture surfaces cut over in C2–C5. */
const CUTOVER_FILES = [
  "pages/warehouse/ReceivingSessions.tsx",
  "pages/warehouse/PickList.tsx",
  "pages/inventory/PhysicalCount.tsx",
  "pages/inventory/TransferNew.tsx",
  "features/warehouse/receiving/ReceivingSessionWorkspace.tsx",
];

function read(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf8");
}

describe("Phase C — canonical identity resolver is the only seam", () => {
  it.each(CUTOVER_FILES)("%s does not query product_identifiers directly", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/from\(\s*["']product_identifiers["']\s*\)/);
    expect(src).not.toMatch(/code_norm/);
  });

  it.each(CUTOVER_FILES)("%s no longer uses the POS barcode resolver", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/useResolveBarcode/);
  });

  it.each(CUTOVER_FILES)("%s resolves through the canonical hook", (rel) => {
    const src = read(rel);
    const usesHook =
      /useResolveProductIdentity/.test(src) || /useWmsIdentityGate/.test(src);
    expect(usesHook).toBe(true);
  });

  it("the canonical hook is the only client caller of resolve_product_identity", () => {
    const hook = read("hooks/inventory/useResolveProductIdentity.ts");
    expect(hook).toMatch(/resolve_product_identity/);
    for (const rel of CUTOVER_FILES) {
      // Only comments may mention the RPC — no direct invocation.
      expect(read(rel)).not.toMatch(/rpc\(\s*["']resolve_product_identity["']/);
    }
  });

  it("the WMS gate blocks the line instead of only toasting", () => {
    const gate = read("features/warehouse/scanning/useWmsIdentityGate.ts");
    // Rejections must go through scanFeedbackBus (audio + haptic) and
    // return null so the caller cannot post stock.
    expect(gate).toMatch(/scanFeedbackBus\.emit/);
    expect(gate).toMatch(/return null/);
    expect(gate).not.toMatch(/\btoast\s*\(|\btoast\.(error|success|warning)\s*\(/);
  });
});

describe("Phase 9 — repo-wide: identity RPCs have exactly one caller each", () => {
  const files = walk(SRC);

  it("finds application sources to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(Object.entries(RPC_OWNERS))(
    "only the owning seam calls %s",
    (rpc, owner) => {
      const pattern = new RegExp(`rpc\\(\\s*["']${rpc}["']`);
      const offenders = files
        .filter((f) => pattern.test(readFileSync(f, "utf8")))
        .map((f) => path.relative(SRC, f).replace(/\\/g, "/"));
      expect(offenders).toEqual([owner]);
    },
  );

  it("the dropped legacy identity RPCs are never called again", () => {
    for (const dead of ["pos_resolve_barcode", "resolve_barcode_v2", "enroll_product_barcode"]) {
      const pattern = new RegExp(`rpc\\(\\s*["']${dead}["']`);
      const offenders = files
        .filter((f) => pattern.test(readFileSync(f, "utf8")))
        .map((f) => path.relative(SRC, f).replace(/\\/g, "/"));
      expect({ [dead]: offenders }).toEqual({ [dead]: [] });
    }
  });

  it("supplier context is derived from an inbound document, never operator input", () => {
    // A supplier id widens what a scan may match, so it must come from the
    // receiving session's own document — never from a picker or free text.
    // The seams themselves only forward the value; the rule is about the
    // surfaces that ORIGINATE it.
    const PASS_THROUGH = [
      "features/warehouse/scanning/useWmsIdentityGate.ts",
      "hooks/inventory/useResolveProductIdentity.ts",
    ];
    const callers = files.filter((f) => /supplierId\s*[:=]/.test(readFileSync(f, "utf8")))
      .filter((f) => /useWmsIdentityGate\(|useResolveProductIdentity\(/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f).replace(/\\/g, "/"))
      .filter((rel) => !PASS_THROUGH.includes(rel));
    for (const rel of callers) {
      const src = readFileSync(path.join(SRC, rel), "utf8");
      expect({ file: rel, derived: /useReceivingSessionSupplier/.test(src) }).toEqual({
        file: rel,
        derived: true,
      });
    }
  });
});
