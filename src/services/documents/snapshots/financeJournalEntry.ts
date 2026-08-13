/**
 * Journal Voucher snapshot builder (`finance.journal_entry`).
 *
 * A journal voucher is internal accounting evidence: the auditable paper
 * behind a posting. It is NOT a commercial document — it has no
 * counterparty, no tax ladder and no amount due, which is why the kind is
 * registered without an `email` intent and drawn by its own ledger layout
 * rather than `generateDocumentPdf`.
 *
 * The snapshot freezes everything an auditor needs to reconstruct the
 * posting without re-querying: account code/name per line, the document
 * currency AND the transaction currency amounts, the reversal linkage,
 * and the prepared/approved/posted trail.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface BuildJournalEntrySnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchAndBuildFinanceJournalEntrySnapshot(
  supabase: SupabaseClient,
  journalEntryId: string,
): Promise<BuildJournalEntrySnapshotResult> {
  const client = supabase as unknown as SupabaseClient<never>;

  const { data, error } = await (client as any)
    .from("journal_entries")
    .select(
      `
      id, entry_number, entry_date, description, reference, status,
      currency, exchange_rate, total_debit, total_credit,
      is_adjusting, is_adjusting_entry, is_closing, is_closing_entry,
      is_opening_entry, is_reversal, reversal_of_id, reversed_by_id,
      reversed_at, reversed_reason, source_type, source_subtype,
      journal_book_id, fiscal_period_id,
      created_by, created_at, submitted_by, submitted_at,
      approved_by, approved_at, posted_by, posted_at,
      voided_by, voided_at, void_reason,
      organization_id, business_id, branch_id
      `,
    )
    .eq("id", journalEntryId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildFinanceJournalEntrySnapshot: journal entry ${journalEntryId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }

  const header = data as Record<string, unknown>;

  const { data: lineRows } = await (client as any)
    .from("journal_entry_lines")
    .select(
      `
      id, account_id, description, debit, credit, sort_order,
      original_currency, original_debit, original_credit, exchange_rate,
      contact_id, analytic_account_id
      `,
    )
    .eq("journal_entry_id", journalEntryId);

  const lines = ((lineRows ?? []) as Array<Record<string, unknown>>).sort(
    (a, b) => num(a["sort_order"]) - num(b["sort_order"]),
  );

  const accountIds = [
    ...new Set(lines.map((l) => str(l["account_id"])).filter(Boolean) as string[]),
  ];
  const contactIds = [
    ...new Set(lines.map((l) => str(l["contact_id"])).filter(Boolean) as string[]),
  ];
  const analyticIds = [
    ...new Set(lines.map((l) => str(l["analytic_account_id"])).filter(Boolean) as string[]),
  ];
  // `profiles.id` is a surrogate PK; the auth user id lives in `user_id`.
  const actorIds = [
    ...new Set(
      ["created_by", "submitted_by", "approved_by", "posted_by", "voided_by"]
        .map((k) => str(header[k]))
        .filter(Boolean) as string[],
    ),
  ];

  const [accountsRes, contactsRes, analyticRes, profilesRes, businessRes, relatedRes] =
    await Promise.all([
      accountIds.length
        ? (client as any).from("accounts").select("id, code, name").in("id", accountIds)
        : Promise.resolve({ data: [] }),
      contactIds.length
        ? (client as any).from("contacts").select("id, name").in("id", contactIds)
        : Promise.resolve({ data: [] }),
      analyticIds.length
        ? (client as any).from("analytic_accounts").select("id, name").in("id", analyticIds)
        : Promise.resolve({ data: [] }),
      actorIds.length
        ? (client as any)
            .from("profiles")
            .select("user_id, full_name, email")
            .in("user_id", actorIds)
        : Promise.resolve({ data: [] }),
      header["business_id"]
        ? (client as any)
            .from("businesses")
            .select("name, base_currency")
            .eq("id", header["business_id"] as string)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      (client as any)
        .from("journal_entries")
        .select("id, entry_number")
        .in(
          "id",
          [str(header["reversal_of_id"]), str(header["reversed_by_id"])].filter(
            Boolean,
          ) as string[],
        ),
    ]);

  const accountMap = new Map<string, { code: string | null; name: string | null }>();
  for (const a of (accountsRes?.data ?? []) as Array<Record<string, unknown>>) {
    accountMap.set(String(a["id"]), { code: str(a["code"]), name: str(a["name"]) });
  }
  const contactMap = new Map<string, string | null>();
  for (const c of (contactsRes?.data ?? []) as Array<Record<string, unknown>>) {
    contactMap.set(String(c["id"]), str(c["name"]));
  }
  const analyticMap = new Map<string, string | null>();
  for (const a of (analyticRes?.data ?? []) as Array<Record<string, unknown>>) {
    analyticMap.set(String(a["id"]), str(a["name"]));
  }
  const actorMap = new Map<string, string | null>();
  for (const p of (profilesRes?.data ?? []) as Array<Record<string, unknown>>) {
    actorMap.set(String(p["user_id"]), str(p["full_name"]) ?? str(p["email"]));
  }
  const relatedMap = new Map<string, string | null>();
  for (const r of (relatedRes?.data ?? []) as Array<Record<string, unknown>>) {
    relatedMap.set(String(r["id"]), str(r["entry_number"]));
  }

  const business = (businessRes?.data ?? null) as Record<string, unknown> | null;
  const currency =
    str(header["currency"]) ?? str(business?.["base_currency"]) ?? "USD";

  const entryDate = String(header["entry_date"]).slice(0, 10);

  // Totals are server-owned rollups on the header; the voucher reports
  // them as booked and never recomputes the posting.
  const totalDebit = num(header["total_debit"]);
  const totalCredit = num(header["total_credit"]);

  const snapshotLines = lines.map((l, idx) => {
    const acct = accountMap.get(str(l["account_id"]) ?? "") ?? { code: null, name: null };
    const txnCurrency = str(l["original_currency"]);
    return {
      line: idx + 1,
      account_code: acct.code,
      account_name: acct.name,
      description: str(l["description"]),
      debit: num(l["debit"]),
      credit: num(l["credit"]),
      partner_name: contactMap.get(str(l["contact_id"]) ?? "") ?? null,
      analytic_account_name: analyticMap.get(str(l["analytic_account_id"]) ?? "") ?? null,
      // Transaction-currency amounts are printed only when the line was
      // actually booked in a currency other than the entry currency.
      transaction_currency: txnCurrency && txnCurrency !== currency ? txnCurrency : null,
      transaction_debit:
        txnCurrency && txnCurrency !== currency ? num(l["original_debit"]) : null,
      transaction_credit:
        txnCurrency && txnCurrency !== currency ? num(l["original_credit"]) : null,
      exchange_rate: l["exchange_rate"] === null || l["exchange_rate"] === undefined
        ? null
        : num(l["exchange_rate"]),
    };
  });

  const flags = [
    header["is_adjusting"] || header["is_adjusting_entry"] ? "Adjusting" : null,
    header["is_closing"] || header["is_closing_entry"] ? "Closing" : null,
    header["is_opening_entry"] ? "Opening" : null,
    header["is_reversal"] ? "Reversal" : null,
  ].filter(Boolean) as string[];

  const auditTrail = [
    { event: "Prepared", actor: actorMap.get(str(header["created_by"]) ?? "") ?? null, at: str(header["created_at"]) },
    { event: "Submitted", actor: actorMap.get(str(header["submitted_by"]) ?? "") ?? null, at: str(header["submitted_at"]) },
    { event: "Approved", actor: actorMap.get(str(header["approved_by"]) ?? "") ?? null, at: str(header["approved_at"]) },
    { event: "Posted", actor: actorMap.get(str(header["posted_by"]) ?? "") ?? null, at: str(header["posted_at"]) },
    { event: "Reversed", actor: null, at: str(header["reversed_at"]) },
    { event: "Voided", actor: actorMap.get(str(header["voided_by"]) ?? "") ?? null, at: str(header["voided_at"]) },
  ].filter((e) => Boolean(e.at));

  const snapshot: SnapshotBlob = {
    document_type: "journal_entry",
    document_type_label: "JOURNAL VOUCHER",
    document_number: String(header["entry_number"]),
    status: str(header["status"]),
    // Anything not yet posted is a proposal, not evidence of a posting.
    is_draft: str(header["status"]) !== "posted" && str(header["status"]) !== "reversed",
    issue_date: entryDate,
    posting_date: entryDate,
    description: str(header["description"]),
    reference: str(header["reference"]),
    source: str(header["source_type"]),
    source_detail: str(header["source_subtype"]),
    flags,
    currency,
    exchange_rate:
      header["exchange_rate"] === null || header["exchange_rate"] === undefined
        ? null
        : num(header["exchange_rate"]),
    base_currency: str(business?.["base_currency"]),
    total_debit: totalDebit,
    total_credit: totalCredit,
    // Printed so a reader can see the control passed at print time.
    is_balanced: Math.abs(totalDebit - totalCredit) < 0.005,
    reversal_of_number: relatedMap.get(str(header["reversal_of_id"]) ?? "") ?? null,
    reversed_by_number: relatedMap.get(str(header["reversed_by_id"]) ?? "") ?? null,
    reversal_reason: str(header["reversed_reason"]),
    void_reason: str(header["void_reason"]),
    business_name: str(business?.["name"]),
    business_id: (header["business_id"] as string | null) ?? null,
    organization_id: String(header["organization_id"]),
    branch_id: (header["branch_id"] as string | null) ?? null,
    lines: snapshotLines,
    audit_trail: auditTrail,
  };

  return {
    snapshot,
    documentNumber: String(header["entry_number"]),
    documentDate: entryDate,
    organizationId: String(header["organization_id"]),
    businessId: (header["business_id"] as string | null) ?? null,
    branchId: (header["branch_id"] as string | null) ?? null,
    currency,
    sourceDocId: String(header["id"]),
  };
}

export default fetchAndBuildFinanceJournalEntrySnapshot;