/**
 * Source-inspection guard for the four dispatch artifacts (ADR 0110).
 *
 * Locks the three properties that have regressed elsewhere in the
 * printing platform:
 *
 * 1. Every dispatch document type is registered in `FETCHER_MAP` and
 *    `TEMPLATE_TYPE_MAP`, so `generate-document` can resolve it.
 * 2. Dispatch REQUESTS documents through `printDocument` (ADR-0086);
 *    no page calls a render endpoint or chooses a transport.
 * 3. `fetchCarrierLabel` never allocates a tracking number — the label
 *    prints what `wms_allocate_tracking_number` already committed, so a
 *    label can never disagree with the manifest.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const EDGE = read("supabase/functions/generate-document/index.ts");
const MENU = read("src/features/warehouse/dispatch/DispatchDocumentsMenu.tsx");
const BAY = read("src/pages/warehouse/LoadingBay.tsx");
const MATRIX = read("docs/printing-event-coverage.md");

const TYPES = [
  ["bill_of_lading", "fetchBillOfLading"],
  ["dispatch_manifest", "fetchDispatchManifest"],
  ["packing_list", "fetchPackingList"],
  ["carrier_label", "fetchCarrierLabel"],
] as const;

describe("dispatch document registration", () => {
  for (const [type, fetcher] of TYPES) {
    it(`${type} is wired to ${fetcher}`, () => {
      expect(EDGE).toContain(`async function ${fetcher}(`);
      expect(EDGE).toMatch(new RegExp(`${type}:\\s*${fetcher},`));
      expect(EDGE).toMatch(new RegExp(`${type}:\\s*"invoice",`));
      expect(MATRIX).toContain(`\`${type}\``);
    });
  }

  it("the menu dispatches through printDocument, never a render endpoint", () => {
    expect(MENU).toContain('from "@/services/printing/PrintService"');
    expect(MENU).toContain("printDocument(");
    expect(MENU).not.toMatch(/functions\.invoke\(\s*["'`]generate-document/);
    expect(BAY).toContain("DispatchDocumentsMenu");
  });

  it("the carrier label prints an allocated tracking number, never mints one", () => {
    const start = EDGE.indexOf("async function fetchCarrierLabel(");
    const body = EDGE.slice(start, start + 1500);
    expect(body).toContain("manifest.tracking_number");
    expect(body).not.toContain("wms_allocate_tracking_number");
  });

  it("tracking allocation is RPC-only — no client writes tracking columns", () => {
    expect(BAY).not.toMatch(/from\(["'`]wms_loading_manifests["'`]\)[\s\S]{0,80}\.update\(/);
    expect(BAY).toContain("useAllocateTrackingNumber");
  });
});
