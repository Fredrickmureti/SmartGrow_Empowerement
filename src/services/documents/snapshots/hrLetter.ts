/**
 * Wave 7.2 — HR letter snapshot builders.
 *
 * HR letters (offer, contract, promotion, warning) are prose documents, not
 * tabular sales documents. Historically they were rendered by
 * `generate-document` re-fetching the source rows at print time, which meant
 * a letter reprinted a year later could silently pick up a renamed job title
 * or a corrected salary — unacceptable for a document an employee signed.
 *
 * These builders freeze the letter at dispatch time, in the exact
 * `HrLetterData` shape `_shared/hrLetterGenerator.ts` consumes. The projection
 * mirrors `supabase/functions/generate-document/hrLetterFetchers.ts`; changes
 * on either side must land together.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export type HrLetterType =
  | "offer_letter"
  | "contract_letter"
  | "promotion_letter"
  | "warning_letter";

export const HR_LETTER_LABELS: Record<HrLetterType, string> = {
  offer_letter: "OFFER OF EMPLOYMENT",
  contract_letter: "EMPLOYMENT CONTRACT",
  promotion_letter: "PROMOTION LETTER",
  warning_letter: "WARNING LETTER",
};

/** `document_kinds.code` for each letter type. */
export const HR_LETTER_KIND_CODES: Record<HrLetterType, string> = {
  offer_letter: "hr.offer_letter",
  contract_letter: "hr.contract",
  promotion_letter: "hr.promotion_letter",
  warning_letter: "hr.warning_letter",
};

export interface HrLetterFact {
  label: string;
  value: string;
}

export interface BuildHrLetterResult {
  snapshot: SnapshotBlob;
  documentNumber: string | null;
  documentDate: string | null;
  organizationId: string | null;
  businessId: string | null;
  /** `employees.id` / `candidates.id` when the recipient is on file. */
  partyId: string | null;
  partyKind: "employee" | null;
}

// ── helpers ─────────────────────────────────────────────────────────────

type Row = Record<string, any>;

function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(" ").trim() || "—";
}

function fmtMoney(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount == null) return "—";
  const cur = currency || "";
  return `${cur} ${Number(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`.trim();
}

