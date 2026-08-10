import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertRfqTemplateContract } from "../_shared/rendering/renderers/pdf.ts";
import { assertSolicitationSnapshot } from "../_shared/pdf/layouts/procurement.ts";
import type { AstBlock, ResolvedTemplate } from "../_shared/rendering/types.ts";

const template = {
  id: "rfq-template",
  kind_code: "purchases.rfq",
  scope: "system",
  version: 2,
  label: "RFQ",
  ast: { version: 2, kind: "purchases.rfq", media_class: "a4", layout: "solicitation", blocks: [] },
  theme_id: null,
  header_id: null,
  footer_id: null,
  media_class: "a4",
} as unknown as ResolvedTemplate;

Deno.test("RFQ template accepts solicitation requirements blocks", () => {
  const blocks = [
    { type: "party", role: "invited_supplier" },
    { type: "table", preset: "requirements" },
  ] as AstBlock[];
  assertEquals(assertRfqTemplateContract(template, blocks), undefined);
});

Deno.test("RFQ template rejects invoice semantics", () => {
  assertThrows(
    () => assertRfqTemplateContract(template, [{ type: "party", role: "billTo" }] as AstBlock[]),
    Error,
    "forbidden party role",
  );
  assertThrows(
    () => assertRfqTemplateContract(template, [{ type: "table", preset: "line_items" }] as AstBlock[]),
    Error,
    "forbidden table preset",
  );
  assertThrows(
    () => assertRfqTemplateContract(template, [{ type: "totals" }] as AstBlock[]),
    Error,
    "forbidden block totals",
  );
});

Deno.test("RFQ snapshot rejects monetary fields at every level", () => {
  assertThrows(
    () => assertSolicitationSnapshot({ document_type: "rfq", total: 0 }),
    Error,
    "forbidden monetary field total",
  );
  assertThrows(
    () => assertSolicitationSnapshot({ document_type: "rfq", items: [{ target_price: 100 }] }),
    Error,
    "forbidden item monetary field target_price",
  );
});

Deno.test("RFQ renderer rejects non-finite quantities", async () => {
  const { generateSolicitationPdf } = await import("../_shared/pdf/layouts/procurement.ts");
  await assertRejects(
    () => generateSolicitationPdf({
      document_type: "rfq",
      document_number: "RFQ-TEST",
      items: [{ description: "Item", quantity: "NaN" }],
    }, null),
    Error,
    "procurement_numeric_invalid",
  );
});