/**
 * keP9V3Fixture — synthetic KE payroll payload shaped for the v3
 * certificate engine (pivoted `p9.months` matrix + `totals`), used by
 * the editor live preview. Mirrors the shape `generate-tax-certificate`
 * assembles for the client renderer.
 */
import type { CertificatePayload } from "../engine/types";

interface P9Month {
  month: number;
  col_a: number; col_b: number; col_c: number; col_d: number;
  col_e1: number; col_e2: number; col_e3: number;
  col_f: number; col_g: number; col_h: number; col_i: number;
  col_j: number; col_k: number; col_l: number; col_m: number; col_n: number; col_o: number;
}

function buildMonth(month: number, basic: number): P9Month {
  const col_a = basic;
  const col_b = 0;
  const col_c = 0;
  const col_d = col_a + col_b + col_c;
  const col_e1 = +(col_a * 0.3).toFixed(2);
  const col_e2 = 2160;
  const col_e3 = 30000;
  const pensionCap = Math.min(col_e1, col_e2, 30000);
  const col_f = +(col_a * 0.015).toFixed(2); // AHL 1.5%
  const col_g = +(col_a * 0.0275).toFixed(2); // SHIF 2.75%
  const col_h = 0;
  const col_i = 0;
  const col_j = +(pensionCap + col_f + col_g + col_h + col_i).toFixed(2);
  const col_k = +(col_d - col_j).toFixed(2);
  const col_l = +(col_k * 0.25).toFixed(2);
  const col_m = 2400;
  const col_n = 0;
  const col_o = Math.max(0, +(col_l - col_m - col_n).toFixed(2));
  return {
    month,
    col_a, col_b, col_c, col_d,
    col_e1, col_e2, col_e3,
    col_f, col_g, col_h, col_i,
    col_j, col_k, col_l, col_m, col_n, col_o,
  };
}

const BASIC_BY_MONTH = [120000, 120000, 120000, 130000, 130000, 130000, 140000, 140000, 140000, 150000, 150000, 150000];
const months: P9Month[] = BASIC_BY_MONTH.map((b, i) => buildMonth(i + 1, b));

const totals = {
  chargeable_pay: months.reduce((s, m) => s + m.col_k, 0),
  paye: months.reduce((s, m) => s + m.col_o, 0),
};

export const KE_P9_V3_PREVIEW_PAYLOAD: CertificatePayload = {
  employer: {
    name: "Acme Manufacturing Ltd (Preview)",
    tax_pin: "P051234567B",
    tax_office: "Times Tower – Nairobi",
    address: "Enterprise Rd, Industrial Area, Nairobi",
  },
  employee: {
    full_name: "Wanjiku Kamau",
    other_names: "Njeri",
    tax_pin: "A012345678W",
    employee_number: "EMP-0421",
  },
  fiscal_year: new Date().getFullYear() - 1,
  currency: "KES",
  p9: { months },
  totals,
  serial_number: "PREVIEW-000001",
  generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
};
