/**
 * Lending document snapshot builders (`lending.*`).
 *
 * Four artefacts, one fetch spine:
 *   - `lending.loan_agreement`     — the contract the client signs.
 *   - `lending.repayment_schedule` — the installment plan handed over.
 *   - `lending.loan_statement`     — the account history + derived balances.
 *   - `lending.payment_receipt`    — evidence of one collected payment.
 *
 * Every money figure is read from server-owned state (`mf_loans`,
 * `mf_loan_schedule`, `mf_loan_balances`, `mf_repayments`,
 * `mf_repayment_allocations`). Nothing here computes interest, arrears or
 * allocations — the client is a projector, never an authority.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface BuildLendingSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
}

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyClient = any;

interface LoanContext {
  loan: Row;
  client: Row | null;
  product: Row | null;
  business: Row | null;
  branchName: string | null;
  officerName: string | null;
  balances: Row | null;
  schedule: Row[];
  disbursement: Row | null;
}

async function loadLoanContext(
  supabase: SupabaseClient,
  loanId: string,
): Promise<LoanContext> {
  const db = supabase as unknown as AnyClient;

  const { data: loan, error } = await db
    .from("mf_loans")
    .select("*")
    .eq("id", loanId)
    .single();
  if (error || !loan) {
    throw new Error(
      `lending snapshot: loan ${loanId} not found: ${error?.message ?? "no row"}`,
    );
  }
  const l = loan as Row;

  const [
    clientRes,
    productRes,
    businessRes,
    branchRes,
    officerRes,
    balRes,
    schedRes,
    disbRes,
  ] = await Promise.all([
      l["client_id"]
        ? db.from("mf_clients").select("*").eq("id", l["client_id"] as string).maybeSingle()
        : Promise.resolve({ data: null }),
      l["product_id"]
        ? db
            .from("mf_loan_products")
            .select("id, code, name")
            .eq("id", l["product_id"] as string)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      db
        .from("businesses")
        .select("id, organization_id, name, legal_name, base_currency, address, city, country, phone, email, logo_url, tax_id, registration_number")
        .eq("id", l["business_id"] as string)
        .maybeSingle(),
      l["branch_id"]
        ? db.from("branches").select("id, name").eq("id", l["branch_id"] as string).maybeSingle()
        : Promise.resolve({ data: null }),
      l["loan_officer_id"]
        ? db
            .from("profiles")
            .select("user_id, full_name, email")
            .eq("user_id", l["loan_officer_id"] as string)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      db.from("mf_loan_balances").select("*").eq("loan_id", loanId).maybeSingle(),
      db
        .from("mf_loan_schedule_display")
        .select("*")
        .eq("loan_id", loanId)
        .order("installment_no", { ascending: true }),

      db
        .from("mf_loan_disbursements")
        .select("*")
        .eq("loan_id", loanId)
        .is("reversed_at", null)
        .maybeSingle(),
    ]);

  const officer = (officerRes?.data ?? null) as Row | null;

  return {
    loan: l,
    client: (clientRes?.data ?? null) as Row | null,
    product: (productRes?.data ?? null) as Row | null,
    business: (businessRes?.data ?? null) as Row | null,
    branchName: str((branchRes?.data as Row | null)?.["name"]),
    officerName: officer ? (str(officer["full_name"]) ?? str(officer["email"])) : null,
    balances: (balRes?.data ?? null) as Row | null,
    schedule: ((schedRes?.data ?? []) as Row[]),
    disbursement: (disbRes?.data ?? null) as Row | null,
  };
}

function partyBlock(ctx: LoanContext): Record<string, unknown> {
  const c = ctx.client;
  const b = ctx.business;
  return {
    business_name: str(b?.["name"]),
    business_legal_name: str(b?.["legal_name"]),
    business_address: [str(b?.["address"]), str(b?.["city"]), str(b?.["country"])]
      .filter(Boolean)
      .join(", ") || null,
    business_phone: str(b?.["phone"]),
    business_email: str(b?.["email"]),
    business_registration: str(b?.["registration_number"]),
    business_tax_id: str(b?.["tax_id"]),
    branch_name: ctx.branchName,
    officer_name: ctx.officerName,
    client_name: str(c?.["full_name"]),
    client_number: str(c?.["client_number"]),
    client_national_id: str(c?.["national_id"]),
    client_phone: str(c?.["phone"]),
    client_address: str(c?.["physical_address"]),
    client_business: str(c?.["business_type"]),
  };
}

function termsBlock(ctx: LoanContext): Record<string, unknown> {
  const l = ctx.loan;
  return {
    loan_number: str(l["loan_number"]),
    product_name: str(ctx.product?.["name"]),
    product_code: str(ctx.product?.["code"]),
    principal: num(l["principal"]),
    term_installments: num(l["term_installments"]),
    repayment_frequency: str(l["repayment_frequency"]),
    interest_method: str(l["interest_method"]),
    interest_rate: num(l["interest_rate"]),
    interest_rate_period: str(l["interest_rate_period"]),
    grace_period_installments: num(l["grace_period_installments"]),
    penalty_rate: num(l["penalty_rate"]),
    penalty_basis: str(l["penalty_basis"]),
    fees: (l["fees"] as unknown) ?? null,
    // Actual disbursement economics, server-recorded (never computed here).
    fees_deducted: ctx.disbursement ? num(ctx.disbursement["fees_deducted"]) : null,
    net_amount: ctx.disbursement ? num(ctx.disbursement["net_amount"]) : null,
    fee_breakdown: (ctx.disbursement?.["fee_breakdown"] as unknown) ?? null,
    disbursement_method: ctx.disbursement ? str(ctx.disbursement["method"]) : null,
    disbursement_reference: ctx.disbursement ? str(ctx.disbursement["reference"]) : null,
    expected_disbursement_date: str(l["expected_disbursement_date"]),
    first_installment_date: str(l["first_installment_date"]),
    disbursed_at: str(l["disbursed_at"]),
    status: str(l["status"]),
    lineage_kind: str(l["lineage_kind"]),
  };
}

function scheduleRows(ctx: LoanContext): Array<Record<string, unknown>> {
  return ctx.schedule.map((s) => ({
    installment_no: num(s["installment_no"]),
    due_date: str(s["due_date"]),
    opening_balance: num(s["opening_balance"]),
    principal_due: num(s["principal_due"]),
    interest_due: num(s["interest_due"]),
    fees_due: num(s["fees_due"]),
    total_due: num(s["total_due"]),
    closing_balance: num(s["closing_balance"]),
    is_grace: s["is_grace"] === true,
  }));
}

function scheduleTotals(rows: Array<Record<string, unknown>>) {
  return {
    principal: rows.reduce((a, r) => a + num(r["principal_due"]), 0),
    interest: rows.reduce((a, r) => a + num(r["interest_due"]), 0),
    fees: rows.reduce((a, r) => a + num(r["fees_due"]), 0),
    total: rows.reduce((a, r) => a + num(r["total_due"]), 0),
  };
}

function result(
  ctx: LoanContext,
  snapshot: SnapshotBlob,
  documentNumber: string,
  documentDate: string,
): BuildLendingSnapshotResult {
  const organizationId = str(ctx.business?.["organization_id"]);
  if (!organizationId) {
    throw new Error("lending snapshot: business has no organization_id");
  }
  return {
    snapshot,
    documentNumber,
    documentDate,
    organizationId,
    businessId: str(ctx.loan["business_id"]),
    branchId: str(ctx.loan["branch_id"]),
    currency: str(ctx.loan["currency_code"]) ?? str(ctx.business?.["base_currency"]) ?? "KES",
    sourceDocId: String(ctx.loan["id"]),
  };
}

function commonHead(ctx: LoanContext): Record<string, unknown> {
  return {
    currency: str(ctx.loan["currency_code"]) ?? str(ctx.business?.["base_currency"]) ?? "KES",
    business_id: str(ctx.loan["business_id"]),
    organization_id: str(ctx.business?.["organization_id"]),
    branch_id: str(ctx.loan["branch_id"]),
    ...partyBlock(ctx),
    ...termsBlock(ctx),
  };
}

/* ------------------------------------------------------------------ */
/* Loan agreement                                                      */
/* ------------------------------------------------------------------ */

