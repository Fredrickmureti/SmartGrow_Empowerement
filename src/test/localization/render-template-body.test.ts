/**
 * renderTemplateBody — body-driven generator renderer (Round 6, Step 1).
 *
 * Pins the contract that the certificate generator now relies on:
 *   - empty / missing body ⇒ legacy-fallback signal (`isEmpty: true`),
 *   - block-array body resolves `{{token.path}}` against the supplied ctx,
 *   - blocks group into `beforeTable` (header/body) and `afterTable`
 *     (totals/signature/custom),
 *   - `custom` blocks also seed `footerNote` so tenants can override the
 *     standard footer line,
 *   - unresolved tokens emit the `‹unresolved: token›` sentinel that the
 *     editor preview shows AND surface in `misses` so the generator can
 *     write a `payroll_diagnostics` row.
 *
 * The module under test is the SAME file the Deno edge function imports —
 * `supabase/functions/_shared/renderTemplateBody.ts` — so this suite is
 * the contract that prevents drift between editor and runtime.
 */
import { describe, it, expect } from "vitest";
import {
  renderTemplateBody,
  toSummaryRows,
} from "../../../supabase/functions/_shared/renderTemplateBody";

const ctx = {
  employee: { full_name: "Jane Doe", tax_pin: "A0123456X" },
  fiscal_year: 2025,
  totals: { taxable: 480000 },
};

describe("renderTemplateBody — empty / legacy fallback", () => {
  it("returns isEmpty for null body so generators take the legacy column path", () => {
    const r = renderTemplateBody(null, ctx);
    expect(r.isEmpty).toBe(true);
    expect(r.beforeTable).toEqual([]);
    expect(r.afterTable).toEqual([]);
  });

  it("treats a body with no blocks array and no string content as empty", () => {
    const r = renderTemplateBody({}, ctx);
    expect(r.isEmpty).toBe(true);
  });

  it("collapses object-of-strings legacy bodies into named blocks", () => {
    const r = renderTemplateBody(
      { header: "Hello {{employee.full_name}}", body: "FY {{fiscal_year}}" },
      ctx,
    );
    expect(r.isEmpty).toBe(false);
    expect(r.beforeTable).toHaveLength(2);
    expect(r.beforeTable[0].text).toBe("Hello Jane Doe");
    expect(r.beforeTable[1].text).toBe("FY 2025");
    expect(r.misses).toEqual([]);
  });

  it("treats a single string body as one body block", () => {
    const r = renderTemplateBody("Plain text {{employee.tax_pin}}", ctx);
    expect(r.beforeTable).toHaveLength(1);
    expect(r.beforeTable[0].kind).toBe("body");
    expect(r.beforeTable[0].text).toBe("Plain text A0123456X");
  });
});

describe("renderTemplateBody — block routing", () => {
  it("routes header+body to beforeTable, totals+signature to afterTable", () => {
    const body = {
      blocks: [
        { id: "h", kind: "header", title: "Statement", content: "Annual statement" },
        { id: "b", kind: "body", title: "Body", content: "For {{employee.full_name}}" },
        { id: "t", kind: "totals", title: "Totals", content: "Taxable: {{totals.taxable}}" },
        { id: "s", kind: "signature", title: "Sign", content: "Signed: {{employee.full_name}}" },
      ],
    };
    const r = renderTemplateBody(body, ctx);
    expect(r.beforeTable.map((b) => b.id)).toEqual(["h", "b"]);
    expect(r.afterTable.map((b) => b.id)).toEqual(["t", "s"]);
    expect(r.beforeTable[1].text).toBe("For Jane Doe");
    expect(r.afterTable[0].text).toBe("Taxable: 480000");
  });

  it("seeds footerNote from the last custom block", () => {
    const body = {
      blocks: [
        { id: "f1", kind: "custom", title: "Footer A", content: "First note" },
        { id: "f2", kind: "custom", title: "Footer B", content: "Final note for FY {{fiscal_year}}" },
      ],
    };
    const r = renderTemplateBody(body, ctx);
    expect(r.footerNote).toBe("Final note for FY 2025");
    expect(r.afterTable).toHaveLength(2);
  });

  it("skips blocks whose content is whitespace-only", () => {
    const body = { blocks: [{ kind: "body", content: "   " }, { kind: "body", content: "ok" }] };
    const r = renderTemplateBody(body, ctx);
    expect(r.beforeTable).toHaveLength(1);
    expect(r.beforeTable[0].text).toBe("ok");
  });

  it("normalises unknown kinds to 'custom' (not silently dropped)", () => {
    const r = renderTemplateBody({ blocks: [{ kind: "weird", content: "x" }] }, ctx);
    expect(r.afterTable).toHaveLength(1);
    expect(r.afterTable[0].kind).toBe("custom");
  });
});

describe("renderTemplateBody — unresolved tokens", () => {
  it("emits the sentinel and dedupes misses across blocks", () => {
    const body = {
      blocks: [
        { kind: "header", content: "Hello {{employee.missing_field}}" },
        { kind: "body", content: "Again {{employee.missing_field}} and {{also.gone}}" },
      ],
    };
    const r = renderTemplateBody(body, ctx);
    expect(r.beforeTable[0].text).toBe("Hello ‹unresolved: employee.missing_field›");
    expect(r.beforeTable[1].text).toContain("‹unresolved: also.gone›");
    expect(r.misses).toEqual(["employee.missing_field", "also.gone"]);
  });
});

describe("toSummaryRows", () => {
  it("projects rendered blocks into label/value pairs the PDF generator accepts", () => {
    const rows = toSummaryRows([
      { id: "x", kind: "totals", title: "Taxable", text: "480000" },
      { id: "y", kind: "signature", title: "", text: "Jane" },
    ]);
    expect(rows).toEqual([
      { label: "Taxable", value: "480000" },
      { label: "signature", value: "Jane" },
    ]);
  });

  it("returns [] for empty input so callers can spread unconditionally", () => {
    expect(toSummaryRows([])).toEqual([]);
  });
});
