/**
 * keReturnFixture — synthetic KE statutory-return payload used by the
 * ReturnTemplateEditor v2 preview pane. Shape mirrors
 * `ReturnPayload` (the shape `generate-statutory-return` builds for
 * the v2 renderer).
 */
import type { ReturnPayload, ReturnTemplateV2 } from "../pdf/returnRenderer";

export const KE_RETURN_PREVIEW_PAYLOAD: ReturnPayload = {
  employer: {
    name: "Acme Manufacturing Ltd (Preview)",
    tax_pin: "P051234567B",
    address: "Enterprise Rd, Industrial Area, Nairobi",
    tax_office: "Times Tower – Nairobi",
  },
  period_start: "2025-06-01",
  period_end: "2025-06-30",
  period_label: "June 2025 (Preview)",
  currency: "KES",
  rows: [
    { employee_pin: "A012345678W", employee_name: "Wanjiku Kamau",    employee_amount: 45200, employer_amount: 2160 },
    { employee_pin: "A023456789X", employee_name: "Peter Otieno",     employee_amount: 32450, employer_amount: 2160 },
    { employee_pin: "A034567890Y", employee_name: "Amina Hassan",     employee_amount: 27100, employer_amount: 2160 },
    { employee_pin: "A045678901Z", employee_name: "Grace Mwangi",     employee_amount: 51300, employer_amount: 2160 },
    { employee_pin: "A056789012A", employee_name: "Daniel Kiprop",    employee_amount: 18900, employer_amount: 2160 },
    { employee_pin: "A067890123B", employee_name: "Faith Achieng",    employee_amount: 24600, employer_amount: 2160 },
  ],
  totals: {
    employee_amount: 199550,
    employer_amount: 12960,
  },
  reconciliation: {
    rule_code: "PAYE",
    expected: 199550,
    actual: 199550,
    delta: 0,
  },
  serial_number: "PREVIEW-RETURN-000001",
  generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
};

export function buildPreviewReturnTemplate(
  templateCode: string,
  displayName: string,
  body: unknown,
  meta?: {
    legal_reference?: string | null;
    regulation_citation?: string | null;
    authority_name?: string | null;
  } | null,
): ReturnTemplateV2 {
  return {
    code: templateCode,
    display_name: displayName || templateCode,
    legal_reference: meta?.legal_reference ?? null,
    regulation_citation: meta?.regulation_citation ?? null,
    authority_name: meta?.authority_name ?? null,
    body: (body as any) ?? null,
  };
}
