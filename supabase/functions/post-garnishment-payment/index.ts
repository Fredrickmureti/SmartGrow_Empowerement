/**
 * post-garnishment-payment
 *
 * Pays a single garnishment order. Resolves all open payroll_liabilities tied
 * to that garnishment_id (FIFO by due_date / period_end) and allocates the
 * requested amount across them, then delegates to the same GL posting +
 * allocation machinery used by post-remittance-payment.
 *
 * The trigger trg_apply_garnishment_payment_to_order will then bump the
 * order's total_paid and auto-satisfy it when fully paid.
 *
 * Body:
 *   {
 *     organization_id: string,
 *     business_id: string,
 *     branch_id?: string | null,
 *     garnishment_id: string,
 *     amount: number,
 *     payment_date: string,           // YYYY-MM-DD
 *     bank_account_id: string,        // GL account id
 *     payment_method?: string,
 *     reference_number?: string,
 *     proof_url?: string,
 *     notes?: string,
 *   }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Body {
  organization_id: string;
  business_id: string;
  branch_id?: string | null;
  garnishment_id: string;
  amount: number;
  payment_date: string;
  bank_account_id: string;
  payment_method?: string;
  reference_number?: string;
  proof_url?: string;
  notes?: string;
}

function bad(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
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
      organization_id, business_id, branch_id, garnishment_id,
      amount, payment_date, bank_account_id, payment_method,
      reference_number, proof_url, notes,
    } = body;

    if (!organization_id || !business_id) return bad("organization_id and business_id are required");
    if (!garnishment_id) return bad("garnishment_id is required");
    if (typeof amount !== "number" || !(amount > 0)) return bad("amount must be > 0");
    if (!payment_date) return bad("payment_date is required");
    if (!bank_account_id) return bad("bank_account_id is required");

    const requested = round2(amount);

    // 1) Load the order (scoped to organization) and validate recipient.
    // ADR-0093 / Phase R4b: recipient identity + contact live on the
    // `legal_recipients` master, resolved through `recipient_id`. The legacy
    // payee snapshot columns are gone.
    const { data: order, error: ordErr } = await supabaseAdmin
      .from("legal_orders_records" as any)
      .select("id, organization_id, business_id, recipient_id, kind, status, total_owed, total_paid, legal_recipients:recipient_id(display_name, contact_id)")
      .eq("id", garnishment_id)
      .maybeSingle();
    if (ordErr || !order) return bad("Garnishment order not found");
    if (order.organization_id !== organization_id)
      return bad("Garnishment order belongs to a different organization");
    if (order.business_id && order.business_id !== business_id)
      return bad("Garnishment order belongs to a different business");
    if (!order.recipient_id)
      return bad("Garnishment recipient is not linked — link a recipient before paying");
    if (!["active", "approved"].includes(String(order.status)))
      return bad(`Garnishment status is ${order.status}; cannot pay`);

    const recipientContactId =
      ((order as any).legal_recipients?.contact_id as string | null) ?? null;
    const authority_name =
      ((order as any).legal_recipients?.display_name as string | null) ||
      `Garnishment ${order.kind}`;

    // 2) Pull open liabilities for this garnishment (FIFO by due_date, then period_end)
    const { data: liabs, error: liabErr } = await supabaseAdmin
      .from("payroll_liabilities")
      .select("id, business_id, liability_account_id, outstanding_amount, status, label, rule_code, due_date, period_end")
      .eq("garnishment_id", garnishment_id)
      .eq("organization_id", organization_id)
      .in("status", ["open", "partial"])
      .order("due_date", { ascending: true, nullsFirst: true })
      .order("period_end", { ascending: true });
    if (liabErr) return bad(`Failed to load liabilities: ${liabErr.message}`, 500);
    if (!liabs || liabs.length === 0)
      return bad("No open liabilities found for this garnishment — nothing to pay");

    // 3) FIFO allocate the requested amount across liabilities
    let remaining = requested;
    const allocations: { liability_id: string; amount: number; liability: any }[] = [];
    for (const l of liabs) {
      if (remaining <= 0.0049) break;
      if (!l.liability_account_id)
        return bad(`Liability ${l.label} has no liability_account_id mapped — fix payroll GL mapping first`);
      if (l.business_id !== business_id)
        return bad(`Liability ${l.id} belongs to a different business`);
      const outstanding = Number(l.outstanding_amount || 0);
      if (outstanding <= 0) continue;
      const take = round2(Math.min(remaining, outstanding));
      if (take <= 0) continue;
      allocations.push({ liability_id: l.id, amount: take, liability: l });
      remaining = round2(remaining - take);
    }
    if (allocations.length === 0)
      return bad("No outstanding balance on any open liability for this garnishment");
    if (remaining > 0.0049)
      return bad(`Requested amount exceeds open garnishment balance by ${remaining.toFixed(2)}`);

    const total = round2(allocations.reduce((s, a) => s + a.amount, 0));

    // 4) Validate bank account
    const { data: bankAcct, error: bankErr } = await supabaseAdmin
      .from("accounts")
      .select("id, business_id, account_type")
      .eq("id", bank_account_id)
      .maybeSingle();
    if (bankErr || !bankAcct) return bad("bank_account_id not found");
    if (bankAcct.business_id && bankAcct.business_id !== business_id)
      return bad("bank_account_id belongs to a different business");
    const at = String(bankAcct.account_type || "").toLowerCase();
    if (!["asset", "bank", "cash"].includes(at))
      return bad(`bank_account_id must be an asset/bank/cash account (got ${bankAcct.account_type})`);

    // 5) Build JE lines (Dr each liability account, Cr bank)
    const debitByAcct = new Map<string, { amount: number; description: string }>();
    for (const a of allocations) {
      const acct = a.liability.liability_account_id;
      const cur = debitByAcct.get(acct);
      if (cur) cur.amount = round2(cur.amount + a.amount);
      else debitByAcct.set(acct, {
        amount: a.amount,
        description: `Garnishment payment ${authority_name} - ${a.liability.label}`,
      });
    }
    const lines: any[] = [];
    for (const [acctId, entry] of debitByAcct) {
      lines.push({
        account_id: acctId,
        debit: entry.amount,
        credit: 0,
        description: entry.description,
        contact_id: recipientContactId,
      });
    }
    lines.push({
      account_id: bank_account_id,
      debit: 0,
      credit: total,
      description: `Garnishment payment ${authority_name}${reference_number ? ` ref ${reference_number}` : ""}`,
      contact_id: recipientContactId,
    });

    // 6) Post JE
    const { data: jeNumberData } = await supabaseAdmin.rpc("get_next_journal_entry_number", {
      _org_id: organization_id,
    });
    const jeNumber = String(jeNumberData || `JE-GP-${Date.now()}`);

    const { data: jeId, error: jeErr } = await supabaseAdmin.rpc("post_journal_entry_atomic", {
      _org_id: organization_id,
      _business_id: business_id,
      _entry_number: jeNumber,
      _entry_date: payment_date,
      _reference: reference_number || jeNumber,
      _description: `Garnishment payment - ${authority_name}`,
      _source_type: "payroll_garnishment_payment",
      _source_id: garnishment_id,
      _created_by: userId,
      _is_closing: false,
      _is_adjusting: false,
      _lines: lines,
    });
    if (jeErr) {
      console.error("Garnishment JE post error:", jeErr);
      return bad(`GL posting failed: ${jeErr.message}`, 500);
    }

    // 7) Insert payment header (reuse payroll_remittance_payments)
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
        notes: notes || `Garnishment payment for order ${garnishment_id}`,
        total_amount: total,
        journal_entry_id: jeId,
        status: "posted",
        created_by: userId,
      })
      .select("id")
      .single();
    if (payErr) {
      console.error("Failed to insert garnishment payment header:", payErr);
      return bad(`Failed to record payment: ${payErr.message}`, 500);
    }

    // 8) Insert allocations — the existing trg_recompute_liab_on_alloc updates
    // each liability's paid/status, AND trg_apply_garnishment_payment_to_order
    // updates the garnishment order's total_paid / satisfies it.
    const allocRows = allocations.map((a) => ({
      payment_id: payment.id,
      liability_id: a.liability_id,
      amount: a.amount,
    }));
    const { error: allocErr } = await supabaseAdmin
      .from("payroll_remittance_payment_allocations")
      .insert(allocRows);
    if (allocErr) {
      console.error("Failed to insert garnishment allocations:", allocErr);
      return bad(`Failed to record allocations: ${allocErr.message}`, 500);
    }

    // 9) Lifecycle event: payment recorded
    await supabaseAdmin
      .from("garnishment_lifecycle_events")
      .insert({
        organization_id,
        business_id,
        garnishment_id,
        event: "payment_posted",
        from_status: order.status,
        to_status: order.status,
        reason_code: "payment_posted",
        reason_text: `Garnishment payment of ${total} posted (${allocations.length} liability allocation(s))`,
        payload: {
          payment_id: payment.id,
          journal_entry_id: jeId,
          amount: total,
          allocations: allocRows,
          reference_number: reference_number || null,
        },
        effective_at: payment_date,
        actor_user_id: userId,
      });

    // 10) Canonical business event — Phase 4 outbox emission.
    //     Downstream consumers (remittance, statements, reporting) subscribe
    //     to `legal_order.payment_posted` instead of polling the physical
    //     garnishments/payments tables.
    try {
      await supabaseAdmin.from("business_event_outbox").insert({
        organization_id,
        business_id,
        topic: "legal_order.payment_posted",
        payload: {
          legal_order_id: garnishment_id,
          payment_id: payment.id,
          journal_entry_id: jeId,
          amount: total,
          currency: null,
          allocations: allocRows,
          reference_number: reference_number || null,
          payment_date,
          actor_user_id: userId,
        },
      });
    } catch (outboxErr) {
      // Best-effort — do not fail the payment if the outbox is unavailable.
      console.warn("[post-garnishment-payment] outbox emit failed:", (outboxErr as Error).message);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        payment_id: payment.id,
        journal_entry_id: jeId,
        total_amount: total,
        allocations_count: allocations.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("post-garnishment-payment error:", e);
    return bad(`Unexpected error: ${(e as Error).message}`, 500);
  }
});
