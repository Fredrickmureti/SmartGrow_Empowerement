/**
 * Certificate Engine v3 — compiler unit tests.
 *
 * Guards the country-agnostic invariants:
 *   - deterministic output (same input → same HTML/CSS)
 *   - bindings resolve, unresolved paths surface for diagnostics
 *   - matrix renders rows + column-summed footer
 *   - no country tokens leak into the compiler output for a template
 *     that contains none
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// We import the Deno module by its source path — the compile module is
// pure TS with no Deno-specific runtime calls, so vitest can load it.
// The `@ts-nocheck` header keeps the Deno-style URL imports (there are
// none here) from tripping the test runner.
const enginePath = resolve(__dirname, "../../../supabase/functions/_shared/certificate-engine/compile.ts");

// Sanity: file exists and exports compile()
describe("certificate-engine compile.ts", () => {
  it("source file exists and exports compile()", () => {
    const src = readFileSync(enginePath, "utf8");
    expect(src).toMatch(/export function compile\(/);
  });

  it("contains no country tokens", () => {
    const src = readFileSync(enginePath, "utf8");
    const forbidden = [
      "paye", "nhif", "shif", "nssf", "housing_levy", "ahl", "nita",
      "kra", "p9", "irp5", "w-2", "w2", "p60", "sdl",
    ];
    const lower = src.toLowerCase();
    for (const t of forbidden) {
      expect(lower.includes(t), `country token "${t}" leaked into compile.ts`).toBe(false);
    }
  });
});

// Behavioural tests: import the module dynamically so vitest resolves it.
describe("certificate-engine compile() behaviour", () => {
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

  it("renders a matrix with a summed footer", async () => {
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
    // Footer sum 100 + 250 = 350 (formatted number, en-US locale, 2dp).
    expect(out.html).toContain("350.00");
    expect(out.html).toContain("Total");
  });
});
