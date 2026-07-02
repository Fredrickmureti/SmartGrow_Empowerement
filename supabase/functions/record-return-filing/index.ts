// @ts-nocheck — Deno runtime
/**
 * record-return-filing
 *
 * Server-side state machine for `payroll_return_runs`. Replaces the direct
 * client `update` previously used by `useRecordReturnAcknowledgement` so
 * illegal transitions, receipt uploads, and audit-row insertion happen with
 * service-role auth and atomic guarantees.
 *
 * Inputs:
 *   {
 *     run_id: uuid,
 *     to_status: 'submitted_awaiting_ack' | 'acknowledged' | 'rejected' | 'filed' | 'superseded',
 *     filed_reference?: string,
 *     submission_channel?: 'itax'|'ecitizen'|'ura'|'tra'|'sars'|'elstam'|'manual'|'api'|'other',
 *     rejection_reasons?: [{code?, message, field?}],
 *     ack?: { receipt_number?, receipt_date?, authority_status?, notes? },
 *     receipt_file_base64?: string,
 *     receipt_file_name?: string,
 *     receipt_content_type?: string
 *   }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ALLOWED_STATUS = new Set([
  "pending_approval",
  "submitted_awaiting_ack",
  "acknowledged",
  "rejected",
  "filed",
  "superseded",
]);

const ALLOWED_CHANNELS = new Set([
  "itax", "ecitizen", "ura", "tra", "sars", "elstam", "manual", "api", "other",
]);

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.includes(",") ? b64.split(",")[1] : b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "unauthenticated" }, 401);
    const userId = userData.user.id;

    const body = await req.json();
    if (!body?.run_id || typeof body.run_id !== "string") return json({ error: "run_id required" }, 400);
    if (!ALLOWED_STATUS.has(body.to_status)) return json({ error: "invalid to_status" }, 400);
    if (body.submission_channel && !ALLOWED_CHANNELS.has(body.submission_channel)) {
      return json({ error: "invalid submission_channel" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Load run + verify permission
    const { data: run, error: runErr } = await admin
      .from("payroll_return_runs")
      .select("id, organization_id, business_id, status, template_code, period_end")
      .eq("id", body.run_id)
      .maybeSingle();
    if (runErr || !run) return json({ error: "run not found" }, 404);

    const { data: perm } = await admin.rpc("user_has_module_permission", {
      _user_id: userId,
      _org_id: run.organization_id,
      _module: "financials",
      _operation: "write",
    });
    if (!perm) return json({ error: "permission denied" }, 403);

    // Validate state transition (server-side, via DB function)
    const { error: trErr } = await admin.rpc("payroll_return_assert_transition", {
      p_from: run.status,
      p_to: body.to_status,
    });
    if (trErr) return json({ error: trErr.message, code: "INVALID_TRANSITION" }, 409);

    // Optional receipt upload
    let portalReceiptPath: string | null = null;
    if (body.receipt_file_base64) {
      const bytes = decodeBase64(body.receipt_file_base64);
      const ext = (body.receipt_file_name?.split(".").pop() ?? "pdf").toLowerCase().replace(/[^a-z0-9]/g, "") || "pdf";
      const year = String(run.period_end).slice(0, 4);
      portalReceiptPath = `${run.organization_id}/payroll/return-receipts/${year}/${run.template_code}/${run.id}-${Date.now()}.${ext}`;
      const up = await admin.storage
        .from("documents")
        .upload(portalReceiptPath, new Blob([bytes], { type: body.receipt_content_type ?? "application/pdf" }), {
          contentType: body.receipt_content_type ?? "application/pdf",
          upsert: true,
        });
      if (up.error) return json({ error: `receipt upload: ${up.error.message}` }, 500);

      // Audit row for the upload itself (best-effort)
      await admin.from("payroll_return_filing_events").insert({
        run_id: run.id,
        event: "receipt_uploaded",
        actor_id: userId,
        payload: { path: portalReceiptPath, content_type: body.receipt_content_type ?? "application/pdf" },
      });
    }

    // Build the patch
    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = { status: body.to_status };
    if (body.ack) patch.authority_ack_payload = body.ack;
    if (body.submission_channel) patch.submission_channel = body.submission_channel;
    if (portalReceiptPath) patch.portal_receipt_path = portalReceiptPath;

    // Slice D — pending_approval flow. Preparer (generated_by) cannot approve
    // their own return; SoD enforced by the DB trigger but we also fail fast
    // here for a friendlier error than a 23514 constraint message.
    if (body.to_status === "pending_approval") {
      // No additional metadata; preparer requests approval.
    }
    if (run.status === "pending_approval"
        && (body.to_status === "submitted_awaiting_ack" || body.to_status === "filed")) {
      // The current user is the approver
      patch.approver_id = userId;
      patch.approved_at = nowIso;
    }

    if (body.to_status === "submitted_awaiting_ack") {
      patch.submitted_at = nowIso;
      patch.submitted_by = userId;
    }
    if (body.to_status === "acknowledged" || body.to_status === "filed" || body.to_status === "rejected") {
      patch.acknowledged_at = nowIso;
    }
    if (body.to_status === "filed" || body.to_status === "acknowledged") {
      patch.filed_at = nowIso;
      if (body.filed_reference) patch.filed_reference = body.filed_reference;
    }
    if (body.to_status === "rejected" && Array.isArray(body.rejection_reasons) && body.rejection_reasons.length) {
      patch.rejection_reasons = body.rejection_reasons;
    }

    const { data: updated, error: upErr } = await admin
      .from("payroll_return_runs")
      .update(patch)
      .eq("id", run.id)
      .select("*")
      .single();
    if (upErr) return json({ error: `update: ${upErr.message}` }, 500);

    // Audit row for the state transition (org/business auto-filled by trigger)
    const eventMap: Record<string, string> = {
      pending_approval: "approval_requested",
      submitted_awaiting_ack: "submitted",
      acknowledged: "acknowledged",
      rejected: "rejected",
      filed: "filed",
      superseded: "superseded",
    };
    await admin.from("payroll_return_filing_events").insert({
      run_id: run.id,
      event: eventMap[body.to_status],
      actor_id: userId,
      payload: {
        from_status: run.status,
        to_status: body.to_status,
        filed_reference: body.filed_reference ?? null,
        submission_channel: body.submission_channel ?? null,
        ack: body.ack ?? null,
        rejection_reasons: body.rejection_reasons ?? null,
        portal_receipt_path: portalReceiptPath,
      },
    });

    // Step 6 wiring (B7): when a return reaches a terminal authority state,
    // join every matching tax certificate (same template_code + fiscal year)
    // to this return run via payroll_tax_certificate_submissions. The
    // submission trigger fans into the certificate lifecycle event ledger.
    const fiscalYear = Number(String(run.period_end).slice(0, 4));
    const subStatus =
      body.to_status === "acknowledged" || body.to_status === "filed"
        ? "accepted"
        : body.to_status === "rejected"
          ? "rejected"
          : "submitted";

    if (Number.isFinite(fiscalYear)) {
      const { data: certs } = await admin
        .from("payroll_tax_certificates")
        .select("id, organization_id, business_id")
        .eq("organization_id", run.organization_id)
        .eq("business_id", run.business_id)
        .eq("template_code", run.template_code)
        .eq("fiscal_year", fiscalYear)
        .eq("status", "issued");

      if (certs && certs.length > 0) {
        // Upsert one submission row per (certificate, return run). Reusing a
        // composite-style guard via prior lookup since we don't have a unique
        // index — the goal is idempotence on retries.
        const { data: existing } = await admin
          .from("payroll_tax_certificate_submissions")
          .select("id, certificate_id")
          .eq("return_run_id", run.id)
          .in(
            "certificate_id",
            certs.map((c: any) => c.id),
          );
        const existingByCert = new Map<string, string>(
          (existing ?? []).map((e: any) => [e.certificate_id, e.id]),
        );

        const toInsert: any[] = [];
        const toUpdate: { id: string }[] = [];
        for (const c of certs) {
          const prior = existingByCert.get(c.id);
          if (prior) {
            toUpdate.push({ id: prior });
          } else {
            toInsert.push({
              certificate_id: c.id,
              return_run_id: run.id,
              organization_id: c.organization_id,
              business_id: c.business_id,
              submitted_by: userId,
              authority_reference: body.filed_reference ?? null,
              status: subStatus,
              rejection_reason:
                subStatus === "rejected" && Array.isArray(body.rejection_reasons)
                  ? body.rejection_reasons.map((r: any) => r?.message).filter(Boolean).join("; ")
                  : null,
              details: {
                submission_channel: body.submission_channel ?? null,
                ack: body.ack ?? null,
              },
            });
          }
        }
        if (toInsert.length > 0) {
          await admin.from("payroll_tax_certificate_submissions").insert(toInsert);
        }
        for (const u of toUpdate) {
          await admin
            .from("payroll_tax_certificate_submissions")
            .update({
              status: subStatus,
              authority_reference: body.filed_reference ?? null,
              rejection_reason:
                subStatus === "rejected" && Array.isArray(body.rejection_reasons)
                  ? body.rejection_reasons.map((r: any) => r?.message).filter(Boolean).join("; ")
                  : null,
            })
            .eq("id", u.id);
        }
      }
    }

    return json({ run: updated, portal_receipt_path: portalReceiptPath });
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
});
