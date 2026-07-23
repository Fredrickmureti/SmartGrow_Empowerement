// @ts-nocheck — Deno runtime
/**
 * annualEarningsResolver — SINGLE writer of `AnnualEarningsStatementDTO`
 * (ADR-0063). Any caller wanting to render an Annual Earnings Statement
 * MUST resolve through this function; direct reads of `payslip_lines`
 * are forbidden by the arch test
 * `src/test/architecture/annual-earnings-canonical-binding.test.ts`.
 *
 * Data flow:
 *   payroll_employee_ytd_rollup      → ytd totals + breakdown
 *   payroll_employee_monthly_breakdown → 12 monthly rows (all categories)
 *   organization_statutory_identifiers → employer identifiers
 *   employee_statutory_identifiers      → employee identifiers
 *   getOrganizationBranding             → employer identity strings
 *
 * Determinism: `content_hash` is a stable SHA-256 over a canonical JSON
 * projection of the DTO with `generated_at`, `serial_number` and
 * `provenance` stripped. Regeneration with identical inputs yields the
 * same hash.
 */

import {
  ANNUAL_EARNINGS_DTO_VERSION,
  emptyMonth,
  emptyYtd,
  routeCategoryToChannel,
  type AnnualEarningsBreakdownRow,
  type AnnualEarningsIdentifier,
  type AnnualEarningsMonth,
  type AnnualEarningsStatementDTO,
  type AnnualEarningsYtd,
} from "./annualEarningsTypes.ts";
import { resolveCertificateYtd } from "./certificateSourceResolver.ts";

// ---------- helpers ----------

function canonicalJsonStringify(value: unknown): string {
  // Deterministic JSON: object keys sorted, arrays preserved.
  const seen = new WeakSet();
  const stable = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(stable);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
    return out;
  };
  return JSON.stringify(stable(value));
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- identifiers ----------

async function loadEmployerIdentifiers(
  admin: any, orgId: string, businessId: string,
): Promise<AnnualEarningsIdentifier[]> {
  const { data } = await admin
    .from("organization_statutory_identifiers")
    .select("scheme_code, display_label, identifier_value")
    .eq("organization_id", orgId)
    .eq("business_id", businessId);
  return ((data ?? []) as any[]).map((r) => ({
    scheme: String(r.scheme_code ?? ""),
    label: String(r.display_label ?? r.scheme_code ?? ""),
    value: String(r.identifier_value ?? ""),
  })).filter((r) => r.scheme && r.value);
}

async function loadEmployeeIdentifiers(
  admin: any, employeeId: string,
): Promise<AnnualEarningsIdentifier[]> {
  const { data } = await admin
    .from("employee_statutory_identifiers")
    .select("scheme_code, display_label, identifier_value")
    .eq("employee_id", employeeId);
  return ((data ?? []) as any[]).map((r) => ({
    scheme: String(r.scheme_code ?? ""),
    label: String(r.display_label ?? r.scheme_code ?? ""),
    value: String(r.identifier_value ?? ""),
  })).filter((r) => r.scheme && r.value);
}

// ---------- extensions ----------

async function loadPackExtensions(
  admin: any,
  orgId: string,
  baseTemplateCode: string,
): Promise<Record<string, unknown>> {
  // Installed packs for this org (country-agnostic — we don't filter on
  // country_code in shared code; the join to installed packs already
  // scopes to the tenant, mirroring ADR-0062 invariant 6).
  const { data: installed } = await admin
    .from("installed_localization_packs")
    .select("pack_code")
    .eq("organization_id", orgId);
  const packCodes = ((installed ?? []) as any[])
    .map((r) => String(r.pack_code)).filter(Boolean);
  if (!packCodes.length) return {};
  const { data: exts } = await admin
    .from("payroll_certificate_template_extensions")
    .select("pack_code, region, body, version")
    .eq("base_template_code", baseTemplateCode)
    .in("pack_code", packCodes);
  const byPack: Record<string, unknown> = {};
  for (const ext of (exts ?? []) as any[]) {
    const key = String(ext.pack_code);
    const prev = (byPack[key] as any) ?? {};
    prev[String(ext.region)] = ext.body;
    byPack[key] = prev;
  }
  return byPack;
}

