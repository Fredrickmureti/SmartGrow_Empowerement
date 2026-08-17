/**
 * Cycle count documents — canonical pipeline wiring (ADR 0084 / 0106).
 *
 * The earlier suite asserted against the retired `generate-document`
 * fetchers, which is why "the report could not be printed" survived a green
 * test run: the four count types were never registered with the document
 * model, so `resolveSourceDocumentRecordId` threw
 * `unsupported_document_type` before a renderer was ever reached.
 *
 * This suite guards the path that actually executes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const REGISTRY = read("src/services/documents/resolveSourceDocumentRecord.ts");
const SNAPSHOT = read("src/services/documents/snapshots/wmsCount.ts");
const PDF = read("supabase/functions/_shared/rendering/renderers/pdf.ts");
const LAYOUT = read("supabase/functions/_shared/pdf/layouts/warehouseCount.ts");
const MENU = read("src/features/warehouse/counts/CountDocumentsMenu.tsx");

const TYPES = [
  "count_sheet",
  "count_sheet_blind",
  "count_variance_report",
  "count_audit_report",
] as const;

describe("count documents resolve to document-model records", () => {
  for (const t of TYPES) {
    it(`${t} is registered in resolveSourceDocumentRecord`, () => {
      expect(REGISTRY).toMatch(new RegExp(`\\n  ${t}: \\{`));
      expect(REGISTRY).toContain(`kindCode: "wms.${t}"`);
    });
  }

  it("count documents carry no party and no currency", () => {
    expect(SNAPSHOT).toContain("partyKind: null");
    expect(SNAPSHOT).toContain("currency: null");
  });
});

describe("count documents never reach the commercial (invoice) renderer", () => {
  for (const t of TYPES) {
    it(`wms.${t} has a dedicated PDF layout`, () => {
      expect(PDF).toContain(`"wms.${t}":`);
    });
  }

  it("the warehouse layouts are part of hasDedicatedLayout", () => {
    expect(PDF).toContain("kindCode in WAREHOUSE_LAYOUTS");
  });

  it("the template contract is asserted before render", () => {
    expect(PDF).toContain("assertCountTemplateContract(args.template, args.blocks)");
  });

  it("count templates may not grow invoice anatomy", () => {
    expect(PDF).toContain('const COUNT_FORBIDDEN_BLOCKS = new Set(["party", "totals"])');
  });

  it("count paperwork refuses thermal geometry", () => {
    expect(LAYOUT).toContain("assertSheetPaper");
  });
});

describe("blind sheets cannot leak an expected quantity", () => {
  it("the blind builder is a separate function", () => {
    expect(SNAPSHOT).toContain("export function buildBlindCountSheetSnapshot");
  });

  it("the blind builder never reads a quantity field", () => {
    const start = SNAPSHOT.indexOf("export function buildBlindCountSheetSnapshot");
    const end = SNAPSHOT.indexOf("export function buildCountSheetSnapshot");
    const body = SNAPSHOT.slice(start, end);
    for (const field of ["system_qty", "counted_qty", "variance_qty", "entered_qty"]) {
      expect(body, `blind sheet body references ${field}`).not.toContain(field);
    }
  });

  it("lines are read only through the masking RPC", () => {
    expect(SNAPSHOT).toContain('client.rpc("get_count_lines"');
    expect(SNAPSHOT).not.toContain('from("wms_count_lines"');
  });
});

describe("preview, print and download are distinct verbs", () => {
  it("preview goes through the shared preview surface", () => {
    expect(MENU).toContain("useDocumentPreview");
  });

  it("print goes through the sanctioned print entry point", () => {
    expect(MENU).toContain("printDocument");
  });

  it("download renders the frozen snapshot instead of printing", () => {
    expect(MENU).toContain("downloadExport");
    expect(MENU).toContain('format: "pdf"');
  });
});