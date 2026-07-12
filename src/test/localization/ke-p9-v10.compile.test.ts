/**
 * Kenya P9 v10 — v3 template compile snapshot.
 *
 * Proves the country-agnostic engine AST fully expresses the KRA P9
 * blueprint (17-column landscape matrix with column groups + totals
 * row, employer/employee identity strip, legal notice, signature
 * strip, page master), and that the compiled HTML is deterministic.
 *
 * When this snapshot needs updating, do it deliberately — a diff here
 * means the certificate's rendered structure changed.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../../supabase/functions/_shared/certificate-engine/compile";
import { KE_P9_V10_TEMPLATE } from "./fixtures/ke-p9-v10.template";

const SAMPLE_PAYLOAD = {
  employer: {
    name: "Acme Kenya Ltd",
    tax_pin: "P051234567X",
    tax_office: "Nairobi North",
    address: "P.O. Box 1234-00100 Nairobi",
  },
  employee: {
    full_name: "Jane Wanjiku",
    other_names: "Mwangi",
    tax_pin: "A001234567Y",
    employee_number: "EMP-0042",
  },
  fiscal_year: 2025,
  serial_number: "KE_P9_2025-2025-JANE0042-XYZ",
  generated_at: "2026-01-15 10:00:00",
  totals: {
    chargeable_pay: 1_320_000,
    paye: 264_000,
  },
  p9: {
    months: [
      { month: 1,  col_a: 100000, col_b: 0, col_c: 0, col_d: 100000,
        col_e1: 30000, col_e2: 12000, col_e3: 30000,
        col_f: 1500, col_g: 2750, col_h: 0, col_i: 0,
        col_j: 46250, col_k: 53750,
        col_l: 10750, col_m: 2400, col_n: 0, col_o: 8350 },
      { month: 2,  col_a: 100000, col_b: 0, col_c: 0, col_d: 100000,
        col_e1: 30000, col_e2: 12000, col_e3: 30000,
        col_f: 1500, col_g: 2750, col_h: 0, col_i: 0,
        col_j: 46250, col_k: 53750,
        col_l: 10750, col_m: 2400, col_n: 0, col_o: 8350 },
      // ... snapshot covers structure; full 12-month payloads exercised in golden tests.
    ],
  },
};

describe("Kenya P9 v10 — v3 compile snapshot", () => {
  it("compiles deterministically", () => {
    const a = compile(KE_P9_V10_TEMPLATE, SAMPLE_PAYLOAD as any, { currency: "KES" });
    const b = compile(KE_P9_V10_TEMPLATE, SAMPLE_PAYLOAD as any, { currency: "KES" });
    expect(a.html).toBe(b.html);
    expect(a.css).toBe(b.css);
    expect(a.unresolved).toEqual(b.unresolved);
  });

  it("renders every P9 column and every column group", () => {
    const { html } = compile(KE_P9_V10_TEMPLATE, SAMPLE_PAYLOAD as any, { currency: "KES" });
    // 17 P9 columns + Month = 18 <th> in the primary header row.
    // Column-group row adds 6 more (Earnings, Retirement, etc.).
    for (const col of ["A","B","C","D","E1","E2","E3","F","G","H","I","J","K","L","M","N","O"]) {
      expect(html).toContain(`>${col}</th>`);
    }
    for (const grp of ["Earnings","Defined Contribution Retirement","Statutory Deductions","Totals","Tax"]) {
      expect(html).toContain(grp);
    }
    expect(html).toContain("TOTAL");
    // Sum of two months of col_o = 8350 + 8350 = 16,700
    expect(html).toContain("16,700.00");
  });

  it("resolves employer/employee bindings and formats currency totals", () => {
    const { html, unresolved } = compile(
      KE_P9_V10_TEMPLATE, SAMPLE_PAYLOAD as any, { currency: "KES" },
    );
    expect(html).toContain("Acme Kenya Ltd");
    expect(html).toContain("P051234567X");
    expect(html).toContain("Jane Wanjiku");
    expect(html).toContain("KES 1,320,000.00");
    expect(html).toContain("KES 264,000.00");
    expect(unresolved).toEqual([]);
  });

  it("emits page-master header and footer bands", () => {
    const { html, css } = compile(KE_P9_V10_TEMPLATE, SAMPLE_PAYLOAD as any, {});
    expect(html).toContain("KENYA REVENUE AUTHORITY");
    expect(html).toContain("TAX DEDUCTION CARD");
    expect(html).toContain("APPENDIX 2A");
    expect(html).toContain('class="page-header"');
    expect(html).toContain('class="page-footer"');
    expect(css).toContain("@page");
    expect(css).toContain("A4 landscape");
    expect(css).toContain("position: running(pageHeader)");
  });

  it("surfaces missing bindings without crashing", () => {
    const partial = { ...SAMPLE_PAYLOAD, employee: { full_name: "X" } };
    const { unresolved } = compile(KE_P9_V10_TEMPLATE, partial as any, { currency: "KES" });
    expect(unresolved).toContain("employee.tax_pin");
    expect(unresolved).toContain("employee.employee_number");
  });
});
