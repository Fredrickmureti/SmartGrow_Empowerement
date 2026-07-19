/**
 * Milestone C.1 — architecture guard: confirms `generate-document`
 * registers the CSV export short-circuit and delegates to the shared
 * builder rather than inlining the serialisation. Prevents future
 * refactors from silently re-implementing CSV emission per document
 * type (which would drift from the PDF fetchers and break the
 * "single-renderer / single-fetcher" invariant).
 */
import { assert, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("generate-document accepts format=csv", () => {
  assertStringIncludes(source, `format !== "csv"`);
});

Deno.test("generate-document gates CSV to statement document types", () => {
  assertStringIncludes(source, "CSV_EXPORT_ALLOWED");
  assertStringIncludes(source, `"customer_statement"`);
  assertStringIncludes(source, `"vendor_statement"`);
});

Deno.test("generate-document delegates CSV emission to shared builder", () => {
  assertStringIncludes(source, `../_shared/exports/statementCsv.ts`);
  assertStringIncludes(source, "buildStatementCsv(documentData)");
});

Deno.test("generate-document persists CSV artifacts with render_mode=export", () => {
  assertStringIncludes(source, `renderMode: "export"`);
  assertStringIncludes(source, `export_format: "csv"`);
});

Deno.test("generate-document sets a text/csv content type on CSV responses", () => {
  assertStringIncludes(source, `text/csv; charset=utf-8`);
});

Deno.test("statementCsv module exists and exports buildStatementCsv", async () => {
  const mod = await import("../_shared/exports/statementCsv.ts");
  assert(typeof mod.buildStatementCsv === "function");
});
