/**
 * post-payroll-payment-gl
 *
 * Closes the payroll cash leg. Given a payroll_payment_batch_id, this:
 *   1. Locks the batch (must be draft|processing, must have a bank account).
 *   2. Marks every batch item paid + stamps payslip.paid_at / payment_reference.
 *   3. Posts a balanced journal entry:
 *        DR  Net Salary Payable  (batch total)
 *        CR  Bank/Cash account   (batch total)
 *   4. Stamps batch.status='completed', payment_journal_entry_id, confirmed_at.
 *
 * Idempotent: if payment_journal_entry_id is already set the call is a no-op
 * and returns the existing JE id.
 *
 * Country-agnostic: only uses default_account_settings.setting_key
 * 'net_salary_payable' (and the explicitly-passed bank account id).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Body {
  batch_id: string;
  payment_reference?: string | null;
  payment_date?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: who, error: whoErr } = await userClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (whoErr || !who?.user) return json({ error: "Unauthorized" }, 401);
    const userId = who.user.id;

    const body = (await req.json()) as Body;
    if (!body?.batch_id) return json({ error: "batch_id required" }, 400);

    // ── 1. Load batch + run
    const { data: batch, error: bErr } = await admin
      .from("payroll_payment_batches")
      .select(
        "id, organization_id, business_id, payroll_run_id, status, total_amount, bank_account_id, payment_journal_entry_id, batch_number",
      )
      .eq("id", body.batch_id)
      .maybeSingle();
    if (bErr || !batch) return json({ error: "Batch not found" }, 404);

    if (batch.payment_journal_entry_id) {
      // Idempotent: already posted.
      return json({
        ok: true,
        already_posted: true,
        journal_entry_id: batch.payment_journal_entry_id,
      });
    }
    if (!["draft", "processing"].includes(String(batch.status))) {
      return json({
        error: `Batch is ${batch.status}; only draft/processing batches can be paid.`,
      }, 409);
    }
    if (!batch.bank_account_id) {
      return json({
        error: "Batch has no bank_account_id. Pick a bank/cash account before marking paid.",
      }, 400);
    }

    // ─── SoD: payer must have payroll.pay AND not be the creator/approver/poster ───
    {
      const { data: canPay, error: sodErr } = await admin.rpc(
        "user_can_pay_payroll",
        { _user_id: userId, _org_id: batch.organization_id, _run_id: batch.payroll_run_id },
      );
      if (sodErr) return json({ error: sodErr.message, code: "SOD_CHECK_FAILED" }, 500);
      if (canPay !== true) {
        return json({
          error:
            "Segregation of duties: only a treasury user with payroll Pay permission, who did not create/approve/post this run, can mark it paid.",
          code: "PERMISSION_DENIED",
          hint: "payroll_pay_sod_violation",
        }, 403);
      }
    }

    // Resolve the GL account behind the chosen bank_accounts row.
    const { data: bankRow, error: bankErr } = await admin
      .from("bank_accounts")
      .select("id, account_id, name, organization_id")
      .eq("id", batch.bank_account_id)
      .maybeSingle();
    if (bankErr || !bankRow) return json({ error: "Selected bank account not found" }, 400);
    if (bankRow.organization_id !== batch.organization_id) {
      return json({ error: "Bank account does not belong to this organization" }, 400);
    }
    if (!bankRow.account_id) {
      return json({
        error: `Bank account "${bankRow.name}" is not linked to a GL account. Set its account_id before paying payroll from it.`,
      }, 400);
    }

    // ── 2. Resolve net_salary_payable from default_account_settings
    const { data: settings } = await admin
      .from("default_account_settings")
      .select("setting_key, account_id, business_id")
      .eq("organization_id", batch.organization_id)
      .eq("setting_key", "net_salary_payable");
    let netPayable: string | null = null;
    for (const s of (settings || []).filter((x: any) => !x.business_id)) netPayable = s.account_id;
    for (const s of (settings || []).filter((x: any) => x.business_id === batch.business_id)) {
      netPayable = s.account_id;
    }
    if (!netPayable) {
      return json({
        error:
          "Missing 'net_salary_payable' account mapping. Configure it in Payroll → Configuration → Account Mapping.",
      }, 400);
    }

    // ── 3. Pull batch items (for payslip propagation)
    const { data: items, error: iErr } = await admin
      .from("payroll_payment_batch_items")
      .select("id, payslip_id, amount, status")
      .eq("batch_id", batch.id);
    if (iErr) return json({ error: iErr.message }, 500);
    if (!items || items.length === 0) return json({ error: "Batch has no items" }, 400);

    // ── 4. Branch + payment date
    const { data: run } = await admin
      .from("payroll_runs")
      .select("branch_id, payroll_number, pay_period_end")
      .eq("id", batch.payroll_run_id!)
      .maybeSingle();
    const paymentDate = body.payment_date || new Date().toISOString().slice(0, 10);

    // ── 5. Build + post the cash JE
    const total = Number(batch.total_amount || 0);
    if (total <= 0) return json({ error: "Batch total is zero" }, 400);

    const { data: jeNumber } = await admin.rpc("get_next_journal_entry_number", {
      _org_id: batch.organization_id,
    });

    const lines = [
      {
        account_id: netPayable,
        debit: total,
        credit: 0,
        description: `Payroll payment ${batch.batch_number} - clear net pay liability`,
        contact_id: null,
      },
      {
        account_id: bankRow.account_id,
        debit: 0,
        credit: total,
        description: `Payroll payment ${batch.batch_number} - bank disbursement`,
        contact_id: null,
      },
    ];

    const { data: jeId, error: jeErr } = await admin.rpc("post_journal_entry_atomic", {
      _org_id: batch.organization_id,
      _business_id: batch.business_id || null,
      _entry_number: String(jeNumber || `JE-${Date.now()}`),
      _entry_date: paymentDate,
      _reference: batch.batch_number,
      _description: `Payroll payment ${batch.batch_number} (run ${run?.payroll_number || ""})`,
      _source_type: "payroll_payment",
      _source_id: batch.id,
      _created_by: userId,
      _is_closing: false,
      _is_adjusting: false,
      _lines: lines,
    });
    if (jeErr) return json({ error: `Cash JE posting failed: ${jeErr.message}` }, 500);

    // ── 6. Mark items paid
    const nowIso = new Date().toISOString();
    await admin
      .from("payroll_payment_batch_items")
      .update({
        status: "paid",
        paid_at: nowIso,
        payment_reference: body.payment_reference || null,
      } as any)
      .eq("batch_id", batch.id);

    // ── 7. Stamp the batch (status guard prevents races).
    // Lifecycle trigger enforces the legal source statuses; we accept the
    // fast-path (draft|pending) and the full pipeline (locked/exported/
    // transmitted/partially_paid/failed) so this edge fn works whether the
    // operator approved-locked-exported the batch first or jumped straight
    // to Mark paid.
    const { error: stampErr } = await admin
      .from("payroll_payment_batches")
      .update({
        status: "paid",
        paid_by: userId,
        paid_at: nowIso,
        confirmed_at: nowIso,
        confirmed_by: userId,
        payment_date: paymentDate,
        reference: body.payment_reference || null,
        payment_journal_entry_id: jeId,
      } as any)
      .eq("id", batch.id)
      .in("status", [
        "draft", "pending", "approved", "locked",
        "exported", "transmitted", "partially_paid", "failed",
      ]);
    if (stampErr) return json({ error: stampErr.message }, 500);

    // ── 8. Propagate paid status to payslips
    const payslipIds = items.map((i: any) => i.payslip_id).filter(Boolean);
    if (payslipIds.length) {
      await admin
        .from("payslips")
        .update({
          status: "paid",
          paid_at: nowIso,
          payment_reference: body.payment_reference || null,
        } as any)
        .in("id", payslipIds);
    }

    // ── 8b. If every payslip in the run is now paid, flip the run too.
    // (Allowed by the paid-path guard because admin runs as service_role.)
    if (batch.payroll_run_id) {
      const { count: unpaidCount } = await admin
        .from("payslips")
        .select("id", { count: "exact", head: true })
        .eq("payroll_run_id", batch.payroll_run_id)
        .neq("status", "paid");
      if ((unpaidCount ?? 0) === 0) {
        await admin
          .from("payroll_runs")
          .update({
            status: "paid",
            payment_date: paymentDate,
            updated_at: nowIso,
          } as any)
          .eq("id", batch.payroll_run_id);
      }
    }

    // ── 9. Audit
    await admin.from("audit_logs").insert({
      organization_id: batch.organization_id,
      business_id: batch.business_id || null,
      user_id: userId,
      action: "payroll_payment_posted",
      entity_type: "payroll_payment_batch",
      entity_id: batch.id,
      entity_name: batch.batch_number,
      new_values: {
        journal_entry_id: jeId,
        total: total,
        bank_account_id: batch.bank_account_id,
        payslip_count: payslipIds.length,
      },
      changes_summary: `Marked payroll batch ${batch.batch_number} paid and posted cash JE`,
    });

    return json({
      ok: true,
      journal_entry_id: jeId,
      payslip_count: payslipIds.length,
      total,
    });
  } catch (e: any) {
    return json({ error: e?.message || "Internal error" }, 500);
  }
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}