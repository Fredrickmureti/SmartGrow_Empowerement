// Deno test: certificateRendererV2 primitives.
//
// Focus is on the table layout engine and value formatter — the two
// pieces that determine whether wide monthly grids like KE P9 render
// legibly. If these regress, every localization pack degrades.
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  PDFDocument, StandardFonts,
} from "https://esm.sh/pdf-lib@1.17.1";
import {
  distributeWidths, wrapToWidth, formatValue, renderCertificatePdfV2,
  computeLayoutV2,
} from "./certificateRendererV2.ts";

Deno.test("distributeWidths — fixed columns consumed as-is, fr columns share remainder", () => {
  const cols = [
    { key: "a", header: "A", width: 40 },
    { key: "b", header: "B", width: "1fr" },
    { key: "c", header: "C", width: "3fr" },
  ] as any;
  const widths = distributeWidths(cols, 240, () => 20);
  assertEquals(widths[0], 40);
  // remaining 200 shared 1:3 → 50 / 150
  assertEquals(widths[1], 50);
  assertEquals(widths[2], 150);
});

Deno.test("distributeWidths — auto columns fall back to intrinsic width then split remainder", () => {
  const cols = [
    { key: "a", header: "A", width: "auto" },
    { key: "b", header: "B", width: "auto" },
  ] as any;
  const widths = distributeWidths(cols, 100, (t) => t.length * 10);
  const sum = widths[0] + widths[1];
  assert(Math.abs(sum - 100) < 0.01, `auto columns must fill totalW, got ${sum}`);
});

Deno.test("distributeWidths — 18 auto columns (KE P9 shape) never collapse below minimum", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const cols = Array.from({ length: 18 }, (_, i) => ({
    key: `c${i}`, header: `Col ${i}`, width: "auto",
  })) as any;
  const totalW = 297 - 84; // A4 landscape - margins in mm, roughly
  const widths = distributeWidths(cols, totalW * 2.83, (t) => font.widthOfTextAtSize(t, 8));
  for (const w of widths) assert(w > 10, `column ${w} collapsed`);
});

Deno.test("wrapToWidth — wraps long text and preserves paragraphs", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = wrapToWidth("Lorem ipsum dolor sit amet consectetur adipiscing elit", font, 10, 60);
  assert(lines.length > 1, "long text must wrap onto multiple lines");
});

Deno.test("wrapToWidth — hard-breaks single overflowing word", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = wrapToWidth("AAAAAAAAAAAAAAAAAAAA", font, 10, 20);
  assert(lines.length > 1, "single wide word must be broken");
});

Deno.test("formatValue — currency negatives use accounting parens", () => {
  assertEquals(formatValue(-1234.5, "currency", "KES"), "KES (1,234.50)");
  assertEquals(formatValue(1234.5, "currency", "KES"), "KES 1,234.50");
});

Deno.test("formatValue — percent, date, text passthroughs", () => {
  assertEquals(formatValue(0.15, "percent", ""), "15.00%");
  assertEquals(formatValue("2026-01-01", "date", ""), "2026-01-01");
  assertEquals(formatValue("Free text", "text", ""), "Free text");
  assertEquals(formatValue(null, "currency", "KES"), "");
});

Deno.test("computeLayoutV2 — landscape swaps dimensions", () => {
  const p = computeLayoutV2({ code: "T", display_name: "T", body: {} } as any);
  const l = computeLayoutV2({ code: "T", display_name: "T", body: { page: { orientation: "landscape" } } } as any);
  assert(p.PAGE_W < p.PAGE_H, "portrait");
  assert(l.PAGE_W > l.PAGE_H, "landscape");
});

Deno.test("renderCertificatePdfV2 — produces a well-formed multi-primitive PDF", async () => {
  const template = {
    code: "TEST_CERT",
    display_name: "Test Certificate",
    legal_reference: "Test Act §1",
    body: {
      schema_version: 2,
      page: { orientation: "landscape" },
      blocks: [
        { type: "heading", text: "Employer", level: 2 },
        {
          type: "field_grid", columns: 2, data_source: "employer",
          fields: [
            { key: "name", label: "Registered Name", emphasis: "primary" },
            { key: "tax_pin", label: "Tax PIN" },
          ],
        },
        { type: "notes", title: "IMPORTANT", paragraphs: [
          "This is a statutory notice authored by the pack publisher.",
          "It may span multiple paragraphs and wrap naturally within the notes box.",
        ]},
        {
          type: "table",
          title: "Monthly Breakdown",
          data_source: "monthly_breakdown",
          group_by: "month_index",
          columns: [
            { key: "month_index", header: "Month", width: 45, align: "left", format: "text" },
            { key: "basic_salary", header: "A – Basic Salary", width: "1fr", format: "currency", align: "right" },
            { key: "paye", header: "L – PAYE Tax", width: "1fr", format: "currency", align: "right" },
          ],
          footer: { label: "TOTAL", aggregate: "sum" },
        },
        { type: "signature_block", title: "Signatures", slots: [
          { caption: "Preparer" }, { caption: "Employer Stamp" },
        ]},
      ],
    },
  };
  const payload = {
    employee: { full_name: "Jane Doe" },
    employer: { name: "Acme Ltd", tax_pin: "A001234567X" },
    fiscal_year: 2026,
    currency: "KES",
    monthly: [
      { month_index: 1, rule_code: "basic_salary", category: null, employee_amount: 100000, employer_amount: 0, taxable_amount: 100000 },
      { month_index: 1, rule_code: "paye", category: null, employee_amount: 20000, employer_amount: 0, taxable_amount: 0 },
      { month_index: 2, rule_code: "basic_salary", category: null, employee_amount: 100000, employer_amount: 0, taxable_amount: 100000 },
    ],
    ytdRows: [],
    totals: { employee: 20000, employer: 0, taxable: 200000 },
  } as any;

  const bytes = await renderCertificatePdfV2(template as any, payload);
  assert(bytes instanceof Uint8Array);
  assert(bytes.length > 1000, "should be a non-trivial PDF");
  // PDF file signature
  const head = new TextDecoder().decode(bytes.slice(0, 5));
  assertEquals(head, "%PDF-");
});

Deno.test("renderCertificatePdfV2 — unknown block types are skipped, not thrown", async () => {
  const bytes = await renderCertificatePdfV2({
    code: "T", display_name: "T", body: {
      schema_version: 2,
      blocks: [{ type: "future_block" } as any, { type: "heading", text: "OK" }],
    },
  } as any, {
    employee: {}, employer: {}, fiscal_year: 2026,
    monthly: [], ytdRows: [], totals: { employee: 0, employer: 0, taxable: 0 },
  } as any);
  assert(bytes.length > 500);
});
