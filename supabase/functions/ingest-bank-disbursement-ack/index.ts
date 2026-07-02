/**
 * ingest-bank-disbursement-ack
 *
 * Ingest endpoint for bank disbursement file acknowledgements / rejections /
 * per-payment confirmations. Designed to be called by a bank integration
 * webhook or a scheduled poller.
 *
 * Request body:
 * {
 *   file_id: string,                  // payroll_bank_export_files.id
 *   outcome: "acknowledged" | "rejected" | "partial",
 *   ack_reference?: string,
 *   reason?: string,                  // required if rejected
 *   payload?: object,                 // raw bank response, archived
 *   item_results?: Array<{            // optional per-item confirmations
 *     item_id: string,                // payroll_payment_batch_items.id
 *     status: "paid" | "failed",
 *     payment_reference?: string,
 *     failure_reason?: string,
 *     paid_amount?: number,
 *   }>
 * }
 *
 * Auth: requires a Bearer token. For machine-to-machine the caller can pass
 * the project's INGEST_BANK_DISBURSEMENT_SHARED_SECRET as `x-ingest-secret`
 * — in that case we skip the JWT check.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ingest-secret",
};

interface ItemResult {
  item_id: string;
  status: "paid" | "failed";
  payment_reference?: string;
  failure_reason?: string;
  paid_amount?: number;
}

interface Body {
  file_id: string;
  outcome: "acknowledged" | "rejected" | "partial";
  ack_reference?: string;
  reason?: string;
  payload?: Record<string, unknown>;
  item_results?: ItemResult[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const sharedSecret = Deno.env.get("INGEST_BANK_DISBURSEMENT_SHARED_SECRET");
    const presentedSecret = req.headers.get("x-ingest-secret");
    const isMachine = !!sharedSecret && presentedSecret === sharedSecret;

    let userId: string | null = null;
    if (!isMachine) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: who } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
      if (!who?.user) return json({ error: "Unauthorized" }, 401);
      userId = who.user.id;
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = (await req.json()) as Body;
    if (!body?.file_id) return json({ error: "file_id required" }, 400);
    if (!["acknowledged", "rejected", "partial"].includes(body.outcome)) {
      return json({ error: "outcome must be acknowledged | rejected | partial" }, 400);
    }

    // Load file
    const { data: file, error: fErr } = await admin
      .from("payroll_bank_export_files")
      .select("id, organization_id, business_id, batch_id, status")
      .eq("id", body.file_id)
      .maybeSingle();
    if (fErr || !file) return json({ error: "Bank export file not found" }, 404);

    // ---------- Apply per-item confirmations first (works for any outcome) ----------
    const itemResults = body.item_results ?? [];
    let appliedItems = 0;
    for (const r of itemResults) {
      if (r.status === "paid") {
        const { error } = await admin.rpc("payroll_payment_item_mark_paid", {
          _item_id: r.item_id,
          _payment_reference: r.payment_reference ?? null,
          _paid_amount: r.paid_amount ?? null,
        });
        if (!error) appliedItems++;
      } else if (r.status === "failed") {
        const { error } = await admin.rpc("payroll_payment_item_mark_failed", {
          _item_id: r.item_id,
          _failure_reason: r.failure_reason ?? "Bank rejected disbursement",
        });
        if (!error) appliedItems++;
      }
    }

    // ---------- Flip the file lifecycle ----------
    let rpcName: string;
    let rpcArgs: Record<string, unknown>;
    if (body.outcome === "acknowledged" || body.outcome === "partial") {
      rpcName = "payroll_bank_export_file_record_acknowledgement";
      rpcArgs = {
        _file_id: body.file_id,
        _ack_reference: body.ack_reference ?? `ACK-${Date.now()}`,
        _payload: body.payload ?? null,
      };
    } else {
      if (!body.reason || body.reason.trim().length < 3) {
        return json({ error: "reason required when outcome=rejected (min 3 chars)" }, 400);
      }
      rpcName = "payroll_bank_export_file_record_rejection";
      rpcArgs = {
        _file_id: body.file_id,
        _reason: body.reason,
        _payload: body.payload ?? null,
      };
    }

    // Only flip if file is still in 'transmitted' (acknowledged/rejected are terminal)
    if (file.status === "transmitted") {
      const { error: rpcErr } = await admin.rpc(rpcName, rpcArgs as any);
      if (rpcErr) return json({ error: rpcErr.message, code: "LIFECYCLE_REJECTED" }, 409);
    } else if (file.status !== "acknowledged" && file.status !== "rejected") {
      return json({
        error: `File is in status ${file.status}; must be 'transmitted' before acknowledgement`,
        code: "INVALID_STATE",
      }, 409);
    }

    // ---------- Audit ----------
    await admin.from("audit_logs").insert({
      organization_id: file.organization_id,
      business_id: file.business_id,
      user_id: userId,
      action: `bank_disbursement_${body.outcome}`,
      entity_type: "payroll_bank_export_file",
      entity_id: file.id,
      entity_name: body.ack_reference ?? body.file_id,
      new_values: {
        outcome: body.outcome,
        ack_reference: body.ack_reference,
        items_applied: appliedItems,
        items_total: itemResults.length,
      },
      changes_summary: `Bank disbursement ${body.outcome} for file ${file.id}`,
    });

    return json({
      ok: true,
      file_id: file.id,
      batch_id: file.batch_id,
      outcome: body.outcome,
      items_applied: appliedItems,
      items_total: itemResults.length,
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