export async function fetchAndBuildLoanAgreementSnapshot(
  supabase: SupabaseClient,
  loanId: string,
): Promise<BuildLendingSnapshotResult> {
  const ctx = await loadLoanContext(supabase, loanId);
  const rows = scheduleRows(ctx);
  const totals = scheduleTotals(rows);
  const number = str(ctx.loan["loan_number"]) ?? loanId.slice(0, 8);
  const date =
    str(ctx.loan["disbursed_at"])?.slice(0, 10) ??
    str(ctx.loan["expected_disbursement_date"]) ??
    today();

  const snapshot: SnapshotBlob = {
    document_type: "loan_agreement",
    document_type_label: "LOAN AGREEMENT",
    document_number: number,
    issue_date: date,
    ...commonHead(ctx),
    schedule: rows,
    schedule_totals: totals,
    total_repayable: totals.total,
  };

  return result(ctx, snapshot, number, date);
}

/* ------------------------------------------------------------------ */
/* Repayment schedule                                                  */
/* ------------------------------------------------------------------ */

export async function fetchAndBuildRepaymentScheduleSnapshot(
  supabase: SupabaseClient,
  loanId: string,
): Promise<BuildLendingSnapshotResult> {
  const ctx = await loadLoanContext(supabase, loanId);
  const rows = scheduleRows(ctx);
  const totals = scheduleTotals(rows);
  const number = str(ctx.loan["loan_number"]) ?? loanId.slice(0, 8);
  const date = today();

  const snapshot: SnapshotBlob = {
    document_type: "repayment_schedule",
    document_type_label: "REPAYMENT SCHEDULE",
    document_number: number,
    issue_date: date,
    ...commonHead(ctx),
    schedule: rows,
    schedule_totals: totals,
    next_due_date: str(ctx.balances?.["next_due_date"]),
    total_outstanding: num(ctx.balances?.["total_outstanding"]),
  };

  return result(ctx, snapshot, number, date);
}

