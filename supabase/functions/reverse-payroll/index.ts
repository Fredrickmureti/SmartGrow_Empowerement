/**
 * Atomic Payroll Reversal — thin wrapper around `payroll_reverse_run_atomic`.
 *
 * The entire reversal flow (negated sub-ledger run + negated payslips +
 * terminal status flip + canonical GL void + audit log) now runs inside a
 * single DB transaction in the RPC. This function only:
 *   1. Validates the JWT.
 *   2. Verifies the payroll app entitlement.
 *   3. Calls the RPC and maps its error hints to HTTP codes.
 *
 * Idempotency, numbering, branch propagation, the "missing GL entry" guard,
 * and the "already reversed → terminal status" rule all live in the RPC, so
 * a second click on Reverse returns the existing reversal envelope with
 * `idempotent: true` instead of a 500.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Map RPC error HINTs (or message fragments) to HTTP status + machine code.
// Note: we also propagate the raw `hint` string in the response body so the
// frontend can pick a specific message (e.g. IDENTITY_REQUIRED vs
// PAYROLL_REVERSE_FORBIDDEN) for ERRCODE 42501 failures.
function mapRpcError(err: { message?: string; hint?: string | null; code?: string | null }) {
  const hint = (err.hint || "").toUpperCase();
  const msg = err.message || "Reversal failed";
  switch (hint) {
    case "ALREADY_REVERSED":
      return { status: 409, body: { error: msg, code: "ALREADY_REVERSED", hint } };
    case "INVALID_STATE":
    case "IS_REVERSAL":
      return { status: 409, body: { error: msg, code: "INVALID_STATE", hint } };
    case "MISSING_GL_ENTRY":
      return { status: 422, body: { error: msg, code: "MISSING_GL_ENTRY", hint } };
    case "PERIOD_LOCKED":
      return { status: 409, body: { error: msg, code: "PERIOD_LOCKED", hint } };
    case "NO_PAYSLIPS":
      return { status: 422, body: { error: msg, code: "NO_PAYSLIPS", hint } };
    default:
      if (err.code === "P0002") return { status: 404, body: { error: msg, code: "NOT_FOUND", hint } };
      if (err.code === "42501") return { status: 403, body: { error: msg, code: "PERMISSION_DENIED", hint } };
      return { status: 500, body: { error: msg, code: err.code || "INTERNAL_ERROR", hint } };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = authHeader.replace("Bearer ", "");
    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userError } = await supabaseUser.auth.getUser(token);
    if (userError || !userData?.user) {
      return jsonResponse(401, { error: "Unauthorized" });
    }
    const userId = userData.user.id;

    const { payroll_run_id, organization_id, reason, post_to_gl, reversal_date } =
      await req.json();

    if (!payroll_run_id || !organization_id || !reason) {
      return jsonResponse(400, {
        error: "Missing required fields: payroll_run_id, organization_id, reason",
      });
    }

    // Subscription entitlement
    const { checkAppEntitlement, entitlementDeniedResponse } = await import(
      "../_shared/entitlementCheck.ts"
    );
    const entResult = await checkAppEntitlement(supabaseAdmin, organization_id, "payroll", {
      requireInstalled: true,
    });
    if (!entResult.allowed) return entitlementDeniedResponse(entResult, corsHeaders);

    // Single atomic call. All state changes commit or roll back together.
    const { data, error } = await supabaseAdmin.rpc("payroll_reverse_run_atomic", {
      _run_id: payroll_run_id,
      _user_id: userId,
      _reason: reason,
      _post_to_gl: post_to_gl !== false,
      _reversal_date: reversal_date ?? null,
    } as any);

    if (error) {
      console.error("payroll_reverse_run_atomic failed:", error);
      const mapped = mapRpcError(error as any);
      return jsonResponse(mapped.status, mapped.body);
    }

    // Phase 3.4-followup #6 — invert correction-adjuster ledger entries
    // when the reversed run was a correction. Gated behind the same
    // PAYROLL_CORRECTION_ADJUSTERS_V2 flag as the forward path so the two
    // sides stay symmetric. Failure here is logged but does not roll back
    // the atomic reversal (the GL void already committed).
    const v2 = (Deno.env.get("PAYROLL_CORRECTION_ADJUSTERS_V2") ?? "").toLowerCase() === "true";
    if (v2) {
      const reversalRunId = (data as any)?.reversal_run_id ?? null;
      const { error: invErr } = await supabaseAdmin.rpc("payroll_invert_correction_adjustments", {
        _original_run_id: payroll_run_id,
        _reversal_run_id: reversalRunId,
        _user_id: userId,
      } as any);
      if (invErr) {
        console.error("payroll_invert_correction_adjustments failed:", invErr);
      }
    }

    return jsonResponse(200, data);
  } catch (error: any) {
    console.error("Payroll reversal error:", error);
    return jsonResponse(500, { error: error?.message || "Internal server error" });
  }
});
