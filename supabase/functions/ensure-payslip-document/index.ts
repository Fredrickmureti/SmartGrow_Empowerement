/**
 * ensure-payslip-document — the payslip on-ramp to the document engine.
 *
 * A payslip's projection needs service-role reads (payslip_lines, YTD
 * aggregates, statutory identifier tables, tenant payroll settings), so
 * unlike sales documents the snapshot cannot be assembled in the browser.
 * This function is the server-side equivalent of a snapshot builder:
 *
 *   1. Build the frozen payslip snapshot (shared projection).
 *   2. Authorize the caller (employee themself, or `payroll.read`).
 *   3. Upsert the immutable `document_records` row via
 *      `ensure_document_record` under kind `payroll.payslip`.
 *
 * It returns the document record id. The client then hands that id to
 * `PrintService.printDocumentIntent`, so payslips get the same ledger
 * row, reprint history and disposition fan-out as every other document.
 * It never renders bytes and never prints.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { ensurePayslipDocument } from "../_shared/payslip/ensurePayslipDocument.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => null);
    const result = await ensurePayslipDocument(
      supabase,
      req,
      {
        payslipId: body?.payslip_id ?? null,
        payrollRunId: body?.payroll_run_id ?? null,
        employeeId: body?.employee_id ?? null,
      },
      corsHeaders,
      "ensure-payslip-document",
    );
    if (result.response) return result.response;
    return json(result.body, result.status);
  } catch (error) {
    console.error("[ensure-payslip-document] failure", error);
    return json({ error: (error as Error).message }, 500);
  }
});
