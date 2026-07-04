// Post a loan settlement (early payoff or write-off) to the General Ledger.
// Reverses the remaining receivable balance.
//
// Normal settlement (employee/external pays the remainder):
//   Dr  Disbursement Clearing  (or bank — kept as clearing for separation)
//   Cr  Loan Receivable
//
// Write-off (e.g., employee leaves with unrecoverable balance):
//   Dr  Salary Expense  (fallback if no dedicated write-off mapping)
//   Cr  Loan Receivable
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Body {
  loan_id: string;
  settlement_amount?: number; // defaults to outstanding balance
  write_off?: boolean;
  entry_date?: string;
  notes?: string;
  // Phase D: second approver id required when loan_type.dual_control_writeoff = true.
  // Must be a distinct user from the caller with admin/manager privilege.
  second_approver_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "Missing Authorization" }, 401);
    const body = (await req.json()) as Body;
    if (!body?.loan_id) return json({ error: "loan_id is required" }, 400);

    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: who, error: whoErr } = await userClient.auth.getUser();
    if (whoErr || !who?.user) return json({ error: "Invalid token" }, 401);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Idempotency
    const { data: existing } = await admin
      .from("journal_entries")
      .select("id")
      .eq("source_type", "loan_settlement")
      .eq("source_id", body.loan_id)
      .maybeSingle();
    if (existing) return json({ journal_entry_id: existing.id, idempotent: true });

    const { data: loan, error: loanErr } = await admin
      .from("employee_loans")
      .select(`
        id, organization_id, business_id, branch_id, loan_number,
        outstanding_balance, status,
        loan_types ( id, name, gl_receivable_account_id, gl_disbursement_clearing_account_id, writeoff_account_id, dual_control_writeoff )
      `)
      .eq("id", body.loan_id)
      .single();
    if (loanErr || !loan) return json({ error: "Loan not found" }, 404);

    const lt: any = loan.loan_types;
    if (!lt?.gl_receivable_account_id) {
      return json({ error: "Loan type missing receivable account mapping. Configure under Payroll → Setup → Loan Types." }, 400);
    }

    const amount = Number(body.settlement_amount ?? loan.outstanding_balance ?? 0);
    if (amount <= 0) return json({ error: "Nothing to settle (outstanding balance is 0)" }, 400);

    // Phase D: dual-control enforcement for write-offs.
    // When the loan_type opts into dual_control_writeoff, a second approver
    // (distinct from the caller, and holding admin/manager role) must be
    // supplied. This is the last-mile check before the JE hits the ledger.
    if (body.write_off && lt?.dual_control_writeoff === true) {
      const secondId = (body.second_approver_id || "").trim();
      if (!secondId) {
        return json({ error: "Write-off requires a second approver (dual control is enabled on this loan type)." }, 400);
      }
      if (secondId === who.user.id) {
        return json({ error: "Second approver must be a different user from the initiator." }, 400);
      }
      const { data: adminRole } = await admin.rpc("has_role", { _user_id: secondId, _role: "admin" });
      const { data: mgrRole } = adminRole
        ? { data: true }
        : await admin.rpc("has_role", { _user_id: secondId, _role: "manager" });
      if (!adminRole && !mgrRole) {
        return json({ error: "Second approver must hold admin or manager role." }, 403);
      }
    }

    let counterAccountId = lt.gl_disbursement_clearing_account_id as string | null;
    if (body.write_off) {
      // Phase D: prefer the loan_type's own writeoff_account_id when set.
      // Fall back to default_account_settings (loan_writeoff_expense →
      // salary_expense) so existing tenants keep working unchanged.
      if (lt?.writeoff_account_id) {
        counterAccountId = lt.writeoff_account_id;
      } else {
        const { data: mapping } = await admin
          .from("default_account_settings")
          .select("account_id")
          .eq("organization_id", loan.organization_id)
          .in("setting_key", ["loan_writeoff_expense", "salary_expense"])
          .order("setting_key", { ascending: false }) // prefer loan_writeoff_expense
          .limit(1)
          .maybeSingle();
        counterAccountId = mapping?.account_id ?? counterAccountId;
      }
    }
    if (!counterAccountId) {
      return json({
        error: body.write_off
          ? "No write-off account resolvable. Set loan type write-off account, or map loan_writeoff_expense / salary_expense under Finance → Settings → Default Mappings."
          : "Loan type missing disbursement clearing account. Configure under Payroll → Setup → Loan Types.",
      }, 400);
    }

    const entryDate = body.entry_date || new Date().toISOString().slice(0, 10);
    const description = body.write_off
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
        posted_by: who.user.id,
        source_type: "loan_settlement",
        source_id: loan.id,
        total_debit: amount,
        total_credit: amount,
        created_by: who.user.id,
      })
      .select("id")
      .single();
    if (jeErr) return json({ error: jeErr.message }, 500);

    const { error: linesErr } = await admin.from("journal_entry_lines").insert([
      {
        journal_entry_id: je.id,
        account_id: counterAccountId,
        debit: amount, credit: 0,
        description, sort_order: 1,
        business_id: loan.business_id, branch_id: loan.branch_id,
      },
      {
        journal_entry_id: je.id,
        account_id: lt.gl_receivable_account_id,
        debit: 0, credit: amount,
        description: `Loan receivable cleared — ${loan.loan_number}`,
        sort_order: 2,
        business_id: loan.business_id, branch_id: loan.branch_id,
      },
    ]);
    if (linesErr) {
      await admin.from("journal_entries").delete().eq("id", je.id);
      return json({ error: linesErr.message }, 500);
    }

    await admin
      .from("employee_loans")
      .update({
        settlement_journal_entry_id: je.id,
        outstanding_balance: Math.max((Number(loan.outstanding_balance) || 0) - amount, 0),
        status: ((Number(loan.outstanding_balance) || 0) - amount) <= 0
          ? (body.write_off ? "written_off" : "settled")
          : loan.status,
        notes: body.notes ?? null,
      })
      .eq("id", loan.id);

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
