import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("RFQ email accepts an exact immutable document record", () => {
  assertStringIncludes(source, "documentRecordId?: string");
  assertStringIncludes(source, "documentRecordId: documentRecordId ?? null");
});

Deno.test("RFQ email fails closed instead of using legacy renderer", () => {
  assertStringIncludes(source, 'if (documentType === "rfq")');
  assertStringIncludes(source, "legacy rendering is forbidden");
  assertStringIncludes(source, "if (documentType === \"rfq\") throw pdfError");
  assert(!source.includes("Don't fail the whole email - just log and continue without attachment"));
});