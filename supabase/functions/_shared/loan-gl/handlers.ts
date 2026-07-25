/**
 * Shared handlers for the fat `loan-gl` edge function (ADR 0005).
 *
 * Three actions:
 *   • disburse — post loan disbursement JE (Dr Receivable / Cr Clearing)
 *   • accrue   — post monthly interest accrual (Dr Receivable / Cr Interest Income)
 *   • settle   — post settlement or write-off (Dr Clearing|Write-off / Cr Receivable)
 *
 * Each handler is idempotent via `journal_entries.source_type/source_id[/reference]`.
 * Kept in `_shared/` so we can split `loan-gl` back into per-action functions
 * without a rewrite if the family grows.
 */
// deno-lint-ignore-file no-explicit-any
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface HandlerCtx {
  admin: SupabaseClient;
  userId: string;
}

export function makeAdminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

export async function authenticate(req: Request): Promise<
  { ok: true; userId: string } | { ok: false; status: number; error: string }
> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing Authorization" };
  }
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data: who, error: whoErr } = await userClient.auth.getUser();
  if (whoErr || !who?.user) return { ok: false, status: 401, error: "Invalid token" };
  return { ok: true, userId: who.user.id };
}

/**
 * Resolve a loan GL account with a three-tier fallback:
 *   1. explicit override on the loan type
 *   2. `default_account_settings` mapping for the business (then organization)
 *   3. the provisioned system-role account on the chart of accounts
 * Returns null only when the workspace has never been provisioned.
 */
export async function resolveLoanAccount(
  admin: any,
  loan: { organization_id: string; business_id: string | null },
  settingKey: string,
  loanTypeOverride?: string | null,
): Promise<string | null> {
  if (loanTypeOverride) return loanTypeOverride;

  let q = admin
    .from("default_account_settings")
    .select("account_id, business_id")
    .eq("organization_id", loan.organization_id)
    .eq("setting_key", settingKey);
  if (loan.business_id) q = q.or(`business_id.eq.${loan.business_id},business_id.is.null`);
  const { data: mappings } = await q;
  if (mappings?.length) {
    const exact = mappings.find((m: any) => m.business_id === loan.business_id);
    return (exact ?? mappings[0]).account_id;
  }

  let aq = admin
    .from("accounts")
    .select("id, business_id")
    .eq("organization_id", loan.organization_id)
    .eq("system_role", settingKey)
    .eq("is_active", true);
  if (loan.business_id) aq = aq.or(`business_id.eq.${loan.business_id},business_id.is.null`);
  const { data: accounts } = await aq.limit(5);
  if (accounts?.length) {
    const exact = accounts.find((a: any) => a.business_id === loan.business_id);
    return (exact ?? accounts[0]).id;
  }
  return null;
}

const SETUP_HINT =
  "Open Finance → Settings → Default Mappings (or Payroll → Setup → Loan Types) to map it.";


// ---------- disburse ----------
export interface DisburseInput {
  loan_id: string;
  entry_date?: string;
  bank_account_id?: string;
  value_date?: string;
}

