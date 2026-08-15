/**
 * Architecture guard — WMS capture surfaces are NOT authoritative for
 * unit-of-measure conversion (Warehouse Product/Inventory Consumer Audit,
 * Phase 1).
 *
 * The browser may PREVIEW a base-unit figure for the operator, but the
 * quantity it sends must be the number the operator typed, together with the
 * `product_packaging` level. `wms_to_base_qty()` — reading the canonical
 * Product foundation — performs the multiplication server-side.
 *
 * Regression this pins: a handheld with a stale packaging factor (or an
 * offline replay captured before a packaging edit) silently booking the wrong
 * base quantity into `stock_movements`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const CAPTURE_SURFACES = [
  "src/pages/warehouse-mobile/MobileReceiveSession.tsx",
  "src/pages/warehouse-mobile/MobileCount.tsx",
  "src/pages/warehouse-mobile/MobileReturns.tsx",
] as const;

/** The RPC arg block for a given rpc name inside a source file. */
function rpcArgs(src: string, rpc: string): string {
  const start = src.indexOf(`"${rpc}"`);
  if (start < 0) return "";
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

describe("WMS capture surfaces delegate UoM conversion to the server", () => {
  it.each([
    ["src/pages/warehouse-mobile/MobileReceiveSession.tsx", "wms_capture_receiving_line"],
    ["src/pages/warehouse-mobile/MobileCount.tsx", "record_count"],
    ["src/pages/warehouse-mobile/MobileReturns.tsx", "wms_capture_return_line"],
  ])("%s sends packaging + entered qty to %s", (file, rpc) => {
    const args = rpcArgs(read(file), rpc);
    expect(args, `${rpc} call not found in ${file}`).not.toBe("");
    expect(args).toContain("p_packaging_id");
    expect(args).toContain("p_entered_qty");
  });

  it.each(CAPTURE_SURFACES)("%s never sends a client-converted quantity", (file) => {
    const src = read(file);
    for (const rpc of ["wms_capture_receiving_line", "record_count", "wms_capture_return_line"]) {
      const args = rpcArgs(src, rpc);
      // `toBaseUnits(...)` is a display preview only — it must not appear
      // inside an RPC argument object, directly or via a `base*` alias.
      expect(args, `${file} → ${rpc} passes a locally converted quantity`).not.toMatch(
        /toBaseUnits\s*\(|\bbase(Qty|Damaged|Preview)\b/,
      );
    }
  });

  it("desktop receiving capture forwards the packaging level, not a converted qty", () => {
    const workspace = read("src/features/warehouse/receiving/ReceivingSessionWorkspace.tsx");
    // The inline capture form hands the packaging id up to `runCapture`.
    expect(workspace).toContain("packagingId: unit.packagingId");
    expect(workspace).toContain("qty: enteredQty");
    // ...which forwards it to the shared mutation.
    expect(workspace).toContain("packagingId: v.packagingId");

    const hook = read("src/features/warehouse/receiving/useReceivingLines.ts");
    const args = rpcArgs(hook, "wms_capture_receiving_line");
    expect(args).toContain("p_packaging_id");
    expect(args).toContain("p_entered_qty");
    expect(args).not.toMatch(/toBaseUnits\s*\(/);
  });

  it("the desktop receiving SCAN path posts the scanned level, not baseUnits", () => {
    // Regression: `receivedQty: baseUnits` shipped the browser's own
    // packaging multiplication into `wms_receiving_lines`. One scan of a level
    // is qty 1 of `identity.packagingId`; the server does the arithmetic.
    const src = read("src/pages/warehouse/ReceivingSessions.tsx");
    const call = src.slice(src.indexOf("captureLine.mutateAsync"));
    const args = call.slice(call.indexOf("{"), call.indexOf("});") + 1);
    expect(args).toContain("packagingId: identity.packagingId");
    expect(args).toContain("receivedQty: 1");
    expect(args, "desktop scan capture passes a client-converted quantity").not.toMatch(
      /receivedQty:\s*baseUnits/,
    );
  });


  it("receivingUnits documents that conversion is server-authoritative", () => {
    const src = read("src/features/warehouse/receiving/receivingUnits.ts");
    expect(src).toContain("wms_to_base_qty");
    expect(src).toMatch(/PREVIEW/);
    // The unit option must carry the packaging id the server needs.
    expect(src).toContain("packagingId");
  });
});

