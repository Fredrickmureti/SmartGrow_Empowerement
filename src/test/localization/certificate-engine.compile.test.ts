/**
 * Certificate Engine — compiler unit tests.
 *
 * Guards the country-agnostic invariants:
 *   - deterministic output (same input → same HTML/CSS)
 *   - bindings resolve, unresolved paths surface for diagnostics
 *   - v3 MatrixNode still renders rows + summed footer (backward compat)
 *   - v4 GridNode renders cell-level header stack + summed footer_rows
 *   - v4 LabelFillNode + ListNode + ColumnsNode render as expected
 *   - no country tokens leak into the compiler source
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const enginePath = resolve(__dirname, "../../../supabase/functions/_shared/certificate-engine/compile.ts");
const typesPath  = resolve(__dirname, "../../../supabase/functions/_shared/certificate-engine/types.ts");

describe("certificate-engine compile.ts", () => {
  it("source file exists and exports compile()", () => {
    const src = readFileSync(enginePath, "utf8");
    expect(src).toMatch(/export function compile\(/);
  });

  it("contains no country tokens (renderer must be country-agnostic)", () => {
    const src = readFileSync(enginePath, "utf8") + readFileSync(typesPath, "utf8");
    const forbidden = [
      "paye", "nhif", "shif", "nssf", "housing_levy", "ahl", "nita",
      "kra", "p9", "irp5", "w-2", "w2", "p60", "sdl",
    ];
    const lower = src.toLowerCase();
    for (const t of forbidden) {
      expect(lower.includes(t), `country token "${t}" leaked into engine source`).toBe(false);
    }
  });

  it("emits theme CSS custom properties, not hardcoded aesthetics", () => {
    const src = readFileSync(enginePath, "utf8");
    // The theme system must expose these variables so packs can override
    // the presentation. Hardcoded hex colours in the CSS block would be
    // an aesthetic policy the engine must not ship.
    expect(src).toMatch(/--ce-rule/);
    expect(src).toMatch(/--ce-head-shade/);
    expect(src).toMatch(/--ce-grid-size/);
  });
});

describe("certificate-engine compile() — v3 backward compat", () => {
  it("resolves bindings and records unresolved paths", async () => {
    const { compile } = await import(
      "../../../supabase/functions/_shared/certificate-engine/compile.ts"
    );
    const out = compile(
      {
        schema_version: 3,
        code: "TEST",
        display_name: "Test Certificate",
        paper_format: {
          size: "A4", orientation: "portrait",
          margin_top: 12, margin_right: 12, margin_bottom: 12, margin_left: 12,
          header_height: 10, footer_height: 10,
        },
        document: [
          { type: "heading", level: 1, text: { kind: "literal", value: "Certificate" } },
          { type: "key_value",
            label: { kind: "literal", value: "Name" },
            value: { kind: "binding", path: "employee.name" } },
          { type: "key_value",
            label: { kind: "literal", value: "Missing" },
            value: { kind: "binding", path: "employee.absent", fallback: "—" } },
        ],
      },
      { employee: { name: "Alice" } },
      {},
    );
    expect(out.html).toContain("Alice");
    expect(out.html).toContain("—");
    expect(out.unresolved).toContain("employee.absent");
    expect(out.unresolved).not.toContain("employee.name");
  });

  it("is deterministic", async () => {
    const { compile } = await import(
      "../../../supabase/functions/_shared/certificate-engine/compile.ts"
    );
    const tpl = {
      schema_version: 3 as const,
      code: "TEST",
      display_name: "T",
      paper_format: {
        size: "A4" as const, orientation: "portrait" as const,
        margin_top: 10, margin_right: 10, margin_bottom: 10, margin_left: 10,
        header_height: 8, footer_height: 8,
      },
      document: [
        { type: "heading" as const, level: 2 as const,
          text: { kind: "literal" as const, value: "Hello" } },
      ],
    };
    const a = compile(tpl, {}, {});
    const b = compile(tpl, {}, {});
    expect(a.html).toBe(b.html);
    expect(a.css).toBe(b.css);
  });

  it("renders a v3 matrix with a summed footer", async () => {
    const { compile } = await import(
      "../../../supabase/functions/_shared/certificate-engine/compile.ts"
    );
    const out = compile(
      {
        schema_version: 3,
        code: "M",
        display_name: "M",
        paper_format: {
          size: "A4", orientation: "landscape",
          margin_top: 10, margin_right: 10, margin_bottom: 10, margin_left: 10,
          header_height: 8, footer_height: 8,
        },
        document: [
          {
            type: "matrix",
            rows_binding: "months",
            columns: [
              { key: "month", header: { kind: "literal", value: "Month" }, format: "month_short" },
              { key: "gross", header: { kind: "literal", value: "Gross" }, align: "right", format: "number" },
            ],
            footer: { label: { kind: "literal", value: "Total" }, sum_columns: ["gross"] },
            repeat_header: true,
          },
        ],
      },
      { months: [{ month: 1, gross: 100 }, { month: 2, gross: 250 }] },
      {},
    );
    expect(out.html).toContain("<table");
    expect(out.html).toContain("Jan");
    expect(out.html).toContain("Feb");
    expect(out.html).toContain("350.00");
    expect(out.html).toContain("Total");
  });

  it("renders Annual Earnings monthly columns from DTO.months, not derived formulas", async () => {
    const { compile } = await import(
      "../../../supabase/functions/_shared/certificate-engine/compile.ts"
    );
    const out = compile(
      {
        schema_version: 3,
        code: "ANNUAL_EARNINGS_STATEMENT",
        display_name: "Annual Earnings Statement",
        paper_format: {
          size: "A4", orientation: "portrait",
          margin_top: 10, margin_right: 10, margin_bottom: 10, margin_left: 10,
          header_height: 8, footer_height: 8,
        },
        document: [
          {
            type: "matrix",
            rows_binding: "months",
            columns: [
              { key: "month", header: { kind: "literal", value: "Month" }, format: "month_short" },
              { key: "taxable", header: { kind: "literal", value: "Taxable" }, align: "right", format: "number" },
              { key: "statutory_employer", header: { kind: "literal", value: "Statutory (ER)" }, align: "right", format: "number" },
            ],
            footer: { label: { kind: "literal", value: "TOTAL" }, sum_columns: ["taxable", "statutory_employer"] },
          },
        ],
      },
      { months: [{ month: 5, month_index: 5, taxable: 84365.06, statutory_employer: 7099.94 }] },
      {},
    );

    expect(out.html).toContain("May");
    expect(out.html).toContain("84,365.06");
    expect(out.html).toContain("7,099.94");
  });
});

describe("certificate-engine compile() — v4 primitives", () => {
  it("renders a grid with a cell-level header stack and summed footer_rows", async () => {
    const { compile } = await import(
      "../../../supabase/functions/_shared/certificate-engine/compile.ts"
    );
    const out = compile(
      {
        schema_version: 4,
        code: "G",
        display_name: "G",
        paper_format: {
          size: "A4", orientation: "landscape",
          margin_top: 10, margin_right: 10, margin_bottom: 10, margin_left: 10,
          header_height: 8, footer_height: 8,
        },
        document: [
          {
            type: "grid",
            columns: [
              { id: "month", align: "left",  format: "month_short" },
              { id: "e1",    align: "right", format: "number" },
              { id: "e2",    align: "right", format: "number" },
              { id: "e3",    align: "right", format: "number" },
            ],
            header_rows: [
              [
                { content: { kind: "literal", value: "Month" }, row_span: 2, variant: "label" },
                { content: { kind: "literal", value: "Retirement" }, span: 3, variant: "label" },
              ],
              [
                { content: { kind: "literal", value: "E1" }, variant: "letter" },
                { content: { kind: "literal", value: "E2" }, variant: "letter" },
                { content: { kind: "literal", value: "E3" }, variant: "letter" },
              ],
            ],
            data_rows: { bind: "rows" },
            footer_rows: [[
              { content: { kind: "literal", value: "TOTAL" }, variant: "total" },
              { content: { kind: "sum_of", column_id: "e1" }, variant: "total" },
              { content: { kind: "sum_of", column_id: "e2" }, variant: "total" },
              { content: { kind: "sum_of", column_id: "e3" }, variant: "total" },
            ]],
          } as any,
        ],
      },
      { rows: [
        { month: 1, e1: 100, e2: 200, e3: 300 },
        { month: 2, e1: 150, e2: 250, e3: 350 },
      ]},
      {},
    );
    // Header colspan present
    expect(out.html).toMatch(/colspan="3"/);
    // Header rowspan present
    expect(out.html).toMatch(/rowspan="2"/);
    // Cell letter markers
    expect(out.html).toContain(">E1<");
    expect(out.html).toContain(">E2<");
    expect(out.html).toContain(">E3<");
    // Body values rendered
    expect(out.html).toContain("Jan");
    expect(out.html).toContain("Feb");
    // sum_of computed: E1 = 100+150 = 250, E2 = 450, E3 = 650
    expect(out.html).toContain("250.00");
    expect(out.html).toContain("450.00");
    expect(out.html).toContain("650.00");
    expect(out.html).toContain("TOTAL");
  });

  it("renders label_fill with dotted rule and field_row grid", async () => {
    const { compile } = await import(
      "../../../supabase/functions/_shared/certificate-engine/compile.ts"
    );
    const out = compile(
      {
        schema_version: 4,
        code: "F",
        display_name: "F",
        paper_format: {
          size: "A4", orientation: "portrait",
          margin_top: 10, margin_right: 10, margin_bottom: 10, margin_left: 10,
          header_height: 8, footer_height: 8,
        },
        document: [
          {
            type: "field_row",
            gap_mm: 6,
            columns: ["1fr", "1fr"],
            fields: [
              { type: "label_fill", label: { kind: "literal", value: "Employer's Name" },
                value: { kind: "binding", path: "employer.name" }, rule: "dotted" },
              { type: "label_fill", label: { kind: "literal", value: "Employer's PIN" },
                value: { kind: "binding", path: "employer.tax_pin" }, rule: "dotted" },
            ],
          } as any,
        ],
      },
      { employer: { name: "Acme Ltd", tax_pin: "P051234567X" } },
      {},
    );
    expect(out.html).toContain("Employer&#39;s Name");
    expect(out.html).toContain("Acme Ltd");
    expect(out.html).toContain("P051234567X");
    expect(out.html).toContain("ce-fill-rule-dotted");
    expect(out.html).toContain("ce-field-row");
  });

  it("renders nested list with different markers", async () => {
    const { compile } = await import(
      "../../../supabase/functions/_shared/certificate-engine/compile.ts"
    );
    const out = compile(
      {
        schema_version: 4,
        code: "L",
        display_name: "L",
        paper_format: {
          size: "A4", orientation: "portrait",
          margin_top: 10, margin_right: 10, margin_bottom: 10, margin_left: 10,
          header_height: 8, footer_height: 8,
        },
        document: [
          {
            type: "list",
            marker: "decimal",
            items: [
              {
                text: { kind: "literal", value: "First" },
                children: {
                  type: "list",
                  marker: "lower-alpha-paren",
                  items: [
                    { text: { kind: "literal", value: "sub-a" } },
                    { text: { kind: "literal", value: "sub-b" } },
                  ],
                },
              },
            ],
          } as any,
        ],
      },
      {},
      {},
    );
    expect(out.html).toContain("ce-marker-decimal");
    expect(out.html).toContain("ce-marker-lower-alpha-paren");
    expect(out.html).toContain("First");
    expect(out.html).toContain("sub-a");
    expect(out.html).toContain("sub-b");
  });

  it("renders a two-column region with column_children", async () => {
    const { compile } = await import(
      "../../../supabase/functions/_shared/certificate-engine/compile.ts"
    );
    const out = compile(
      {
        schema_version: 4,
        code: "C",
        display_name: "C",
        paper_format: {
          size: "A4", orientation: "portrait",
          margin_top: 10, margin_right: 10, margin_bottom: 10, margin_left: 10,
          header_height: 8, footer_height: 8,
        },
        document: [
          {
            type: "columns",
            count: 2,
            gap_mm: 8,
            column_children: [
              [{ type: "rich_text", paragraphs: [[{ text: { kind: "literal", value: "left column" } }]] }],
              [{ type: "rich_text", paragraphs: [[{ text: { kind: "literal", value: "right column" } }]] }],
            ],
          } as any,
        ],
      },
      {},
      {},
    );
    expect(out.html).toContain("ce-columns");
    expect(out.html).toContain("left column");
    expect(out.html).toContain("right column");
    // Grid template columns applied inline
    expect(out.html).toMatch(/grid-template-columns:\s*repeat\(2/);
  });

  it("theme overrides propagate into emitted CSS custom properties", async () => {
    const { compile } = await import(
      "../../../supabase/functions/_shared/certificate-engine/compile.ts"
    );
    const out = compile(
      {
        schema_version: 4,
        code: "T",
        display_name: "T",
        paper_format: {
          size: "A4", orientation: "portrait",
          margin_top: 10, margin_right: 10, margin_bottom: 10, margin_left: 10,
          header_height: 8, footer_height: 8,
        },
        theme: {
          body_font: '"Times New Roman", serif',
          rule_color: "#000",
          rule_weight_pt: 0.75,
          header_shade: "none",
          zebra: "none",
        },
        document: [
          { type: "heading", level: 1, text: { kind: "literal", value: "Hi" } },
        ],
      },
      {},
      {},
    );
    expect(out.css).toContain('--ce-body-font: "Times New Roman", serif');
    expect(out.css).toContain("--ce-rule: #000");
    expect(out.css).toContain("--ce-rule-w: 0.75pt");
    expect(out.css).toContain("--ce-head-shade: transparent");
  });
});