export async function handleDisburse(input: DisburseInput, ctx: HandlerCtx) {
  if (!input?.loan_id) return err(400, "loan_id is required");
  const { admin, userId } = ctx;

  const { data: existing } = await admin
    .from("journal_entries")
    .select("id, entry_number, status")
    .eq("source_type", "loan_disbursement")
    .eq("source_id", input.loan_id)
    .maybeSingle();
  if (existing) return ok({ journal_entry_id: existing.id, idempotent: true });

  const { data: loan, error: loanErr } = await admin
    .from("employee_loans")
    .select(`
      id, organization_id, business_id, branch_id, loan_number, principal_amount,
      loan_type_id, disbursed_at, disbursement_journal_entry_id,
      loan_types ( id, name, gl_receivable_account_id, gl_disbursement_clearing_account_id )
    `)
    .eq("id", input.loan_id)
    .single();
  if (loanErr || !loan) return err(404, "Loan not found");

  const lt: any = loan.loan_types;
  const receivableId = await resolveLoanAccount(admin, loan, "loan_receivable", lt?.gl_receivable_account_id);
  const clearingId = await resolveLoanAccount(
    admin, loan, "loan_disbursement_clearing", lt?.gl_disbursement_clearing_account_id,
  );
  if (!receivableId) return err(400, `No loan receivable account is mapped. ${SETUP_HINT}`);
  if (!clearingId) return err(400, `No loan disbursement clearing account is mapped. ${SETUP_HINT}`);


  const amount = Number(loan.principal_amount || 0);
  if (amount <= 0) return err(400, "Loan principal must be > 0");
  const entryDate = input.entry_date || input.value_date || new Date().toISOString().slice(0, 10);

  const { data: je, error: jeErr } = await admin
    .from("journal_entries")
    .insert({
      organization_id: loan.organization_id,
      business_id: loan.business_id,
      branch_id: loan.branch_id,
      entry_date: entryDate,
      description: `Loan disbursement — ${loan.loan_number}`,
      reference: loan.loan_number,
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: userId,
      source_type: "loan_disbursement",
      source_id: loan.id,
      total_debit: amount,
      total_credit: amount,
      created_by: userId,
    })
    .select("id")
    .single();
  if (jeErr) return err(500, jeErr.message);

  const { error: linesErr } = await admin.from("journal_entry_lines").insert([
    { journal_entry_id: je.id, account_id: receivableId, debit: amount, credit: 0,
      description: `Loan receivable — ${loan.loan_number}`, sort_order: 1,
      business_id: loan.business_id, branch_id: loan.branch_id },
    { journal_entry_id: je.id, account_id: clearingId, debit: 0, credit: amount,

      description: `Disbursement clearing — ${loan.loan_number}`, sort_order: 2,
      business_id: loan.business_id, branch_id: loan.branch_id },
  ]);
  if (linesErr) {
    await admin.from("journal_entries").delete().eq("id", je.id);
    return err(500, linesErr.message);
  }

  await admin
    .from("employee_loans")
    .update({
      disbursement_journal_entry_id: je.id,
      disbursed_at: loan.disbursed_at ?? new Date().toISOString(),
      status: "active",
    })
    .eq("id", loan.id);

  return ok({ journal_entry_id: je.id });
}

// ---------- accrue ----------
export interface AccrueInput {
  loan_id: string;
  interest_amount: number;
  period_key: string;
  entry_date?: string;
  capitalise?: boolean;
  notes?: string;
}

