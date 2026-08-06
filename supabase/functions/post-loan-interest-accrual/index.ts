// Phase D — Post a loan interest accrual to the General Ledger.
//
// Journal (per accrual period):
//   Dr  Loan Receivable                 (interest capitalised into balance)
//   Cr  Interest Income                 (loan_type.interest_income_account_id)
//
// Idempotency: keyed by (source_type='loan_interest_accrual', source_id=loan_id,
// reference=period_key). Callers pass a `period_key` (e.g. "2026-07") so the
// same period cannot double-post. If the loan_type has `requires_interest =
// false` or no `interest_income_account_id`, the request is rejected — the
// caller (compute-payroll or a period-close job) is responsible for skipping.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Body {
  loan_id: string;
  interest_amount: number;    // absolute currency amount to accrue
  period_key: string;         // idempotency key, e.g. "2026-07"
  entry_date?: string;        // ISO date; defaults to today
  capitalise?: boolean;       // default true — also grows outstanding_balance
  notes?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "Missing Authorization" }, 401);
    const body = (await req.json()) as Body;
    if (!body?.loan_id) return json({ error: "loan_id is required" }, 400);
    if (!body?.period_key) return json({ error: "period_key is required" }, 400);
    const amount = Number(body.interest_amount || 0);
    if (!(amount > 0)) return json({ error: "interest_amount must be > 0" }, 400);

    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: who, error: whoErr } = await userClient.auth.getUser();
    if (whoErr || !who?.user) return json({ error: "Invalid token" }, 401);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Idempotency — (source_type, source_id, reference) must be unique per loan+period.
    const { data: existing } = await admin
      .from("journal_entries")
      .select("id")
      .eq("source_type", "loan_interest_accrual")
      .eq("source_id", body.loan_id)
      .eq("reference", body.period_key)
      .maybeSingle();
    if (existing) return json({ journal_entry_id: existing.id, idempotent: true });

    const { data: loan, error: loanErr } = await admin
      .from("employee_loans")
      .select(`
        id, organization_id, business_id, branch_id, loan_number,
        outstanding_balance, status,
        loan_types ( id, name, requires_interest, gl_receivable_account_id, interest_income_account_id )
      `)
      .eq("id", body.loan_id)
      .single();
    if (loanErr || !loan) return json({ error: "Loan not found" }, 404);

    const lt: any = loan.loan_types;
    if (lt?.requires_interest !== true) {
      return json({ error: "Loan type does not carry interest (requires_interest = false)." }, 400);
    }
    if (!lt?.gl_receivable_account_id) {
      return json({ error: "Loan type missing receivable account. Configure under Payroll → Loan Types." }, 400);
    }
    if (!lt?.interest_income_account_id) {
      return json({ error: "Loan type missing interest income account. Configure under Payroll → Loan Types." }, 400);
    }

    const entryDate = body.entry_date || new Date().toISOString().slice(0, 10);
    const description = `Loan interest accrual — ${loan.loan_number} (${body.period_key})`;

    // Journal posting goes through the single canonical posting engine
    // (post_journal_entry_atomic). No edge function may insert into
    // journal_entries directly — the RPC owns balancing, journal-book
    // assignment, period locks and scope stamping in one transaction.
    const { data: jeNumberData } = await admin.rpc("get_next_journal_entry_number", {
      _org_id: loan.organization_id,
    });
    const entryNumber = String(jeNumberData || `JE-LIA-${Date.now()}`);

    const { data: jeId, error: jeErr } = await admin.rpc("post_journal_entry_atomic", {
      _org_id: loan.organization_id,
      _business_id: loan.business_id,
      _branch_id: loan.branch_id,
      _entry_number: entryNumber,
      _entry_date: entryDate,
      _reference: body.period_key,
      _description: description,
      _source_type: "loan_interest_accrual",
      _source_id: loan.id,
      _created_by: who.user.id,
      _is_closing: false,
      _is_adjusting: false,
      _lines: [
        {
          account_id: lt.gl_receivable_account_id,
          debit: amount,
          credit: 0,
          description,
        },
        {
          account_id: lt.interest_income_account_id,
          debit: 0,
          credit: amount,
          description: `Interest income — ${loan.loan_number} (${body.period_key})`,
        },
      ],
    } as any);
    if (jeErr) return json({ error: jeErr.message }, 500);
    const je = { id: jeId as unknown as string };

    // Capitalise the interest into outstanding balance (default true) so the
    // next period's amortisation / recovery reflects the accrued charge.
    if (body.capitalise !== false) {
      await admin
        .from("employee_loans")
        .update({
          outstanding_balance: (Number(loan.outstanding_balance) || 0) + amount,
        })
        .eq("id", loan.id);
    }

    // Best-effort lifecycle event.
    try {
      await admin.from("loan_lifecycle_events").insert({
        organization_id: loan.organization_id,
        loan_id: loan.id,
        event_type: "interest_accrued",
        actor_user_id: who.user.id,
        payload: {
          amount, period_key: body.period_key,
          journal_entry_id: je.id, capitalised: body.capitalise !== false,
          notes: body.notes ?? null,
        },
      });
    } catch (_) { /* non-fatal */ }

    return json({ journal_entry_id: je.id });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
