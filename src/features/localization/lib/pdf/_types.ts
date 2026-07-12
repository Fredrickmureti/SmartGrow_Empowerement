/**
 * _types — minimal browser-side type aliases mirrored from
 * `supabase/functions/_shared/branding/index.ts` and
 * `supabase/functions/_shared/certificateSections.ts`.
 *
 * The renderer only touches a small structural shape from each of
 * those Deno modules; we duplicate just that shape here so the
 * browser bundler doesn't drag the Supabase-runtime code into Vite.
 */

export interface OrganizationBranding {
  name?: string | null;
  tax_pin?: string | null;
  address?: string | null;
  tax_office?: string | null;
  phone?: string | null;
  email?: string | null;
  [k: string]: unknown;
}

export interface MonthlyRow {
  month_index: number;
  rule_code: string;
  category?: string | null;
  employee_amount: number;
  employer_amount: number;
  taxable_amount: number;
  [k: string]: unknown;
}