/* ------------------------------------------------------------------ */
/* Loan statement                                                      */
/* ------------------------------------------------------------------ */

export async function fetchAndBuildLoanStatementSnapshot(
  supabase: SupabaseClient,
  loanId: string,
): Promise<BuildLendingSnapshotResult> {
  const db = supabase as unknown as AnyClient;
  const ctx = await loadLoanContext(supabase, loanId);

  const { data: repaymentRows } = await db
    .from("mf_repayments")
    .select("id, receipt_number, paid_on, amount, method, reference, status")
    .eq("loan_id", loanId)
    .order("paid_on", { ascending: true });
  const repayments = ((repaymentRows ?? []) as Row[]);

  const { data: allocRows } = repayments.length
    ? await db
        .from("mf_repayment_allocations")
        .select("repayment_id, component, amount")
        .in("repayment_id", repayments.map((r) => String(r["id"])))
    : { data: [] as Row[] };

  const byRepayment = new Map<string, Record<string, number>>();
  for (const a of (allocRows ?? []) as Row[]) {
    const key = String(a["repayment_id"]);
    const bucket = byRepayment.get(key) ?? {};
    const component = str(a["component"]) ?? "other";
    bucket[component] = (bucket[component] ?? 0) + num(a["amount"]);
    byRepayment.set(key, bucket);
  }

  const transactions = [
    ...(str(ctx.loan["disbursed_at"])
      ? [
          {
            date: String(ctx.loan["disbursed_at"]).slice(0, 10),
            reference: str(ctx.loan["loan_number"]),
            description: "Loan disbursed",
            principal: num(ctx.loan["principal"]),
            interest: 0,
            fees: 0,
            penalty: 0,
            amount: num(ctx.loan["principal"]),
            kind: "disbursement",
          },
        ]
      : []),
    ...repayments.map((r) => {
      const alloc = byRepayment.get(String(r["id"])) ?? {};
      return {
        date: str(r["paid_on"]),
        reference: str(r["receipt_number"]),
        description:
          str(r["status"]) === "reversed" ? "Repayment (reversed)" : "Repayment received",
        principal: alloc["principal"] ?? 0,
        interest: alloc["interest"] ?? 0,
        fees: alloc["fees"] ?? 0,
        penalty: alloc["penalty"] ?? 0,
        amount: num(r["amount"]),
        kind: str(r["status"]) === "reversed" ? "reversal" : "repayment",
      };
    }),
  ];

  const number = str(ctx.loan["loan_number"]) ?? loanId.slice(0, 8);
  const date = today();

  const snapshot: SnapshotBlob = {
    document_type: "loan_statement",
    document_type_label: "LOAN STATEMENT",
    document_number: number,
    issue_date: date,
    ...commonHead(ctx),
    transactions,
    schedule: scheduleRows(ctx),
    principal_outstanding: num(ctx.balances?.["principal_outstanding"]),
    interest_outstanding: num(ctx.balances?.["interest_outstanding"]),
    fees_outstanding: num(ctx.balances?.["fees_outstanding"]),
    total_outstanding: num(ctx.balances?.["total_outstanding"]),
    total_contractual: num(ctx.balances?.["total_contractual"]),
    amount_overdue: num(ctx.balances?.["amount_overdue"]),
    days_past_due: num(ctx.balances?.["days_past_due"]),
    next_due_date: str(ctx.balances?.["next_due_date"]),
    total_collected: repayments
      .filter((r) => str(r["status"]) !== "reversed")
      .reduce((a, r) => a + num(r["amount"]), 0),
  };

  return result(ctx, snapshot, number, date);
}

