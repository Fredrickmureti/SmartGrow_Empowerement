/**
 * Legal-recipient statement — branding & currency contract.
 *
 * A recipient statement is computed live; unlike `customer_statement` there is
 * no persisted row carrying `business_id`. The paying business must therefore
 * arrive on the request body (or be inferred when the org owns exactly one),
 * because it is what resolves BOTH the letterhead branding and the statement
 * currency. When it is missing the fetcher silently emits an unbranded USD
 * document — which is the bug this guard exists to prevent regressing.
 */

import { assert, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const page = await Deno.readTextFile(
  new URL("../../../src/pages/hr/payroll/LegalRecipients.tsx", import.meta.url),
);
const totalsBlock = await Deno.readTextFile(
  new URL("../_shared/pdf/components/TotalsBlock.ts", import.meta.url),
);

Deno.test("the Recipients page forwards the active business to both print paths", () => {
  assertStringIncludes(page, "useBusinesses");
  const matches = page.match(
    /periodStart: from, periodEnd: to, businessId: currentBusiness\?\.id/g,
  );
  assert(
    matches !== null && matches.length === 2,
    `expected businessId on both downloadPdf and printDocument bodies, found ${matches?.length ?? 0}`,
  );
});

Deno.test("the edge function forwards businessId from the request body", () => {
  assertStringIncludes(
    source,
    `businessId: typeof body.businessId === "string" ? body.businessId : null`,
  );
});

Deno.test("the fetcher falls back to the org's sole business when businessId is omitted", () => {
  const start = source.indexOf("async function fetchLegalRecipientStatement");
  const end = source.indexOf("// ── Bill (Vendor Bill) fetcher", start);
  assert(start > 0 && end > start, "fetchLegalRecipientStatement not found");
  const fn = source.slice(start, end);

  assertStringIncludes(fn, `.eq("organization_id", recipient.organization_id)`);
  assertStringIncludes(fn, "bizRows.length === 1");
  // Currency must still prefer the business over the org, then USD last.
  assertStringIncludes(fn, "business?.base_currency");
  assertStringIncludes(fn, "recipient.organization?.base_currency");
});

Deno.test("TotalsBlock reserves clearance so its rule never strikes the row above", () => {
  assertStringIncludes(totalsBlock, "const leadGap = lines.length === 0 ? lineHeight : 0;");
  assertStringIncludes(totalsBlock, "builder.y -= leadGap;");
});
