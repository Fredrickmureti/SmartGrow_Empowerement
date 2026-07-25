/**
 * ADR-0093 Phase 3 — legal-recipient statement document registration.
 *
 * The Payroll → Legal Orders → Recipients statement action calls the shared
 * `generate-document` function with `documentType: "legal_recipient_statement"`.
 * This guard prevents a stale/refactored dispatcher from accepting the UI
 * payload but falling through to the generic "Unsupported document type" 400.
 */

import { assert, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("legal recipient statement is registered as a supported document type", () => {
  assertStringIncludes(source, `legal_recipient_statement: "invoice"`);
  assertStringIncludes(source, `legal_recipient_statement: (async () =>`);
  assertStringIncludes(source, `legal_recipient_statement: "legal_recipients"`);
});

Deno.test("legal recipient statement dispatches through the period-aware fetcher", () => {
  assertStringIncludes(source, "fetchLegalRecipientStatement");
  assertStringIncludes(source, `documentType === "legal_recipient_statement"`);
  assertStringIncludes(source, `periodStart: typeof body.periodStart === "string" ? body.periodStart : undefined`);
  assertStringIncludes(source, `periodEnd: typeof body.periodEnd === "string" ? body.periodEnd : undefined`);
});

Deno.test("legal recipient statement is rendered by the shared statement renderer", () => {
  assertStringIncludes(source, `documentType === 'legal_recipient_statement'`);
  assertStringIncludes(source, "generateStatementPdf");
  const fetcherGate = source.indexOf("const fetcher = FETCHER_MAP[documentType]");
  const dispatch = source.indexOf(`documentType === "legal_recipient_statement"`);
  assert(
    fetcherGate > 0 && dispatch > fetcherGate,
    "legal_recipient_statement must pass the supported-type gate before special-case dispatch",
  );
});
