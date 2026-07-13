/**
 * Regression tests for the certificate editor surface's country-agnostic
 * invariant and the v3 → v4 validator refactor.
 *
 * Guards:
 *   - The publisher editor + grid designer contain NO country/statute
 *     tokens. All jurisdiction knowledge belongs to localization packs.
 *   - `validateV3Body` accepts v4-only documents (label_fill identity,
 *     signature caption, grid table) without false-negatively demanding
 *     legacy `identity_strip` / `matrix` / `signature_strip` nodes.
 *   - `compile()` emits `data-ce-node` markers so the editor's WYSIWYG
 *     canvas can attribute clicks back to the AST.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateV3Body } from "../../features/localization/components/CertificateV3Editor";
import { compile } from "../../features/localization/lib/engine/compile";
import { GENERIC_EXAMPLE_TEMPLATE } from "../../features/localization/lib/engine/templates/genericExample";

const FORBIDDEN = [
  "paye", "nhif", "shif", "nssf", "housing_levy", "ahl", "nita",
  "kra", " p9", "p9.", "irp5", "w-2", "w2", "p60", "sdl", "kenya",
];

describe("certificate editor — country-agnostic invariant", () => {
  it("editor + grid designer + generic example contain no country tokens", () => {
    const files = [
      "src/features/localization/components/CertificateV3Editor.tsx",
      "src/features/localization/components/GridDesigner.tsx",
      "src/features/localization/lib/engine/templates/genericExample.ts",
    ];
    const src = files.map((f) => readFileSync(resolve(__dirname, "../../../", f), "utf8")).join("\n").toLowerCase();
    for (const t of FORBIDDEN) {
      expect(src.includes(t), `country token "${t}" leaked into editor source`).toBe(false);
    }
  });
});

describe("validateV3Body — v4-only templates", () => {
  it("accepts a document with label_fill identity + grid + signature caption", () => {
    // Uses the country-agnostic example template. It has employer+employee
    // bindings, a grid, and a signature_strip — the three semantic roles.
    const v = validateV3Body(GENERIC_EXAMPLE_TEMPLATE as any, []);
    expect(v.ok, `unexpected missing: ${v.missing.join(", ")}`).toBe(true);
  });

  it("accepts a v4 document that uses a bare 'Signature' caption without signature_strip", () => {
    const body = {
      schema_version: 4,
      paper_format: { size: "A4", orientation: "portrait", margin_top: 10, margin_right: 10, margin_bottom: 10, margin_left: 10, header_height: 10, footer_height: 10 },
      document: [
        { type: "field_row", gap_mm: 6, fields: [
          { type: "label_fill", label: { kind: "literal", value: "Employer" }, value: { kind: "binding", path: "employer.name" } },
          { type: "label_fill", label: { kind: "literal", value: "Employee" }, value: { kind: "binding", path: "employee.full_name" } },
        ] },
        { type: "grid", columns: [], header_rows: [], data_rows: { bind: "rows.items" }, footer_rows: [] },
        { type: "rich_text", paragraphs: [[{ text: { kind: "literal", value: "Signature: ____________________" } }]] },
      ],
    };
    const v = validateV3Body(body as any, []);
    expect(v.ok, `unexpected missing: ${v.missing.join(", ")}`).toBe(true);
  });

  it("rejects a document with no table or no identity block", () => {
    const noTable = { schema_version: 4, paper_format: { size: "A4", orientation: "portrait", margin_top: 10, margin_right: 10, margin_bottom: 10, margin_left: 10, header_height: 10, footer_height: 10 }, document: [{ type: "signature_strip", slots: [] }] };
    expect(validateV3Body(noTable as any, []).ok).toBe(false);
  });
});

describe("compile() — WYSIWYG hooks", () => {
  it("emits data-ce-node markers on every top-level document node", () => {
    const { html } = compile(GENERIC_EXAMPLE_TEMPLATE, { employer: { name: "X" }, employee: { full_name: "Y" }, rows: { items: [] } } as any, {});
    expect(html).toContain('data-ce-node="doc.0"');
    expect(html).toContain('data-ce-node="doc.1"');
    expect(html).toContain('data-ce-type="heading"');
    expect(html).toContain('data-ce-node="hdr.0"');
    expect(html).toContain('data-ce-node="ftr.0"');
  });
});
