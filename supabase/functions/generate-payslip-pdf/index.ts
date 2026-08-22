/**
 * generate-payslip-pdf — thin adapter over the shared payslip projection.
 *
 * Kept as a transport shim for server-side callers that still want raw
 * payslip bytes (currently `send-document-email`). It owns NO projection
 * and NO layout: both live in `_shared/payslip/payslipSnapshot.ts`, which
 * is the same code the canonical `render-document` path uses for
 * `payroll.payslip`. There is therefore exactly one payslip document in
 * the system regardless of which door produced it.
 *
 * Interactive/browser surfaces must NOT call this endpoint — they go
 * through `PrintService` (document record -> render-document), so the
 * print ledger and reprint history cover them.
 *
 * Accepts: { payslip_id } or { payroll_run_id, employee_id }
 * Returns: application/pdf binary
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import {
  buildPayslipSnapshot,
  renderPayslipSnapshotToPdf,
  PayslipNotFoundError,
} from "../_shared/payslip/payslipSnapshot.ts";
import { authorizePayslipAccess, isDenied } from "../_shared/payslip/payslipAccess.ts";
import { ensurePayslipDocument } from "../_shared/payslip/ensurePayslipDocument.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const { payslip_id, payroll_run_id, employee_id, mode } = body ?? {};

    // Compatibility door: some environments do not have the canonical
    // `ensure-payslip-document` function deployed. Interactive surfaces
    // fall back here so payslips still reach the document engine.
    if (mode === "ensure_document") {
      const ensured = await ensurePayslipDocument(
        supabase,
        req,
        {
          payslipId: payslip_id ?? null,
          payrollRunId: payroll_run_id ?? null,
          employeeId: employee_id ?? null,
        },
        corsHeaders,
        "generate-payslip-pdf:ensure_document",
      );
      if (ensured.response) return ensured.response;
      return new Response(JSON.stringify(ensured.body), {
        status: ensured.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!payslip_id && !(payroll_run_id && employee_id)) {
      return new Response(
        JSON.stringify({ error: "Provide payslip_id or payroll_run_id + employee_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let built;
    try {
      built = await buildPayslipSnapshot(supabase, {
        payslipId: payslip_id ?? null,
        payrollRunId: payroll_run_id ?? null,
        employeeId: employee_id ?? null,
      });
    } catch (err) {
      if (err instanceof PayslipNotFoundError) {
        return new Response(
          JSON.stringify({ error: "Payslip not found", detail: err.message }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      throw err;
    }

    const access = await authorizePayslipAccess({
      supabase,
      req,
      organizationId: built.organizationId,
      employeeId: built.employeeId,
      corsHeaders,
    });
    if (isDenied(access)) return access.denied;

    const pdfBytes = await renderPayslipSnapshotToPdf(built.snapshot);

    return new Response(pdfBytes as unknown as BodyInit, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${built.filename}.pdf"`,
      },
    });
  } catch (error) {
    console.error("Payslip PDF generation error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
