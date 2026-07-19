/**
 * HR letter fetchers (Phase 6.1 — ADR-0084).
 *
 * Each HR letter type has a distinct source-of-truth table:
 *   - offer_letter      → offer_letters       (pre-hire; joins candidate)
 *   - contract_letter   → employee_contracts  (joins employee)
 *   - promotion_letter  → employee_lifecycle_events (event_type='promoted')
 *   - warning_letter    → employee_lifecycle_events (event_type='warning_issued')
 *
 * Fetchers project rows into the canonical HrLetterData shape consumed
 * by generateHrLetterPdf. Tenancy (organization_id / business_id) is
 * exposed through getHrLetterTenancy so the generic tenant-isolation
 * check in generate-document/index.ts can gate access identically to
 * every other document type.
 */

import type { HrLetterData, HrLetterType } from "../_shared/hrLetterGenerator.ts";

export const HR_LETTER_TYPES: ReadonlySet<HrLetterType> = new Set([
  "offer_letter",
  "promotion_letter",
  "warning_letter",
  "contract_letter",
]);

export function isHrLetterType(t: string): t is HrLetterType {
  return HR_LETTER_TYPES.has(t as HrLetterType);
}

const ORG_JOIN = "id, name, logo_url, address, city, state, postal_code, country, phone, email, tax_id";
const BIZ_JOIN = "id, name, legal_name, logo_url, address, city, state, postal_code, country, phone, email, tax_id";

// deno-lint-ignore no-explicit-any
type SB = any;