export async function handleAccrue(input: AccrueInput, ctx: HandlerCtx) {
  if (!input?.loan_id) return err(400, "loan_id is required");
  if (!input?.period_key) return err(400, "period_key is required");
  const amount = Number(input.interest_amount || 0);
  if (!(amount > 0)) return err(400, "interest_amount must be > 0");
  const { admin, userId } = ctx;

  const { data: existing } = await admin
    .from("journal_entries")
    .select("id")
    .eq("source_type", "loan_interest_accrual")
    .eq("source_id", input.loan_id)
    .eq("reference", input.period_key)
    .maybeSingle();
  if (existing) return ok({ journal_entry_id: existing.id, idempotent: true });

  const { data: loan, error: loanErr } = await admin
    .from("employee_loans")
    .select(`
      id, organization_id, business_id, branch_id, loan_number,
      outstanding_balance, status,
      loan_types ( id, name, requires_interest, gl_receivable_account_id, interest_income_account_id )
    `)
    .eq("id", input.loan_id)
    .single();
  if (loanErr || !loan) return err(404, "Loan not found");

  const lt: any = loan.loan_types;
  if (lt?.requires_interest !== true) return err(400, "Loan type does not carry interest (requires_interest = false).");
  const receivableId = await resolveLoanAccount(admin, loan, "loan_receivable", lt?.gl_receivable_account_id);
  const interestIncomeId = await resolveLoanAccount(
    admin, loan, "loan_interest_income", lt?.interest_income_account_id,
  );
  if (!receivableId) return err(400, `No loan receivable account is mapped. ${SETUP_HINT}`);
  if (!interestIncomeId) return err(400, `No loan interest income account is mapped. ${SETUP_HINT}`);


  const entryDate = input.entry_date || new Date().toISOString().slice(0, 10);
  const description = `Loan interest accrual — ${loan.loan_number} (${input.period_key})`;

  const { data: je, error: jeErr } = await admin
    .from("journal_entries")
    .insert({
      organization_id: loan.organization_id,
      business_id: loan.business_id,
      branch_id: loan.branch_id,
      entry_date: entryDate,
      description,
      reference: input.period_key,
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: userId,
      source_type: "loan_interest_accrual",
      source_id: loan.id,
      total_debit: amount,
      total_credit: amount,
      created_by: userId,
    })
    .select("id")
    .single();
  if (jeErr) return err(500, jeErr.message);

  const { error: linesErr } = await admin.from("journal_entry_lines").insert([
    { journal_entry_id: je.id, account_id: receivableId, debit: amount, credit: 0,
      description, sort_order: 1, business_id: loan.business_id, branch_id: loan.branch_id },
    { journal_entry_id: je.id, account_id: interestIncomeId, debit: 0, credit: amount,

      description: `Interest income — ${loan.loan_number} (${input.period_key})`,
      sort_order: 2, business_id: loan.business_id, branch_id: loan.branch_id },
  ]);
  if (linesErr) {
    await admin.from("journal_entries").delete().eq("id", je.id);
    return err(500, linesErr.message);
  }

  if (input.capitalise !== false) {
    await admin
      .from("employee_loans")
      .update({ outstanding_balance: (Number(loan.outstanding_balance) || 0) + amount })
      .eq("id", loan.id);
  }

  try {
    await admin.from("loan_lifecycle_events").insert({
      organization_id: loan.organization_id,
      loan_id: loan.id,
      event_type: "interest_accrued",
      actor_user_id: userId,
      payload: {
        amount, period_key: input.period_key,
        journal_entry_id: je.id, capitalised: input.capitalise !== false,
        notes: input.notes ?? null,
      },
    });
  } catch (_) { /* non-fatal */ }

  return ok({ journal_entry_id: je.id });
}

// ---------- settle ----------
export interface SettleInput {
  loan_id: string;
  settlement_amount?: number;
  write_off?: boolean;
  entry_date?: string;
  notes?: string;
  second_approver_id?: string;
}

