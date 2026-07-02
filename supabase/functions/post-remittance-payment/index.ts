/**
 * post-remittance-payment
 *
 * GL-backed statutory remittance payment. Replaces the legacy "set
 * payroll_remittances.status='paid'" mutation that had no accounting impact.
 *
 * Body:
 *   {
 *     organization_id: string,
 *     business_id: string,
 *     branch_id?: string | null,
 *     authority_name: string,
 *     payment_date: string (YYYY-MM-DD),
 *     bank_account_id: string,                 // GL account.id, must be cash/bank
 *     payment_method?: string,
 *     reference_number?: string,
 *     proof_url?: string,
 *     notes?: string,
 *     allocations: Array<{ liability_id: string; amount: number }>
 *   }
 *
 * Effects (atomic where possible):
 *   1. Validate every liability belongs to the same business and authority.
 *   2. Validate each allocation amount ≤ outstanding_amount.
 *   3. Validate Σ allocations === total_amount > 0.
 *   4. Post JE: Dr each liability_account_id (per allocation) / Cr bank_account_id (sum).
 *   5. Insert payroll_remittance_payments row + payroll_remittance_payment_allocations.
 *      Trigger trg_recompute_liab_on_alloc updates each liability's paid_amount + status.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Allocation {
  liability_id: string;
  amount: number;
}

interface Body {
  organization_id: string;
  business_id: string;
  branch_id?: string | null;
  authority_name: string;
  payment_date: string;
  bank_account_id: string;
  payment_method?: string;
  reference_number?: string;
  proof_url?: string;
  notes?: string;
  allocations: Allocation[];
}

function bad(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve calling user from JWT
    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supabaseUser.auth.getUser();
    if (!user) return bad("Unauthorized", 401);
    const userId = user.id;

    const body = (await req.json()) as Body;
    const {
      organization_id, business_id, branch_id, authority_name,
      payment_date, bank_account_id, payment_method, reference_number,
      proof_url, notes, allocations,
    } = body;

    if (!organization_id || !business_id) return bad("organization_id and business_id are required");
    if (!authority_name) return bad("authority_name is required");
    if (!payment_date) return bad("payment_date is required");
    if (!bank_account_id) return bad("bank_account_id is required");
    if (!Array.isArray(allocations) || allocations.length === 0)
      return bad("At least one allocation is required");

    // Total + per-allocation validation
    let total = 0;
    for (const a of allocations) {
      if (!a.liability_id) return bad("allocation.liability_id is required");
      if (typeof a.amount !== "number" || !(a.amount > 0))
        return bad("allocation.amount must be > 0");
      total += a.amount;
    }
    total = Math.round(total * 100) / 100;
    if (total <= 0) return bad("Total payment amount must be > 0");

    // Load liabilities to validate scope, outstanding, and pull liability_account_id
    const liabilityIds = allocations.map((a) => a.liability_id);
    const { data: liabRows, error: liabErr } = await supabaseAdmin
      .from("payroll_liabilities")
      .select("id, business_id, organization_id, authority_name, liability_account_id, outstanding_amount, status, label, rule_code")
      .in("id", liabilityIds);
    if (liabErr) return bad(`Failed to load liabilities: ${liabErr.message}`, 500);
    if (!liabRows || liabRows.length !== liabilityIds.length)
      return bad("One or more liabilities not found");

    const liabById = new Map<string, any>(liabRows.map((r) => [r.id, r]));
    for (const a of allocations) {
      const l = liabById.get(a.liability_id);
      if (!l) return bad(`Liability ${a.liability_id} not found`);
      if (l.business_id !== business_id)
        return bad(`Liability ${l.id} belongs to a different business — cross-business remittance is blocked`);
      if (l.authority_name && authority_name && l.authority_name !== authority_name)
        return bad(`Liability ${l.id} authority (${l.authority_name}) ≠ payment authority (${authority_name})`);
      if (l.status === 'paid' || l.status === 'void' || l.status === 'legacy_paid')
        return bad(`Liability ${l.label} (${l.rule_code}) is ${l.status}; cannot allocate`);
      if (Number(a.amount) > Number(l.outstanding_amount) + 0.001)
        return bad(`Allocation ${a.amount} exceeds outstanding ${l.outstanding_amount} on ${l.label}`);
      if (!l.liability_account_id)
        return bad(`Liability ${l.label} has no liability_account_id mapped — fix payroll GL mapping first`);
    }

    // Validate bank account exists and is asset class (cash/bank)
    const { data: bankAcct, error: bankErr } = await supabaseAdmin
      .from("accounts")
      .select("id, business_id, account_type, name")
      .eq("id", bank_account_id)
      .maybeSingle();
    if (bankErr || !bankAcct) return bad("bank_account_id not found");
    if (bankAcct.business_id && bankAcct.business_id !== business_id)
      return bad("bank_account_id belongs to a different business");
    if (!['asset','bank','cash'].includes(String(bankAcct.account_type).toLowerCase()) &&
        !['asset'].includes(String(bankAcct.account_type).toLowerCase()))
      return bad(`bank_account_id must be an asset/bank/cash account (got ${bankAcct.account_type})`);

    // Build JE lines: Dr each liability_account / Cr bank
    const lines: any[] = [];
    // Aggregate debits per liability_account_id (multiple liabilities can share an account)
    const debitByAcct = new Map<string, { amount: number; description: string }>();
    for (const a of allocations) {
      const l = liabById.get(a.liability_id);
      const acct = l.liability_account_id;
      const cur = debitByAcct.get(acct);
      const amt = Math.round(a.amount * 100) / 100;
      if (cur) {
        cur.amount += amt;
      } else {
        debitByAcct.set(acct, {
          amount: amt,
          description: `Remittance ${authority_name} - ${l.label}`,
        });
      }
    }
    for (const [acctId, entry] of debitByAcct) {
      lines.push({
        account_id: acctId,
        debit: Math.round(entry.amount * 100) / 100,
        credit: 0,
        description: entry.description,
        contact_id: null,
      });
    }
    lines.push({
      account_id: bank_account_id,
      debit: 0,
      credit: total,
      description: `Remittance payment ${authority_name}${reference_number ? ` ref ${reference_number}` : ""}`,
      contact_id: null,
    });

    // Post JE
    const { data: jeNumberData } = await supabaseAdmin.rpc("get_next_journal_entry_number", {
      _org_id: organization_id,
    });
    const jeNumber = String(jeNumberData || `JE-RM-${Date.now()}`);

    const { data: jeId, error: jeErr } = await supabaseAdmin.rpc("post_journal_entry_atomic", {
      _org_id: organization_id,
      _business_id: business_id,
      _entry_number: jeNumber,
      _entry_date: payment_date,
      _reference: reference_number || jeNumber,
      _description: `Statutory remittance payment - ${authority_name}`,
      _source_type: "payroll_remittance_payment",
      _source_id: null,
      _created_by: userId,
      _is_closing: false,
      _is_adjusting: false,
      _lines: lines,
    });

    if (jeErr) {
      console.error("Remittance JE post error:", jeErr);
      return bad(`GL posting failed: ${jeErr.message}`, 500);
    }

    // Insert payment header
    const { data: payment, error: payErr } = await supabaseAdmin
      .from("payroll_remittance_payments")
      .insert({
        organization_id,
        business_id,
        branch_id: branch_id || null,
        authority_name,
        payment_date,
        payment_method: payment_method || null,
        bank_account_id,
        reference_number: reference_number || null,
        proof_url: proof_url || null,
        notes: notes || null,
        total_amount: total,
        journal_entry_id: jeId,
        status: 'posted',
        created_by: userId,
      })
      .select("id")
      .single();
    if (payErr) {
      console.error("Failed to insert payment header:", payErr);
      return bad(`Failed to record payment: ${payErr.message}`, 500);
    }

    // Insert allocations (trigger recomputes each liability's paid_amount/status)
    const allocRows = allocations.map((a) => ({
      payment_id: payment.id,
      liability_id: a.liability_id,
      amount: Math.round(a.amount * 100) / 100,
    }));
    const { error: allocErr } = await supabaseAdmin
      .from("payroll_remittance_payment_allocations")
      .insert(allocRows);
    if (allocErr) {
      console.error("Failed to insert allocations:", allocErr);
      return bad(`Failed to record allocations: ${allocErr.message}`, 500);
    }

    // Mirror to legacy payroll_remittances row when an allocation fully clears
    // a single-source liability (one row per run × type) — keeps legacy UI/reports coherent.
    for (const a of allocations) {
      const l = liabById.get(a.liability_id);
      const newPaid = Number(l.outstanding_amount) - Number(a.amount);
      if (newPaid <= 0.001 && (l.legacy_remittance_id ?? null)) {
        await supabaseAdmin
          .from("payroll_remittances")
          .update({
            status: 'paid',
            payment_date,
            reference_number: reference_number || null,
            payment_method: payment_method || null,
            paid_by: userId,
            paid_at: new Date().toISOString(),
          })
          .eq("id", l.legacy_remittance_id);
      }
    }

    // Audit
    await supabaseAdmin.from("audit_logs").insert({
      organization_id,
      business_id,
      user_id: userId,
      action: "remittance_payment_posted",
      entity_type: "payroll_remittance_payment",
      entity_id: payment.id,
      entity_name: `${authority_name} ${payment_date}`,
      new_values: {
        journal_entry_id: jeId,
        journal_entry_number: jeNumber,
        total_amount: total,
        allocation_count: allocations.length,
        liability_ids: liabilityIds,
      },
      changes_summary: `Posted statutory remittance payment ${total.toFixed(2)} to ${authority_name} (JE: ${jeNumber}), cleared ${allocations.length} liabilities`,
    });

    return new Response(JSON.stringify({
      payment_id: payment.id,
      journal_entry_id: jeId,
      journal_entry_number: jeNumber,
      total_amount: total,
      allocation_count: allocations.length,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e: any) {
    console.error("post-remittance-payment error:", e);
    return new Response(JSON.stringify({ error: e?.message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});