function fmtMoney(n: number | null | undefined, currency: string | null | undefined): string {
  if (n == null) return "—";
  const cur = currency || "";
  return `${cur} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(" ").trim() || "—";
}

function pickOrg(row: any) {
  return row.business ?? row.organization ?? null;
}

// ── Offer letter ────────────────────────────────────────────────────────

export async function fetchOfferLetter(supabase: SB, id: string): Promise<HrLetterData> {
  const { data, error } = await supabase
    .from("offer_letters")
    .select(`
      *,
      organization:organizations(${ORG_JOIN}),
      business:businesses(${BIZ_JOIN}),
      application:candidate_applications(
        id,
        candidate:candidates(first_name, last_name, email, phone),
        job:job_positions(title)
      )
    `)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`offer_letter fetch failed: ${error.message}`);
  if (!data) throw new Error(`offer_letter not found: ${id}`);

  const cand = data.application?.candidate ?? {};
  const jobTitle = data.application?.job?.title ?? null;
  const currency = data.currency ?? null;
  const facts = [
    jobTitle ? { label: "Position", value: String(jobTitle) } : null,
    data.start_date ? { label: "Proposed Start Date", value: String(data.start_date) } : null,
    data.base_salary != null ? { label: "Base Salary (annual)", value: fmtMoney(data.base_salary, currency) } : null,
    data.bonus_target != null ? { label: "Bonus Target", value: fmtMoney(data.bonus_target, currency) } : null,
    data.expires_at ? { label: "Offer Expires", value: String(data.expires_at) } : null,
  ].filter(Boolean) as { label: string; value: string }[];

  const org = pickOrg(data);
  return {
    document_type: "offer_letter",
    document_number: `OFFER-${String(id).slice(0, 8).toUpperCase()}`,
    issue_date: data.sent_at ?? data.created_at ?? null,
    effective_date: data.start_date ?? null,
    subject: jobTitle ? `Offer of Employment — ${jobTitle}` : "Offer of Employment",
    salutation: `Dear ${fullName(cand.first_name, cand.last_name)},`,
    body: data.letter_body
      || "We are pleased to extend to you the following offer of employment. The key terms are summarised above. Please review this letter carefully; a countersigned copy constitutes acceptance.",
    closing: "We look forward to welcoming you to the team.",
    facts,
    notes: data.notes ?? null,
    recipient: {
      name: fullName(cand.first_name, cand.last_name),
      email: cand.email ?? null,
      job_title: jobTitle,
    },
    signatories: [
      { name: "Authorised Signatory", role: `For and on behalf of ${org?.name ?? "the Company"}` },
      { name: fullName(cand.first_name, cand.last_name), role: "Candidate — acceptance" },
    ],
    organization: org,
    business_id: data.business_id ?? null,
    organization_id: data.organization_id,
  };
}

// ── Contract letter ─────────────────────────────────────────────────────

export async function fetchContractLetter(supabase: SB, id: string): Promise<HrLetterData> {
  const { data, error } = await supabase
    .from("employee_contracts")
    .select(`
      *,
      organization:organizations(${ORG_JOIN}),
      business:businesses(${BIZ_JOIN}),
      employee:employees(
        first_name, last_name, employee_number, email, work_email,
        address_line1, city, state, postal_code, country,
        job_position:job_positions(title),
        department:departments(name)
      )
    `)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`contract_letter fetch failed: ${error.message}`);
  if (!data) throw new Error(`contract_letter not found: ${id}`);

  const emp = data.employee ?? {};
  const facts = [
    { label: "Contract Reference", value: String(data.contract_reference ?? data.name ?? id) },
    { label: "Start Date", value: String(data.start_date ?? "—") },
    data.end_date ? { label: "End Date", value: String(data.end_date) } : null,
    data.probation_end_date ? { label: "Probation Ends", value: String(data.probation_end_date) } : null,
    { label: "Base Wage", value: fmtMoney(data.wage, null) },
    data.housing_allowance ? { label: "Housing Allowance", value: fmtMoney(data.housing_allowance, null) } : null,
    data.transport_allowance ? { label: "Transport Allowance", value: fmtMoney(data.transport_allowance, null) } : null,
    { label: "Working Schedule", value: String(data.working_schedule ?? "—") },
  ].filter(Boolean) as { label: string; value: string }[];

  const org = pickOrg(data);
  return {
    document_type: "contract_letter",
    document_number: String(data.contract_reference ?? id),
    issue_date: data.approved_at ?? data.created_at ?? null,
    effective_date: data.start_date ?? null,
    subject: `Employment Contract — ${data.name ?? "Terms of Engagement"}`,
    salutation: `Dear ${fullName(emp.first_name, emp.last_name)},`,
    body: data.notes
      || "This document sets out the terms and conditions of your employment. It supersedes any prior agreement, verbal or written, relating to the subject matter set out herein.",
    facts,
    recipient: {
      name: fullName(emp.first_name, emp.last_name),
      employee_number: emp.employee_number ?? null,
      job_title: emp.job_position?.title ?? null,
      department: emp.department?.name ?? null,
      email: emp.work_email ?? emp.email ?? null,
      address_line1: emp.address_line1 ?? null,
      city: emp.city ?? null,
      state: emp.state ?? null,
      postal_code: emp.postal_code ?? null,
      country: emp.country ?? null,
    },
    signatories: [
      { name: "Authorised Signatory", role: `For and on behalf of ${org?.name ?? "the Company"}` },
      { name: fullName(emp.first_name, emp.last_name), role: "Employee — acceptance" },
    ],
    organization: org,
    business_id: data.business_id ?? null,
    organization_id: data.organization_id,
  };
}

// ── Lifecycle-sourced letters (promotion / warning) ─────────────────────

async function fetchLifecycleEvent(supabase: SB, id: string) {
  const { data, error } = await supabase
    .from("employee_lifecycle_events")
    .select(`
      *,
      organization:organizations(${ORG_JOIN}),
      business:businesses(${BIZ_JOIN}),
      employee:employees(
        first_name, last_name, employee_number, email, work_email,
        address_line1, city, state, postal_code, country,
        job_position:job_positions(title),
        department:departments(name)
      )
    `)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`lifecycle event fetch failed: ${error.message}`);
  if (!data) throw new Error(`lifecycle event not found: ${id}`);
  return data;
}

export async function fetchPromotionLetter(supabase: SB, id: string): Promise<HrLetterData> {
  const data = await fetchLifecycleEvent(supabase, id);
  const emp = data.employee ?? {};
  const payload = (data.payload ?? {}) as Record<string, unknown>;
  const newTitle = (payload.new_title ?? payload.title ?? null) as string | null;
  const newSalary = (payload.new_salary ?? payload.salary ?? null) as number | null;
  const currency = (payload.currency ?? null) as string | null;

  const facts = [
    newTitle ? { label: "New Position", value: newTitle } : null,
    data.effective_date ? { label: "Effective Date", value: String(data.effective_date) } : null,
    newSalary != null ? { label: "New Base Salary", value: fmtMoney(newSalary, currency) } : null,
  ].filter(Boolean) as { label: string; value: string }[];

  const org = pickOrg(data);
  return {
    document_type: "promotion_letter",
    document_number: `PROMO-${String(id).slice(0, 8).toUpperCase()}`,
    issue_date: data.occurred_at ?? data.created_at ?? null,
    effective_date: data.effective_date ?? null,
    subject: newTitle ? `Promotion to ${newTitle}` : "Promotion Confirmation",
    salutation: `Dear ${fullName(emp.first_name, emp.last_name)},`,
    body: (data.summary as string | null)
      || "In recognition of your contribution and continued performance, we are pleased to confirm your promotion effective on the date indicated above. All other terms of your employment remain unchanged unless expressly set out in this letter.",
    closing: "Congratulations on this well-deserved advancement.",
    facts,
    recipient: {
      name: fullName(emp.first_name, emp.last_name),
      employee_number: emp.employee_number ?? null,
      job_title: emp.job_position?.title ?? null,
      department: emp.department?.name ?? null,
      email: emp.work_email ?? emp.email ?? null,
    },
    signatories: [
      { name: (data.actor_label as string | null) ?? "Authorised Signatory", role: `For and on behalf of ${org?.name ?? "the Company"}` },
    ],
    organization: org,
    business_id: data.business_id ?? null,
    organization_id: data.organization_id,
  };
}

export async function fetchWarningLetter(supabase: SB, id: string): Promise<HrLetterData> {
  const data = await fetchLifecycleEvent(supabase, id);
  const emp = data.employee ?? {};
  const payload = (data.payload ?? {}) as Record<string, unknown>;
  const severity = (payload.severity ?? payload.level ?? "Formal") as string;
  const reason = (payload.reason ?? null) as string | null;

  const facts = [
    { label: "Warning Level", value: String(severity) },
    data.effective_date ? { label: "Issued On", value: String(data.effective_date) } : null,
    reason ? { label: "Reason", value: String(reason) } : null,
  ].filter(Boolean) as { label: string; value: string }[];

  const org = pickOrg(data);
  return {
    document_type: "warning_letter",
    document_number: `WARN-${String(id).slice(0, 8).toUpperCase()}`,
    issue_date: data.occurred_at ?? data.created_at ?? null,
    effective_date: data.effective_date ?? null,
    subject: `${severity} Warning`,
    salutation: `Dear ${fullName(emp.first_name, emp.last_name)},`,
    body: (data.summary as string | null)
      || "This letter serves as a formal record of concern regarding your recent conduct or performance. You are expected to demonstrate immediate and sustained improvement. Failure to do so may result in further disciplinary action, up to and including termination of employment.",
    closing:
      "You have the right to respond to this letter in writing within five (5) working days. A signed copy will be retained on your personnel file.",
    facts,
    recipient: {
      name: fullName(emp.first_name, emp.last_name),
      employee_number: emp.employee_number ?? null,
      job_title: emp.job_position?.title ?? null,
      department: emp.department?.name ?? null,
      email: emp.work_email ?? emp.email ?? null,
    },
    signatories: [
      { name: (data.actor_label as string | null) ?? "HR Manager", role: `For and on behalf of ${org?.name ?? "the Company"}` },
      { name: fullName(emp.first_name, emp.last_name), role: "Employee — acknowledgement" },
    ],
    organization: org,
    business_id: data.business_id ?? null,
    organization_id: data.organization_id,
  };
}

// ── Dispatcher + tenancy lookup ─────────────────────────────────────────

export async function fetchHrLetter(
  supabase: SB,
  type: HrLetterType,
  id: string,
): Promise<HrLetterData> {
  switch (type) {
    case "offer_letter":     return await fetchOfferLetter(supabase, id);
    case "contract_letter":  return await fetchContractLetter(supabase, id);
    case "promotion_letter": return await fetchPromotionLetter(supabase, id);
    case "warning_letter":   return await fetchWarningLetter(supabase, id);
  }
}

const HR_TABLE_MAP: Record<HrLetterType, string> = {
  offer_letter: "offer_letters",
  contract_letter: "employee_contracts",
  promotion_letter: "employee_lifecycle_events",
  warning_letter: "employee_lifecycle_events",
};

export async function getHrLetterTenancy(
  supabase: SB,
  type: HrLetterType,
  id: string,
): Promise<{ organization_id: string | null; business_id: string | null }> {
  const table = HR_TABLE_MAP[type];
  const { data } = await supabase
    .from(table)
    .select("organization_id, business_id")
    .eq("id", id)
    .maybeSingle();
  return {
    organization_id: data?.organization_id ?? null,
    business_id: data?.business_id ?? null,
  };
}