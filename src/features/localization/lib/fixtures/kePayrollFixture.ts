/**
 * kePayrollFixture — synthetic KE payroll dataset used by the editor
 * preview. Shape mirrors `CertificatePayload` (the same shape the edge
 * renderer receives from `generate-tax-certificate`).
 *
 * The fixture is intentionally rich — every rule code a KE P9 would
 * plausibly reference is present so publishers can toggle columns in
 * the monthly-breakdown section and immediately see them populate.
 */
import type { CertificatePayload, MonthlyRow, CertificateTemplate } from "../pdf/certificateRenderer";

const RULE_MONTHLY: Record<string, number[]> = {
  gross_pay:       [180000, 180000, 180000, 195000, 195000, 195000, 205000, 205000, 205000, 220000, 220000, 220000],
  basic_pay:       [120000, 120000, 120000, 130000, 130000, 130000, 140000, 140000, 140000, 150000, 150000, 150000],
  allowances:      [ 60000,  60000,  60000,  65000,  65000,  65000,  65000,  65000,  65000,  70000,  70000,  70000],
  paye:            [ 32450,  32450,  32450,  37200,  37200,  37200,  40450,  40450,  40450,  45200,  45200,  45200],
  nssf:            [  2160,   2160,   2160,   2160,   2160,   2160,   2160,   2160,   2160,   2160,   2160,   2160],
  shif:            [  4950,   4950,   4950,   5362,   5362,   5362,   5637,   5637,   5637,   6050,   6050,   6050],
  housing_levy:    [  2700,   2700,   2700,   2925,   2925,   2925,   3075,   3075,   3075,   3300,   3300,   3300],
  personal_relief: [  2400,   2400,   2400,   2400,   2400,   2400,   2400,   2400,   2400,   2400,   2400,   2400],
  insurance_relief:[   500,    500,    500,    500,    500,    500,    500,    500,    500,    500,    500,    500],
  net_pay:         [135340, 135340, 135340, 144953, 144953, 144953, 153278, 153278, 153278, 162290, 162290, 162290],
};

const monthly: MonthlyRow[] = [];
for (const [rule_code, arr] of Object.entries(RULE_MONTHLY)) {
  for (let m = 0; m < 12; m++) {
    monthly.push({
      month_index: m + 1,
      rule_code,
      category: null,
      employee_amount: arr[m],
      employer_amount: rule_code === "nssf" ? arr[m] : 0,
      taxable_amount: rule_code === "gross_pay" ? arr[m] : 0,
    });
  }
}

const ytdRows = Object.entries(RULE_MONTHLY).map(([rule_code, arr]) => {
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    rule_code,
    category: rule_code === "paye" ? "tax" : rule_code === "net_pay" ? "summary" : "statutory",
    employee_amount: sum,
    employer_amount: rule_code === "nssf" ? sum : 0,
    taxable_amount: rule_code === "gross_pay" ? sum : 0,
  };
});

const totalEmployee = ytdRows
  .filter((r) => ["paye", "nssf", "shif", "housing_levy"].includes(r.rule_code))
  .reduce((s, r) => s + r.employee_amount, 0);
const totalEmployer = ytdRows.reduce((s, r) => s + r.employer_amount, 0);
const totalTaxable  = ytdRows.find((r) => r.rule_code === "gross_pay")?.employee_amount ?? 0;

export const KE_CERTIFICATE_PREVIEW_PAYLOAD: CertificatePayload = {
  employee: {
    id: "preview-emp-1",
    full_name: "Wanjiku Kamau",
    employee_number: "EMP-0421",
    tax_pin: "A012345678W",
    national_id: "24681357",
    position: "Senior Payroll Officer",
    department: "Finance & Compliance",
    hire_date: "2019-03-04",
    exit_date: null,
  },
  employer: {
    name: "Acme Manufacturing Ltd (Preview)",
    tax_pin: "P051234567B",
    address: "Enterprise Rd, Industrial Area, Nairobi",
    tax_office: "Times Tower – Nairobi",
    phone: "+254 20 000 0000",
    email: "payroll@acme.example.co.ke",
  },
  fiscal_year: new Date().getFullYear() - 1,
  period_label: `Fiscal Year ${new Date().getFullYear() - 1} (Preview)`,
  currency: "KES",
  monthly,
  ytdRows,
  totals: { employee: totalEmployee, employer: totalEmployer, taxable: totalTaxable },
  serial_number: "PREVIEW-000001",
  generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
};

/** Build a preview-ready `CertificateTemplate` from the editor's live
 *  metadata + body state. */
export function buildPreviewTemplate(
  templateCode: string,
  displayName: string,
  body: unknown,
  meta?: {
    legal_reference?: string | null;
    regulation_citation?: string | null;
    effective_date?: string | null;
  } | null,
): CertificateTemplate {
  return {
    code: templateCode,
    display_name: displayName || templateCode,
    legal_reference: meta?.legal_reference ?? null,
    regulation_citation: meta?.regulation_citation ?? null,
    effective_date: meta?.effective_date ?? null,
    authority_name: null,
    body: (body as any) ?? null,
  };
}
