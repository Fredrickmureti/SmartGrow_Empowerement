/**
 * Stage R1.6 — Test Print synthetic-branch contract.
 *
 * The `pos_receipt_preview` document type MUST be:
 *   1) recognized and short-circuited in generate-document/index.ts BEFORE
 *      any fetcher dispatch runs (so it can never reach pos_transactions).
 *   2) absent from FETCHER_MAP / TABLE_MAP (so a typo can't silently route
 *      a real-id request through it).
 *   3) the only place that handles the synthetic id "test-print" — UUID-
 *      shaped ids must be rejected with a 400.
 *
 * These are static guards: no Deno runtime needed, no live edge-fn call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fnPath = resolve(
  process.cwd(),
  "supabase/functions/generate-document/index.ts",
);
const src = readFileSync(fnPath, "utf8");

describe("Stage R1.6 — Test Print server contract", () => {
  it("recognizes pos_receipt_preview in the handler", () => {
    expect(src).toMatch(/documentType === ["']pos_receipt_preview["']/);
  });

  it("does NOT register pos_receipt_preview in FETCHER_MAP", () => {
    const fetcherMapMatch = src.match(/FETCHER_MAP[\s\S]*?\}\s*;/);
    expect(fetcherMapMatch, "FETCHER_MAP block").toBeTruthy();
    expect(fetcherMapMatch![0]).not.toContain("pos_receipt_preview");
  });

  it("does NOT register pos_receipt_preview in TABLE_MAP", () => {
    const tableMapMatch = src.match(/TABLE_MAP[\s\S]*?\}\s*;/);
    expect(tableMapMatch, "TABLE_MAP block").toBeTruthy();
    expect(tableMapMatch![0]).not.toContain("pos_receipt_preview");
  });

  it("rejects UUID-shaped documentIds in the preview branch", () => {
    // The branch must contain a UUID regex and a 400 response, ensuring a
    // real transaction id can never be routed through the synthetic path.
    expect(src).toMatch(/UUID_RE\s*=\s*\/\^?\[0-9a-f\]\{8\}/);
    expect(src).toMatch(
      /pos_receipt_preview cannot reference a real transaction id/,
    );
  });

  it("forces format=escpos for the preview branch", () => {
    expect(src).toMatch(/pos_receipt_preview only supports format=escpos/);
  });

  it("uses the canonical Line[] renderer (no parallel renderer)", () => {
    // The preview branch must reuse the canonical row producer so what test
    // print produces is byte-equivalent to a real sale rendered with the same
    // settings — no shadow renderer, no divergence.
    const previewBlock = src.match(
      /pos_receipt_preview[\s\S]{0,8000}renderDocumentEscPosWithResult/,
    );
    expect(previewBlock, "canonical renderer call inside preview branch").toBeTruthy();
  });
});
