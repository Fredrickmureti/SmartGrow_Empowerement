/**
 * reverse-payroll-payment
 *
 * Reverses a previously-paid payroll payment batch:
 *   1. Validates the batch is in a reversible status (paid | partially_paid).
 *   2. Posts a reversing cash JE that mirrors the original payment_journal_entry_id
 *      (debits original credits, credits original debits) — atomic via
 *      `post_journal_entry_atomic`.
 *   3. Flips every paid batch item to `reversed` and clears payslip.paid_at /
 *      payslip.status back to `processed`.
 *   4. Stamps the batch as `reversed` with reversal_je_id / reversed_by /
 *      reversed_at / reversal_reason.
 *   5. Emits a `business_event_outbox` event and writes an audit row.
 *
 * Idempotent: if the batch already carries reversal_je_id the call returns it
 * without re-posting.
 *
 * Auth: caller must have `payroll.pay` (re-uses `user_can_pay_payroll` for
 * SoD), and must not be the original creator/approver/payer of the batch.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Body {
  batch_id: string;
  reason: string;
  reversal_date?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: who } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!who?.user) return json({ error: "Unauthorized" }, 401);
    const userId = who.user.id;

    const body = (await req.json()) as Body;
    if (!body?.batch_id) return json({ error: "batch_id required" }, 400);
    if (!body?.reason || body.reason.trim().length < 3) {
      return json({ error: "reason required (min 3 chars)" }, 400);
    }

    // 1) Load batch
    const { data: batch, error: bErr } = await admin
      .from("payroll_payment_batches")
      .select(
        "id, organization_id, business_id, payroll_run_id, status, total_amount, batch_number, " +
          "payment_journal_entry_id, reversal_je_id, paid_by, approved_by, created_by",
      )
      .eq("id", body.batch_id)
      .maybeSingle();
    if (bErr || !batch) return json({ error: "Batch not found" }, 404);

    if (batch.reversal_je_id) {
      return json({ ok: true, already_reversed: true, reversal_je_id: batch.reversal_je_id });
    }
    if (!["paid", "partially_paid"].includes(String(batch.status))) {
      return json({
        error: `Batch is ${batch.status}; only paid/partially_paid batches can be reversed.`,
        code: "INVALID_STATE",
      }, 409);
    }
    if (!batch.payment_journal_entry_id) {
      return json({ error: "Batch has no payment journal entry to reverse", code: "MISSING_GL_ENTRY" }, 422);
    }

    // 2) SoD — reuse payroll pay check + block the original payer
    const { data: canPay, error: sodErr } = await admin.rpc(
      "user_can_pay_payroll",
      { _user_id: userId, _org_id: batch.organization_id, _run_id: batch.payroll_run_id },
    );
    if (sodErr) return json({ error: sodErr.message, code: "SOD_CHECK_FAILED" }, 500);
    if (canPay !== true) {
      return json({
        error: "SoD: reversal requires payroll Pay permission and you must not be the creator/approver/payer.",
        code: "PERMISSION_DENIED",
      }, 403);
    }
    if (batch.paid_by === userId) {
      return json({
        error: "SoD: the user who marked the batch paid cannot reverse it.",
        code: "PERMISSION_DENIED",
      }, 403);
    }

    // 3) Load the original JE lines
    const { data: origLines, error: jlErr } = await admin
      .from("journal_entry_lines")
      .select("account_id, debit_amount, credit_amount, description, contact_id")
      .eq("journal_entry_id", batch.payment_journal_entry_id);
    if (jlErr || !origLines || origLines.length === 0) {
      return json({ error: "Original payment JE has no lines" }, 422);
    }

    const reversalDate = body.reversal_date || new Date().toISOString().slice(0, 10);

    const { data: jeNumber } = await admin.rpc("get_next_journal_entry_number", {
      _org_id: batch.organization_id,
    });

    const lines = origLines.map((l: any) => ({
      account_id: l.account_id,
      debit: Number(l.credit_amount || 0),
      credit: Number(l.debit_amount || 0),
      description: `REVERSAL: ${l.description || ""}`.slice(0, 500),
      contact_id: l.contact_id,
    }));

    const { data: reversalJeId, error: jeErr } = await admin.rpc("post_journal_entry_atomic", {
      _org_id: batch.organization_id,
      _business_id: batch.business_id || null,
      _entry_number: String(jeNumber || `JE-REV-${Date.now()}`),
      _entry_date: reversalDate,
      _reference: `${batch.batch_number}-REV`,
      _description: `Reversal of payroll payment ${batch.batch_number}: ${body.reason}`,
      _source_type: "payroll_payment_reversal",
      _source_id: batch.id,
      _created_by: userId,
      _is_closing: false,
      _is_adjusting: true,
      _lines: lines,
    });
    if (jeErr) return json({ error: `Reversal JE posting failed: ${jeErr.message}` }, 500);

    // 4) Flip paid items → reversed; collect payslip ids
    const { data: paidItems } = await admin
      .from("payroll_payment_batch_items")
      .select("id, payslip_id")
      .eq("batch_id", batch.id)
      .eq("item_status", "paid");

    if (paidItems && paidItems.length > 0) {
      await admin
        .from("payroll_payment_batch_items")
        .update({
          item_status: "reversed",
          reversed_at: new Date().toISOString(),
          reversed_by: userId,
        } as any)
        .in("id", paidItems.map((i: any) => i.id));

      const payslipIds = paidItems.map((i: any) => i.payslip_id).filter(Boolean);
      if (payslipIds.length) {
        await admin
          .from("payslips")
          .update({
            status: "processed",
            paid_at: null,
            payment_reference: null,
          } as any)
          .in("id", payslipIds);
      }
    }

    // 5) Stamp the batch (lifecycle trigger enforces paid|partially_paid → reversed)
    const { error: stampErr } = await admin
      .from("payroll_payment_batches")
      .update({
        status: "reversed",
        reversal_je_id: reversalJeId,
        reversed_by: userId,
        reversed_at: new Date().toISOString(),
        reversal_reason: body.reason,
      } as any)
      .eq("id", batch.id)
      .in("status", ["paid", "partially_paid"]);
    if (stampErr) return json({ error: stampErr.message }, 500);

    // 6) Flip the run back to processed if it was 'paid'
    if (batch.payroll_run_id) {
      await admin
        .from("payroll_runs")
        .update({
          status: "processed",
          payment_date: null,
          updated_at: new Date().toISOString(),
        } as any)
        .eq("id", batch.payroll_run_id)
        .eq("status", "paid");
    }

    // 7) Audit + event
    await admin.from("audit_logs").insert({
      organization_id: batch.organization_id,
      business_id: batch.business_id || null,
      user_id: userId,
      action: "payroll_payment_reversed",
      entity_type: "payroll_payment_batch",
      entity_id: batch.id,
      entity_name: batch.batch_number,
      new_values: {
        reversal_je_id: reversalJeId,
        original_je_id: batch.payment_journal_entry_id,
        reason: body.reason,
      },
      changes_summary: `Reversed payroll payment batch ${batch.batch_number}`,
    });

    await admin.from("business_event_outbox").insert({
      organization_id: batch.organization_id,
      business_id: batch.business_id || null,
      event_type: "payroll.payment_batch.reversed",
      aggregate_type: "payroll_payment_batch",
      aggregate_id: batch.id,
      payload: {
        batch_id: batch.id,
        batch_number: batch.batch_number,
        reversal_je_id: reversalJeId,
        original_je_id: batch.payment_journal_entry_id,
        reason: body.reason,
        actor: userId,
      },
      emitted_by: userId,
    } as any);

    return json({ ok: true, reversal_je_id: reversalJeId });
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