/* ------------------------------------------------------------------ */
/* Payment receipt                                                     */
/* ------------------------------------------------------------------ */

export async function fetchAndBuildLoanPaymentReceiptSnapshot(
  supabase: SupabaseClient,
  repaymentId: string,
): Promise<BuildLendingSnapshotResult> {
  const db = supabase as unknown as AnyClient;

  const { data: repayment, error } = await db
    .from("mf_repayments")
    .select("*")
    .eq("id", repaymentId)
    .single();
  if (error || !repayment) {
    throw new Error(
      `lending snapshot: repayment ${repaymentId} not found: ${error?.message ?? "no row"}`,
    );
  }
  const r = repayment as Row;

  const ctx = await loadLoanContext(supabase, String(r["loan_id"]));

  const [{ data: allocRows }, { data: receivedBy }] = await Promise.all([
    db
      .from("mf_repayment_allocations")
      .select("installment_no, component, amount")
      .eq("repayment_id", repaymentId),
    r["received_by"]
      ? db
          .from("profiles")
          .select("user_id, full_name, email")
          .eq("user_id", r["received_by"] as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const allocations = ((allocRows ?? []) as Row[]).map((a) => ({
    installment_no: a["installment_no"] === null ? null : num(a["installment_no"]),
    component: str(a["component"]),
    amount: num(a["amount"]),
  }));

  const receiver = (receivedBy ?? null) as Row | null;
  const number = str(r["receipt_number"]) ?? repaymentId.slice(0, 8);
  const date = str(r["paid_on"]) ?? today();

  const snapshot: SnapshotBlob = {
    document_type: "loan_payment_receipt",
    document_type_label: "PAYMENT RECEIPT",
    document_number: number,
    issue_date: date,
    ...commonHead(ctx),
    receipt_number: number,
    paid_on: date,
    amount: num(r["amount"]),
    method: str(r["method"]),
    payment_reference: str(r["reference"]),
    receipt_status: str(r["status"]),
    reversal_reason: str(r["reversal_reason"]),
    received_by_name: receiver ? (str(receiver["full_name"]) ?? str(receiver["email"])) : null,
    notes: str(r["notes"]),
    allocations,
    principal_outstanding: num(ctx.balances?.["principal_outstanding"]),
    interest_outstanding: num(ctx.balances?.["interest_outstanding"]),
    total_outstanding: num(ctx.balances?.["total_outstanding"]),
    next_due_date: str(ctx.balances?.["next_due_date"]),
  };

  const base = result(ctx, snapshot, number, date);
  return { ...base, sourceDocId: repaymentId, branchId: str(r["branch_id"]) ?? base.branchId };
}

/* ------------------------------------------------------------------ */
/* Client charge receipt (admission fee)                               */
/* ------------------------------------------------------------------ */

/**
 * `lending.payment_receipt` for a client-level charge (no loan). Read from
 * `mf_client_charges`; the amount, status and receipt number are server-set.
 */
export async function fetchAndBuildClientChargeReceiptSnapshot(
  supabase: SupabaseClient,
  chargeId: string,
): Promise<BuildLendingSnapshotResult> {
  const db = supabase as unknown as AnyClient;

  const { data: charge, error } = await db
    .from("mf_client_charges")
    .select("*")
    .eq("id", chargeId)
    .single();
  if (error || !charge) {
    throw new Error(
      `lending snapshot: client charge ${chargeId} not found: ${error?.message ?? "no row"}`,
    );
  }
  const ch = charge as Row;

  const [clientRes, businessRes, branchRes, receiverRes] = await Promise.all([
    db.from("mf_clients").select("*").eq("id", ch["client_id"] as string).maybeSingle(),
    db
      .from("businesses")
      .select(
        "id, organization_id, name, legal_name, base_currency, address, city, country, phone, email, logo_url, tax_id, registration_number",
      )
      .eq("id", ch["business_id"] as string)
      .maybeSingle(),
    ch["branch_id"]
      ? db.from("branches").select("id, name").eq("id", ch["branch_id"] as string).maybeSingle()
      : Promise.resolve({ data: null }),
    ch["created_by"]
      ? db
          .from("profiles")
          .select("user_id, full_name, email")
          .eq("user_id", ch["created_by"] as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const c = (clientRes?.data ?? null) as Row | null;
  const business = (businessRes?.data ?? null) as Row | null;
  const receiver = (receiverRes?.data ?? null) as Row | null;
  const organizationId = str(business?.["organization_id"]);
  if (!organizationId) {
    throw new Error("lending snapshot: business has no organization_id");
  }

  const currency = str(ch["currency_code"]) ?? str(business?.["base_currency"]) ?? "KES";
  const number = str(ch["receipt_number"]) ?? chargeId.slice(0, 8);
  const date = str(ch["paid_on"]) ?? str(ch["charged_on"]) ?? today();
  const kindLabel = String(ch["kind"] ?? "charge").replace(/_/g, " ");

  const snapshot: SnapshotBlob = {
    document_type: "loan_payment_receipt",
    document_type_label: "PAYMENT RECEIPT",
    document_number: number,
    issue_date: date,
    currency,
    business_id: str(ch["business_id"]),
    organization_id: organizationId,
    branch_id: str(ch["branch_id"]),
    business_name: str(business?.["name"]),
    business_legal_name: str(business?.["legal_name"]),
    business_address:
      [str(business?.["address"]), str(business?.["city"]), str(business?.["country"])]
        .filter(Boolean)
        .join(", ") || null,
    business_phone: str(business?.["phone"]),
    business_email: str(business?.["email"]),
    business_registration: str(business?.["registration_number"]),
    business_tax_id: str(business?.["tax_id"]),
    branch_name: str((branchRes?.data as Row | null)?.["name"]),
    officer_name: null,
    client_name: str(c?.["full_name"]),
    client_number: str(c?.["client_number"]),
    client_national_id: str(c?.["national_id"]),
    client_phone: str(c?.["phone"]),
    client_address: str(c?.["physical_address"]),
    loan_number: null,
    product_name: kindLabel,
    receipt_number: number,
    paid_on: date,
    amount: num(ch["amount"]),
    method: str(ch["method"]),
    payment_reference: str(ch["reference"]),
    receipt_status: str(ch["status"]),
    reversal_reason: str(ch["reversal_reason"]),
    received_by_name: receiver ? (str(receiver["full_name"]) ?? str(receiver["email"])) : null,
    notes: str(ch["notes"]),
    allocations: [{ installment_no: null, component: kindLabel, amount: num(ch["amount"]) }],
    principal_outstanding: 0,
    interest_outstanding: 0,
    total_outstanding: 0,
    next_due_date: null,
  };

  return {
    snapshot,
    documentNumber: number,
    documentDate: date,
    organizationId,
    businessId: str(ch["business_id"]),
    branchId: str(ch["branch_id"]),
    currency,
    sourceDocId: chargeId,
  };
}

/* ------------------------------------------------------------------ */
/* Client statement                                                    */
/* ------------------------------------------------------------------ */

/**
 * `lending.client_statement` — one client, every loan, every money movement.
 * Entries come from the server-owned `mf_client_statement` view and the
 * per-loan positions from `mf_loan_balances`. Nothing is computed here beyond
 * printing the rows the ledger handed over.
 */
export async function fetchAndBuildClientStatementSnapshot(
  supabase: SupabaseClient,
  clientId: string,
): Promise<BuildLendingSnapshotResult> {
  const db = supabase as unknown as AnyClient;

  const { data: client, error } = await db
    .from("mf_clients")
    .select("*")
    .eq("id", clientId)
    .single();
  if (error || !client) {
    throw new Error(
      `lending snapshot: client ${clientId} not found: ${error?.message ?? "no row"}`,
    );
  }
  const c = client as Row;

  const [businessRes, branchRes, officerRes, entriesRes, balancesRes] = await Promise.all([
    db
      .from("businesses")
      .select(
        "id, organization_id, name, legal_name, base_currency, address, city, country, phone, email, logo_url, tax_id, registration_number",
      )
      .eq("id", c["business_id"] as string)
      .maybeSingle(),
    c["branch_id"]
      ? db.from("branches").select("id, name").eq("id", c["branch_id"] as string).maybeSingle()
      : Promise.resolve({ data: null }),
    c["loan_officer_id"]
      ? db
          .from("profiles")
          .select("user_id, full_name, email")
          .eq("user_id", c["loan_officer_id"] as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    db
      .from("mf_client_statement")
      .select("*")
      .eq("client_id", clientId)
      .order("entry_date", { ascending: true }),
    db.from("mf_loan_balances").select("*").eq("client_id", clientId),
  ]);

  const business = (businessRes?.data ?? null) as Row | null;
  const officer = (officerRes?.data ?? null) as Row | null;
  const entries = ((entriesRes?.data ?? []) as Row[]);
  const balances = ((balancesRes?.data ?? []) as Row[]);

  const organizationId = str(business?.["organization_id"]);
  if (!organizationId) {
    throw new Error("lending snapshot: business has no organization_id");
  }

  const currency =
    str(entries[0]?.["currency_code"]) ?? str(business?.["base_currency"]) ?? "KES";

  const totals = balances.reduce<{
    principal_outstanding: number;
    interest_outstanding: number;
    fees_outstanding: number;
    total_outstanding: number;
    total_collected: number;
  }>(
    (acc, b) => ({
      principal_outstanding: acc.principal_outstanding + num(b["principal_outstanding"]),
      interest_outstanding: acc.interest_outstanding + num(b["interest_outstanding"]),
      fees_outstanding: acc.fees_outstanding + num(b["fees_outstanding"]),
      total_outstanding: acc.total_outstanding + num(b["total_outstanding"]),
      total_collected: acc.total_collected + num(b["total_collected"]),
    }),
    {
      principal_outstanding: 0,
      interest_outstanding: 0,
      fees_outstanding: 0,
      total_outstanding: 0,
      total_collected: 0,
    },
  );


  const date = today();
  const number = str(c["client_number"]) ?? clientId.slice(0, 8);

  const snapshot: SnapshotBlob = {
    document_type: "client_statement",
    document_type_label: "CLIENT STATEMENT",
    document_number: number,
    issue_date: date,
    currency,
    business_id: str(c["business_id"]),
    organization_id: organizationId,
    branch_id: str(c["branch_id"]),
    business_name: str(business?.["name"]),
    business_legal_name: str(business?.["legal_name"]),
    business_address:
      [str(business?.["address"]), str(business?.["city"]), str(business?.["country"])]
        .filter(Boolean)
        .join(", ") || null,
    business_phone: str(business?.["phone"]),
    business_email: str(business?.["email"]),
    business_registration: str(business?.["registration_number"]),
    business_tax_id: str(business?.["tax_id"]),
    branch_name: str((branchRes?.data as Row | null)?.["name"]),
    officer_name: officer ? (str(officer["full_name"]) ?? str(officer["email"])) : null,
    client_name: str(c["full_name"]),
    client_number: str(c["client_number"]),
    client_national_id: str(c["national_id"]),
    client_phone: str(c["phone"]),
    client_address: str(c["physical_address"]),
    client_status: str(c["status"]),
    entries: entries.map((e) => ({
      date: str(e["entry_date"]),
      loan_number: str(e["loan_number"]),
      entry_type: str(e["entry_type"]),
      description: str(e["description"]),
      reference: str(e["reference"]),
      method: str(e["method"]),
      amount_in: num(e["amount_in"]),
      amount_out: num(e["amount_out"]),
    })),
    loans: balances.map((b) => ({
      loan_number: str(b["loan_number"]),
      status: str(b["status"]),
      principal_outstanding: num(b["principal_outstanding"]),
      interest_outstanding: num(b["interest_outstanding"]),
      fees_outstanding: num(b["fees_outstanding"]),
      total_outstanding: num(b["total_outstanding"]),
      total_collected: num(b["total_collected"]),
    })),
    ...totals,
  };

  return {
    snapshot,
    documentNumber: number,
    documentDate: date,
    organizationId,
    businessId: str(c["business_id"]),
    branchId: str(c["branch_id"]),
    currency,
    sourceDocId: clientId,
  };
}

/* ------------------------------------------------------------------ */
/* Group fee collection receipt                                        */
/* ------------------------------------------------------------------ */

/**
 * `lending.payment_receipt` for one group admission-fee collection.
 *
 * The group is only the cash hand-over context: the receipt therefore shows
 * the collection total once and lists the individual members it settled, with
 * the amount allocated to each. All figures are server-owned rows from
 * `mf_fee_collections` and `mf_client_charge_payments`.
 */
export async function fetchAndBuildFeeCollectionReceiptSnapshot(
  supabase: SupabaseClient,
  collectionId: string,
): Promise<BuildLendingSnapshotResult> {
  const db = supabase as unknown as AnyClient;

  const { data: collection, error } = await db
    .from("mf_fee_collections")
    .select("*")
    .eq("id", collectionId)
    .single();
  if (error || !collection) {
    throw new Error(
      `lending snapshot: fee collection ${collectionId} not found: ${error?.message ?? "no row"}`,
    );
  }
  const col = collection as Row;

  const [payRes, groupRes, businessRes, branchRes, collectorRes] = await Promise.all([
    db
      .from("mf_client_charge_payments")
      .select("client_id, amount, receipt_number, status, paid_on")
      .eq("collection_id", collectionId),
    db.from("mf_groups").select("id, name, group_number").eq("id", col["group_id"] as string).maybeSingle(),
    db
      .from("businesses")
      .select(
        "id, organization_id, name, legal_name, base_currency, address, city, country, phone, email, logo_url, tax_id, registration_number",
      )
      .eq("id", col["business_id"] as string)
      .maybeSingle(),
    col["branch_id"]
      ? db.from("branches").select("id, name").eq("id", col["branch_id"] as string).maybeSingle()
      : Promise.resolve({ data: null }),
    col["collected_by"]
      ? db
          .from("profiles")
          .select("user_id, full_name, email")
          .eq("user_id", col["collected_by"] as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const payments = ((payRes?.data ?? []) as Row[]).filter((p) => p["status"] !== "reversed");
  const clientIds = payments.map((p) => String(p["client_id"]));
  const clientsRes = clientIds.length
    ? await db.from("mf_clients").select("id, full_name, client_number").in("id", clientIds)
    : { data: [] };
  const clientById = new Map<string, Row>(
    ((clientsRes?.data ?? []) as Row[]).map((c) => [String(c["id"]), c]),
  );

  const business = (businessRes?.data ?? null) as Row | null;
  const group = (groupRes?.data ?? null) as Row | null;
  const collector = (collectorRes?.data ?? null) as Row | null;
  const organizationId = str(business?.["organization_id"]);
  if (!organizationId) {
    throw new Error("lending snapshot: business has no organization_id");
  }

  const currency = str(col["currency_code"]) ?? str(business?.["base_currency"]) ?? "KES";
  const number = str(col["collection_number"]) ?? collectionId.slice(0, 8);
  const date = str(col["collected_on"]) ?? today();

  const allocations = payments.map((p) => {
    const c = clientById.get(String(p["client_id"])) ?? null;
    const label = c
      ? `${str(c["full_name"]) ?? ""}${c["client_number"] ? ` (${String(c["client_number"])})` : ""}`
      : String(p["client_id"]);
    return {
      installment_no: null,
      component: `Admission fee - ${label}`,
      amount: num(p["amount"]),
    };
  });

  const snapshot: SnapshotBlob = {
    document_type: "loan_payment_receipt",
    document_type_label: "GROUP FEE COLLECTION RECEIPT",
    document_number: number,
    issue_date: date,
    currency,
    business_id: str(col["business_id"]),
    organization_id: organizationId,
    branch_id: str(col["branch_id"]),
    business_name: str(business?.["name"]),
    business_legal_name: str(business?.["legal_name"]),
    business_address:
      [str(business?.["address"]), str(business?.["city"]), str(business?.["country"])]
        .filter(Boolean)
        .join(", ") || null,
    business_phone: str(business?.["phone"]),
    business_email: str(business?.["email"]),
    business_registration: str(business?.["registration_number"]),
    business_tax_id: str(business?.["tax_id"]),
    branch_name: str((branchRes?.data as Row | null)?.["name"]),
    officer_name: collector ? (str(collector["full_name"]) ?? str(collector["email"])) : null,
    client_name: str(group?.["name"]) ?? "Group collection",
    client_number: str(group?.["group_number"]),
    client_national_id: null,
    client_phone: null,
    client_address: null,
    loan_number: null,
    product_name: "Admission fee",
    receipt_number: number,
    paid_on: date,
    amount: num(col["total_amount"]),
    method: str(col["method"]),
    payment_reference: str(col["reference"]),
    receipt_status: str(col["status"]),
    reversal_reason: str(col["reversal_reason"]),
    received_by_name: collector ? (str(collector["full_name"]) ?? str(collector["email"])) : null,
    notes: str(col["notes"]),
    allocations,
    principal_outstanding: 0,
    interest_outstanding: 0,
    total_outstanding: 0,
    next_due_date: null,
  };

  return {
    snapshot,
    documentNumber: number,
    documentDate: date,
    organizationId,
    businessId: str(col["business_id"]),
    branchId: str(col["branch_id"]),
    currency,
    sourceDocId: collectionId,
  };
}