function isoDate(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function pickOrg(row: Row) {
  return row.business ?? row.organization ?? null;
}

function facts(...rows: Array<HrLetterFact | null | false>): HrLetterFact[] {
  return rows.filter(Boolean) as HrLetterFact[];
}

function shortRef(prefix: string, id: string): string {
  return `${prefix}-${String(id).slice(0, 8).toUpperCase()}`;
}

function recipientFromEmployee(emp: Row) {
  return {
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
  };
}

function envelope(
  type: HrLetterType,
  row: Row,
  parts: Omit<SnapshotBlob, "document_type" | "document_type_label">,
): SnapshotBlob {
  return {
    document_type: type,
    document_type_label: HR_LETTER_LABELS[type],
    organization: pickOrg(row),
    business_id: row.business_id ?? null,
    organization_id: row.organization_id ?? null,
    ...parts,
  };
}

// ── Offer letter ────────────────────────────────────────────────────────

export function buildHrOfferLetterSnapshot(row: Row): BuildHrLetterResult {
  const cand = row.application?.candidate ?? {};
  const jobTitle = row.application?.job?.title ?? null;
  const currency = row.currency ?? null;
  const org = pickOrg(row);
  const name = fullName(cand.first_name, cand.last_name);
  const documentNumber = shortRef("OFFER", row.id);

  const snapshot = envelope("offer_letter", row, {
    document_number: documentNumber,
    issue_date: row.sent_at ?? row.created_at ?? null,
    effective_date: row.start_date ?? null,
    subject: jobTitle
      ? `Offer of Employment — ${jobTitle}`
      : "Offer of Employment",
    salutation: `Dear ${name},`,
    body:
      row.letter_body ||
      "We are pleased to extend to you the following offer of employment. The key terms are summarised above. Please review this letter carefully; a countersigned copy constitutes acceptance.",
    closing: "We look forward to welcoming you to the team.",
    facts: facts(
      jobTitle ? { label: "Position", value: String(jobTitle) } : null,
      row.start_date
        ? { label: "Proposed Start Date", value: String(row.start_date) }
        : null,
      row.base_salary != null
        ? {
            label: "Base Salary (annual)",
            value: fmtMoney(row.base_salary, currency),
          }
        : null,
      row.bonus_target != null
        ? { label: "Bonus Target", value: fmtMoney(row.bonus_target, currency) }
        : null,
      row.expires_at
        ? { label: "Offer Expires", value: String(row.expires_at) }
        : null,
    ),
    notes: row.notes ?? null,
    recipient: { name, email: cand.email ?? null, job_title: jobTitle },
    signatories: [
      {
        name: "Authorised Signatory",
        role: `For and on behalf of ${org?.name ?? "the Company"}`,
      },
      { name, role: "Candidate — acceptance" },
    ],
  });

  return {
    snapshot,
    documentNumber,
    documentDate: isoDate(row.sent_at ?? row.created_at),
    organizationId: row.organization_id ?? null,
    businessId: row.business_id ?? null,
    partyId: null,
    partyKind: null,
  };
}

// ── Contract letter ─────────────────────────────────────────────────────

export function buildHrContractLetterSnapshot(row: Row): BuildHrLetterResult {
  const emp = row.employee ?? {};
  const org = pickOrg(row);
  const name = fullName(emp.first_name, emp.last_name);
  const documentNumber = String(row.contract_reference ?? row.id);

  const snapshot = envelope("contract_letter", row, {
    document_number: documentNumber,
    issue_date: row.approved_at ?? row.created_at ?? null,
    effective_date: row.start_date ?? null,
    subject: `Employment Contract — ${row.name ?? "Terms of Engagement"}`,
    salutation: `Dear ${name},`,
    body:
      row.notes ||
      "This document sets out the terms and conditions of your employment. It supersedes any prior agreement, verbal or written, relating to the subject matter set out herein.",
    facts: facts(
      {
        label: "Contract Reference",
        value: String(row.contract_reference ?? row.name ?? row.id),
      },
      { label: "Start Date", value: String(row.start_date ?? "—") },
      row.end_date ? { label: "End Date", value: String(row.end_date) } : null,
      row.probation_end_date
        ? { label: "Probation Ends", value: String(row.probation_end_date) }
        : null,
      { label: "Base Wage", value: fmtMoney(row.wage, null) },
      row.housing_allowance
        ? {
            label: "Housing Allowance",
            value: fmtMoney(row.housing_allowance, null),
          }
        : null,
      row.transport_allowance
        ? {
            label: "Transport Allowance",
            value: fmtMoney(row.transport_allowance, null),
          }
        : null,
      { label: "Working Schedule", value: String(row.working_schedule ?? "—") },
    ),
    recipient: recipientFromEmployee(emp),
    signatories: [
      {
        name: "Authorised Signatory",
        role: `For and on behalf of ${org?.name ?? "the Company"}`,
      },
      { name, role: "Employee — acceptance" },
    ],
  });

  return {
    snapshot,
    documentNumber,
    documentDate: isoDate(row.approved_at ?? row.created_at),
    organizationId: row.organization_id ?? null,
    businessId: row.business_id ?? null,
    partyId: row.employee_id ?? null,
    partyKind: row.employee_id ? "employee" : null,
  };
}

// ── Lifecycle letters ───────────────────────────────────────────────────

export function buildHrPromotionLetterSnapshot(row: Row): BuildHrLetterResult {
  const emp = row.employee ?? {};
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const newTitle = (payload.new_title ?? payload.title ?? null) as string | null;
  const newSalary = (payload.new_salary ?? payload.salary ?? null) as
    | number
    | null;
  const currency = (payload.currency ?? null) as string | null;
  const org = pickOrg(row);
  const name = fullName(emp.first_name, emp.last_name);
  const documentNumber = shortRef("PROMO", row.id);

  const snapshot = envelope("promotion_letter", row, {
    document_number: documentNumber,
    issue_date: row.occurred_at ?? row.created_at ?? null,
    effective_date: row.effective_date ?? null,
    subject: newTitle ? `Promotion to ${newTitle}` : "Promotion Confirmation",
    salutation: `Dear ${name},`,
    body:
      row.summary ||
      "In recognition of your contribution and continued performance, we are pleased to confirm your promotion effective on the date indicated above. All other terms of your employment remain unchanged unless expressly set out in this letter.",
    closing: "Congratulations on this well-deserved advancement.",
    facts: facts(
      newTitle ? { label: "New Position", value: newTitle } : null,
      row.effective_date
        ? { label: "Effective Date", value: String(row.effective_date) }
        : null,
      newSalary != null
        ? { label: "New Base Salary", value: fmtMoney(newSalary, currency) }
        : null,
    ),
    recipient: recipientFromEmployee(emp),
    signatories: [
      {
        name: row.actor_label ?? "Authorised Signatory",
        role: `For and on behalf of ${org?.name ?? "the Company"}`,
      },
    ],
  });

  return {
    snapshot,
    documentNumber,
    documentDate: isoDate(row.occurred_at ?? row.created_at),
    organizationId: row.organization_id ?? null,
    businessId: row.business_id ?? null,
    partyId: row.employee_id ?? null,
    partyKind: row.employee_id ? "employee" : null,
  };
}

export function buildHrWarningLetterSnapshot(row: Row): BuildHrLetterResult {
  const emp = row.employee ?? {};
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const severity = String(payload.severity ?? payload.level ?? "Formal");
  const reason = (payload.reason ?? null) as string | null;
  const org = pickOrg(row);
  const name = fullName(emp.first_name, emp.last_name);
  const documentNumber = shortRef("WARN", row.id);

  const snapshot = envelope("warning_letter", row, {
    document_number: documentNumber,
    issue_date: row.occurred_at ?? row.created_at ?? null,
    effective_date: row.effective_date ?? null,
    subject: `${severity} Warning`,
    salutation: `Dear ${name},`,
    body:
      row.summary ||
      "This letter serves as a formal record of concern regarding your recent conduct or performance. You are expected to demonstrate immediate and sustained improvement. Failure to do so may result in further disciplinary action, up to and including termination of employment.",
    closing:
      "You have the right to respond to this letter in writing within five (5) working days. A signed copy will be retained on your personnel file.",
    facts: facts(
      { label: "Warning Level", value: severity },
      row.effective_date
        ? { label: "Issued On", value: String(row.effective_date) }
        : null,
      reason ? { label: "Reason", value: String(reason) } : null,
    ),
    recipient: recipientFromEmployee(emp),
    signatories: [
      {
        name: row.actor_label ?? "HR Manager",
        role: `For and on behalf of ${org?.name ?? "the Company"}`,
      },
      { name, role: "Employee — acknowledgement" },
    ],
  });

  return {
    snapshot,
    documentNumber,
    documentDate: isoDate(row.occurred_at ?? row.created_at),
    organizationId: row.organization_id ?? null,
    businessId: row.business_id ?? null,
    partyId: row.employee_id ?? null,
    partyKind: row.employee_id ? "employee" : null,
  };
}

export function buildHrLetterSnapshot(
  type: HrLetterType,
  row: Row,
): BuildHrLetterResult {
  switch (type) {
    case "offer_letter":
      return buildHrOfferLetterSnapshot(row);
    case "contract_letter":
      return buildHrContractLetterSnapshot(row);
    case "promotion_letter":
      return buildHrPromotionLetterSnapshot(row);
    case "warning_letter":
      return buildHrWarningLetterSnapshot(row);
  }
}

// ── Fetchers ────────────────────────────────────────────────────────────

const ORG_JOIN =
  "id, name, logo_url, address, city, state, postal_code, country, phone, email, tax_id";
const BIZ_JOIN =
  "id, name, legal_name, logo_url, address, city, state, postal_code, country, phone, email, tax_id";
const EMPLOYEE_JOIN = `employee:employees(
  id, first_name, last_name, employee_number, email, work_email,
  address_line1, city, state, postal_code, country,
  job_position:job_positions(title),
  department:departments!employees_department_id_fkey(name)
)`;

// deno-lint-ignore-file
type SB = SupabaseClient<any, any, any>;

async function fetchOne(
  supabase: SB,
  table: string,
  select: string,
  id: string,
  label: string,
): Promise<Row> {
  const { data, error } = await (supabase.from(table as never) as any)
    .select(select)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`${label} fetch failed: ${error.message}`);
  if (!data) throw new Error(`${label} not found: ${id}`);
  return data as Row;
}