// ---------- main resolver ----------

export interface ResolveAnnualEarningsParams {
  admin: any;
  organizationId: string;
  businessId: string;
  employeeId: string;
  fiscalYear: number;
  branding: {
    name?: string | null;
    legal_name?: string | null;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  employee: {
    id: string;
    full_name: string;
    employee_number?: string | null;
    department?: string | null;
    position?: string | null;
    employment_status?: string | null;
    hire_date?: string | null;
    termination_date?: string | null;
  };
  currency: string;
  serialNumber: string;
  baseTemplateCode: string;
  issuer?: { name: string | null; title: string | null } | null;
}

export async function resolveAnnualEarnings(
  params: ResolveAnnualEarningsParams,
): Promise<AnnualEarningsStatementDTO> {
  const {
    admin, organizationId, businessId, employeeId, fiscalYear,
    branding, employee, currency, serialNumber, baseTemplateCode,
  } = params;

  // 1. YTD projection (canonical) — delegates to the certificate resolver
  //    so P9A / IRP5 / Annual Earnings can never disagree on totals.
  const ytdSource = await resolveCertificateYtd({
    admin, organizationId, businessId, employeeId, fiscalYear,
  });

  // 2. Monthly breakdown — all rule codes (NULL → every category).
  const { data: mmRows } = await admin.rpc(
    "payroll_employee_monthly_breakdown",
    { p_year: fiscalYear, p_employee_id: employeeId, p_rule_codes: null },
  );

  const months: AnnualEarningsMonth[] = Array.from(
    { length: 12 }, (_, i) => emptyMonth(i + 1),
  );
  const breakdown = {
    earnings: [] as AnnualEarningsBreakdownRow[],
    benefits: [] as AnnualEarningsBreakdownRow[],
    statutory_ee: [] as AnnualEarningsBreakdownRow[],
    statutory_er: [] as AnnualEarningsBreakdownRow[],
    other_deductions: [] as AnnualEarningsBreakdownRow[],
    reliefs: [] as AnnualEarningsBreakdownRow[],
  };

  for (const row of ((mmRows ?? []) as any[])) {
    // Canonical RPC column is `month_index`; accept `month` as a legacy
    // alias for defensive forward-compat.
    const rawMonth = Number(row.month_index ?? row.month) || 0;
    const mIdx = rawMonth >= 1 && rawMonth <= 12 ? rawMonth : 0;
    if (!mIdx) continue;
    const target = months[mIdx - 1];
    const channel = routeCategoryToChannel(row.category);
    const amt = Number(row.employee_amount) || 0;
    if (channel) (target as any)[channel] += amt;
    // `taxable` is not a category — it is a scalar on each payslip line
    // proportionally attributed by the RPC. Sum it directly.
    target.taxable += Number(row.taxable_amount) || 0;
  }
  // Compute canonical net per month: gross + benefits − statutory_ee −
  // other_deductions. Reliefs are already netted inside PAYE (see the
  // certificate resolver comment).
  for (const m of months) {
    m.net = m.gross + m.benefits - m.statutory_employee - m.other_deductions;
  }

  // Bucket breakdown rows by channel using the YTD (per rule_code) rows.
  for (const r of ytdSource.rows) {
    const channel = routeCategoryToChannel(r.category);
    const row: AnnualEarningsBreakdownRow = {
      rule_code: r.rule_code,
      category: r.category,
      employee_amount: r.employee_amount,
      employer_amount: r.employer_amount,
      taxable_amount: r.taxable_amount,
    };
    if (channel === "gross") breakdown.earnings.push(row);
    else if (channel === "benefits") breakdown.benefits.push(row);
    else if (channel === "statutory_employee") breakdown.statutory_ee.push(row);
    else if (channel === "statutory_employer") breakdown.statutory_er.push(row);
    else if (channel === "other_deductions") breakdown.other_deductions.push(row);
    else if (channel === "reliefs") breakdown.reliefs.push(row);
  }

  // 3. YTD aggregate — derived ONLY from the canonical rollup
  //    (`payroll_employee_ytd`). This is the single source of truth for
  //    every YTD column; monthly rows are a projection of the same
  //    underlying `payslip_lines`, so months and YTD agree by
  //    construction. Summing months would introduce a parallel
  //    aggregation path and drift (already happened once with the
  //    `taxable` category that does not exist in payslip_lines).
  const ytd: AnnualEarningsYtd = emptyYtd();
  for (const r of ytdSource.rows) {
    const channel = routeCategoryToChannel(r.category);
    if (channel) (ytd as any)[channel] += r.employee_amount;
    ytd.taxable += r.taxable_amount;
  }
  ytd.net = ytd.gross + ytd.benefits - ytd.statutory_employee - ytd.other_deductions;
  ytd.employer_contributions_total = ytdSource.totals.employer;
  // Pension total: sum employer amounts on rows whose rule_code hints at
  // pension — kept country-neutral by matching on a bare "pension" token
  // that packs use in their rule_code naming convention.
  ytd.pension_total = ytdSource.rows.reduce(
    (s, r) => s + (/pension/i.test(r.rule_code) ? r.employer_amount + r.employee_amount : 0),
    0,
  );
  ytd.final_settlement = 0; // computed post-termination when we wire the exit surface.

  // 4. Identity blocks
  const [employerIds, employeeIds] = await Promise.all([
    loadEmployerIdentifiers(admin, organizationId, businessId),
    loadEmployeeIdentifiers(admin, employeeId),
  ]);

  const employmentFrom = employee.hire_date ?? null;
  const employmentTo = employee.termination_date ?? null;
  const empLabel = employmentFrom
    ? `${employmentFrom} → ${employmentTo ?? "present"}`
    : "—";

  // 5. Pack extensions (may inject P9 / P60 / IRP5 appendix bodies)
  const extensions = await loadPackExtensions(
    admin, organizationId, baseTemplateCode,
  );

  // 6. Assemble DTO (without provenance — hash next)
  const partial: Omit<AnnualEarningsStatementDTO, "provenance"> = {
    dto_version: ANNUAL_EARNINGS_DTO_VERSION,
    period: {
      fiscal_year: fiscalYear,
      from: `${fiscalYear}-01-01`,
      to: `${fiscalYear}-12-31`,
      label: `1 Jan ${fiscalYear} – 31 Dec ${fiscalYear}`,
      currency,
    },
    employer: {
      name: branding.name ?? "",
      legal_name: branding.legal_name ?? null,
      registered_address: branding.address ?? null,
      contact: [branding.phone, branding.email].filter(Boolean).join(" · ") || null,
      statutory_identifiers: employerIds,
    },
    employee: {
      id: employee.id,
      full_name: employee.full_name,
      employee_number: employee.employee_number ?? null,
      department: employee.department ?? null,
      position: employee.position ?? null,
      employment_status: employee.employment_status ?? null,
      employment_period: { from: employmentFrom, to: employmentTo, label: empLabel },
      statutory_identifiers: employeeIds,
    },
    months,
    ytd,
    breakdown,
    extensions,
    serial_number: serialNumber,
    generated_at: new Date().toISOString(),
    issuer: params.issuer ?? null,
  };

  // 7. Deterministic content hash — strip volatile fields
  const contentSubject = {
    ...partial,
    generated_at: null,
    serial_number: null,
  };
  const contentHash = await sha256Hex(canonicalJsonStringify(contentSubject));

  const dto: AnnualEarningsStatementDTO = {
    ...partial,
    provenance: {
      run_ids: ytdSource.provenance.run_ids,
      payslip_ids: ytdSource.provenance.payslip_ids,
      payroll_high_water_mark: ytdSource.provenance.max_payroll_updated_at,
      dto_version: ANNUAL_EARNINGS_DTO_VERSION,
      content_hash: contentHash,
      content_hash_short: contentHash.slice(0, 12),
    },
  };

  return dto;
}