// Post a loan disbursement to the General Ledger.
// Idempotent: re-invoking returns the existing journal entry.
//
// JE shape:
//   Dr  Loan Receivable        (loan_types.gl_receivable_account_id)
//   Cr  Disbursement Clearing  (loan_types.gl_disbursement_clearing_account_id)
//
// Both accounts MUST be configured on the loan type. If either is missing the
// function returns 400 with a clear actionable message — admins resolve it on
// the Loan Types Settings page.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Body { loan_id: string; entry_date?: string }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return json({ error: "Missing Authorization" }, 401);
    }
    const body = (await req.json()) as Body;
    if (!body?.loan_id) return json({ error: "loan_id is required" }, 400);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: who, error: whoErr } = await userClient.auth.getUser();
    if (whoErr || !who?.user) return json({ error: "Invalid token" }, 401);

    const admin = createClient(url, serviceKey);

    // Idempotency: if a JE already exists for this disbursement, return it.
    const { data: existing } = await admin
      .from("journal_entries")
      .select("id, entry_number, status")
      .eq("source_type", "loan_disbursement")
      .eq("source_id", body.loan_id)
      .maybeSingle();
    if (existing) return json({ journal_entry_id: existing.id, idempotent: true });

    // Load loan + loan type GL accounts
    const { data: loan, error: loanErr } = await admin
      .from("employee_loans")
      .select(`
        id, organization_id, business_id, branch_id, loan_number, principal_amount,
        loan_type_id, disbursed_at, disbursement_journal_entry_id,
        loan_types ( id, name, gl_receivable_account_id, gl_disbursement_clearing_account_id )
      `)
      .eq("id", body.loan_id)
      .single();
    if (loanErr || !loan) return json({ error: "Loan not found" }, 404);

    const lt: any = loan.loan_types;
    if (!lt?.gl_receivable_account_id || !lt?.gl_disbursement_clearing_account_id) {
      return json({
        error: "Loan type is missing GL account mappings (loan receivable and/or disbursement clearing). Configure them under Payroll → Setup → Loan Types.",
      }, 400);
    }

    const amount = Number(loan.principal_amount || 0);
    if (amount <= 0) return json({ error: "Loan principal must be > 0" }, 400);
    const entryDate = body.entry_date || new Date().toISOString().slice(0, 10);

    // Insert journal entry header
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
        posted_by: who.user.id,
        source_type: "loan_disbursement",
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
        account_id: lt.gl_receivable_account_id,
        debit: amount,
        credit: 0,
        description: `Loan receivable — ${loan.loan_number}`,
        sort_order: 1,
        business_id: loan.business_id,
        branch_id: loan.branch_id,
      },
      {
        journal_entry_id: je.id,
        account_id: lt.gl_disbursement_clearing_account_id,
        debit: 0,
        credit: amount,
        description: `Disbursement clearing — ${loan.loan_number}`,
        sort_order: 2,
        business_id: loan.business_id,
        branch_id: loan.branch_id,
      },
    ]);
    if (linesErr) {
      await admin.from("journal_entries").delete().eq("id", je.id);
      return json({ error: linesErr.message }, 500);
    }

    await admin
      .from("employee_loans")
      .update({
        disbursement_journal_entry_id: je.id,
        disbursed_at: loan.disbursed_at ?? new Date().toISOString(),
        status: "active",
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
