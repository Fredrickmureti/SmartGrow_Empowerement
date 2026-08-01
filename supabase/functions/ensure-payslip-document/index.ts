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
import {
  buildPayslipSnapshot,
  PayslipNotFoundError,
} from "../_shared/payslip/payslipSnapshot.ts";
import { authorizePayslipAccess, isDenied } from "../_shared/payslip/payslipAccess.ts";

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
    const payslipId = body?.payslip_id ?? null;
    const payrollRunId = body?.payroll_run_id ?? null;
    const employeeId = body?.employee_id ?? null;

    if (!payslipId && !(payrollRunId && employeeId)) {
      return json({ error: "Provide payslip_id or payroll_run_id + employee_id" }, 400);
    }

    let built;
    try {
      built = await buildPayslipSnapshot(supabase, {
        payslipId,
        payrollRunId,
        employeeId,
      });
    } catch (err) {
      if (err instanceof PayslipNotFoundError) {
        return json({ error: "Payslip not found", detail: err.message }, 404);
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

    if (!built.organizationId) {
      return json({ error: "payslip has no organization; cannot archive" }, 422);
    }

    const { data: recordId, error: rpcError } = await supabase.rpc("ensure_document_record", {
      p_kind_code: "payroll.payslip",
      p_organization_id: built.organizationId,
      p_source_module: "payroll",
      p_source_doc_type: "payslip",
      p_source_doc_id: built.snapshot.payslip_id,
      p_business_id: built.businessId,
      p_branch_id: built.branchId,
      p_party_kind: built.employeeId ? "employee" : null,
      p_party_id: built.employeeId,
      p_currency: built.currency,
      p_locale: null,
      p_metadata: { source: "ensure-payslip-document" },
      p_document_number: built.documentNumber,
      p_document_date: built.documentDate,
      p_snapshot: built.snapshot,
    });

    if (rpcError) {
      console.error("[ensure-payslip-document] ensure_document_record failed", rpcError);
      return json({ error: "document_record_failed", detail: rpcError.message }, 500);
    }

    return json({
      document_record_id: recordId,
      document_number: built.documentNumber,
      filename: built.filename,
      organization_id: built.organizationId,
      business_id: built.businessId,
      branch_id: built.branchId,
    });
  } catch (error) {
    console.error("[ensure-payslip-document] failure", error);
    return json({ error: (error as Error).message }, 500);
  }
});