export async function handleSettle(input: SettleInput, ctx: HandlerCtx) {
  if (!input?.loan_id) return err(400, "loan_id is required");
  const { admin, userId } = ctx;

  const { data: existing } = await admin
    .from("journal_entries")
    .select("id")
    .eq("source_type", "loan_settlement")
    .eq("source_id", input.loan_id)
    .maybeSingle();
  if (existing) return ok({ journal_entry_id: existing.id, idempotent: true });

  const { data: loan, error: loanErr } = await admin
    .from("employee_loans")
    .select(`
      id, organization_id, business_id, branch_id, loan_number,
      outstanding_balance, status,
      loan_types ( id, name, gl_receivable_account_id, gl_disbursement_clearing_account_id, writeoff_account_id, dual_control_writeoff )
    `)
    .eq("id", input.loan_id)
    .single();
  if (loanErr || !loan) return err(404, "Loan not found");

  const lt: any = loan.loan_types;
  const receivableId = await resolveLoanAccount(admin, loan, "loan_receivable", lt?.gl_receivable_account_id);
  if (!receivableId) return err(400, `No loan receivable account is mapped. ${SETUP_HINT}`);

  const amount = Number(input.settlement_amount ?? loan.outstanding_balance ?? 0);
  if (amount <= 0) return err(400, "Nothing to settle (outstanding balance is 0)");

  if (input.write_off && lt?.dual_control_writeoff === true) {
    const secondId = (input.second_approver_id || "").trim();
    if (!secondId) return err(400, "Write-off requires a second approver (dual control is enabled on this loan type).");
    if (secondId === userId) return err(400, "Second approver must be a different user from the initiator.");
    const { data: adminRole } = await admin.rpc("has_role", { _user_id: secondId, _role: "admin" });
    const { data: mgrRole } = adminRole
      ? { data: true }
      : await admin.rpc("has_role", { _user_id: secondId, _role: "manager" });
    if (!adminRole && !mgrRole) return err(403, "Second approver must hold admin or manager role.");
  }

  const counterAccountId = input.write_off
    ? await resolveLoanAccount(admin, loan, "loan_writeoff_expense", lt?.writeoff_account_id)
    : await resolveLoanAccount(admin, loan, "loan_disbursement_clearing", lt?.gl_disbursement_clearing_account_id);
  if (!counterAccountId) {
    return err(400, input.write_off
      ? `No loan write-off expense account is mapped. ${SETUP_HINT}`
      : `No loan disbursement clearing account is mapped. ${SETUP_HINT}`);
  }


  const entryDate = input.entry_date || new Date().toISOString().slice(0, 10);
  const description = input.write_off
    ? `Loan write-off — ${loan.loan_number}`
    : `Loan settlement — ${loan.loan_number}`;

  const { data: je, error: jeErr } = await admin
    .from("journal_entries")
    .insert({
      organization_id: loan.organization_id,
      business_id: loan.business_id,
      branch_id: loan.branch_id,
      entry_date: entryDate,
      description,
      reference: loan.loan_number,
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: userId,
      source_type: "loan_settlement",
      source_id: loan.id,
      total_debit: amount,
      total_credit: amount,
      created_by: userId,
    })
    .select("id")
    .single();
  if (jeErr) return err(500, jeErr.message);

  const { error: linesErr } = await admin.from("journal_entry_lines").insert([
    { journal_entry_id: je.id, account_id: counterAccountId, debit: amount, credit: 0,
      description, sort_order: 1, business_id: loan.business_id, branch_id: loan.branch_id },
    { journal_entry_id: je.id, account_id: receivableId, debit: 0, credit: amount,
      description: `Loan receivable cleared — ${loan.loan_number}`, sort_order: 2,
      business_id: loan.business_id, branch_id: loan.branch_id },
  ]);
  if (linesErr) {
    await admin.from("journal_entries").delete().eq("id", je.id);
    return err(500, linesErr.message);
  }

  await admin
    .from("employee_loans")
    .update({
      settlement_journal_entry_id: je.id,
      outstanding_balance: Math.max((Number(loan.outstanding_balance) || 0) - amount, 0),
      status: ((Number(loan.outstanding_balance) || 0) - amount) <= 0
        ? (input.write_off ? "written_off" : "settled")
        : loan.status,
      notes: input.notes ?? null,
    })
    .eq("id", loan.id);

  try {
    await admin.from("loan_lifecycle_events").insert({
      organization_id: loan.organization_id,
      loan_id: loan.id,
      event_type: input.write_off ? "written_off" : "settled",
      actor_user_id: userId,
      payload: {
        amount,
        journal_entry_id: je.id,
        second_approver_id: input.write_off && lt?.dual_control_writeoff ? input.second_approver_id ?? null : null,
        write_off_account_source: input.write_off
          ? (lt?.writeoff_account_id ? "loan_type" : "default_mapping")
          : null,
      },
    });
  } catch (_) { /* non-fatal */ }

  return ok({ journal_entry_id: je.id });
}

// ---------- helpers ----------
function ok(body: unknown) {
  return { status: 200, body };
}
function err(status: number, message: string) {
  return { status, body: { error: message } };
}