export async function fetchAndBuildHrLetterSnapshot(
  supabase: SB,
  type: HrLetterType,
  id: string,
): Promise<BuildHrLetterResult> {
  switch (type) {
    case "offer_letter":
      return buildHrOfferLetterSnapshot(
        await fetchOne(
          supabase,
          "offer_letters",
          `*,
           organization:organizations(${ORG_JOIN}),
           business:businesses(${BIZ_JOIN}),
           application:candidate_applications(
             id,
             candidate:candidates(first_name, last_name, email, phone),
             job:job_positions(title)
           )`,
          id,
          "offer_letter",
        ),
      );
    case "contract_letter":
      return buildHrContractLetterSnapshot(
        await fetchOne(
          supabase,
          "employee_contracts",
          `*,
           organization:organizations(${ORG_JOIN}),
           business:businesses(${BIZ_JOIN}),
           ${EMPLOYEE_JOIN}`,
          id,
          "contract_letter",
        ),
      );
    case "promotion_letter":
    case "warning_letter": {
      const row = await fetchOne(
        supabase,
        "employee_lifecycle_events",
        `*,
         organization:organizations(${ORG_JOIN}),
         business:businesses(${BIZ_JOIN}),
         ${EMPLOYEE_JOIN}`,
        id,
        type,
      );
      return type === "promotion_letter"
        ? buildHrPromotionLetterSnapshot(row)
        : buildHrWarningLetterSnapshot(row);
    }
  }
}
