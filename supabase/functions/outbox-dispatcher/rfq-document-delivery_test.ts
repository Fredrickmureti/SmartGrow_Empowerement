import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("RFQ invitation freezes a supplier-addressed revision before email", () => {
  assertStringIncludes(source, '"rfq_ensure_document_record"');
  assertStringIncludes(source, "_supplier_id: inv.supplier_id");
  assertStringIncludes(source, "documentRecordId,");
  assertStringIncludes(source, "freeze RFQ invitation artifact");
});