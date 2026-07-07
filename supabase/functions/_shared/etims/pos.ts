/**
 * POS transaction → KRA eTIMS mapper. Pack-driven via adapter.ts.
 */
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders, loadProvider, loadCredentials, buildSalesPayload,
  postToProvider, upsertTransmission, type FiscalDocument,
} from "./adapter.ts";

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { organizationId, transactionId } = await req.json();
    if (!organizationId || !transactionId) {
      return new Response(JSON.stringify({ success: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { checkAppEntitlement, entitlementDeniedResponse } = await import("../entitlementCheck.ts");
    const ent = await checkAppEntitlement(supabase, organizationId, "etims");
    if (!ent.allowed) return entitlementDeniedResponse(ent, corsHeaders);

    const { data: tx } = await supabase.from("pos_transactions")
      .select("*, items:pos_transaction_items(*), payments:pos_transaction_payments(*)")
      .eq("id", transactionId).eq("organization_id", organizationId).single();
    if (!tx) {
      return new Response(JSON.stringify({ success: false, error: "Transaction not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const primaryPayment = (tx.payments ?? [])[0];
    const doc: FiscalDocument = {
      organization_id: organizationId,
      branch_id: tx.branch_id ?? null,
      document_kind: tx.total >= 0 ? "sale" : "return",
      source_doc_type: "pos_transactions",
      source_doc_id: tx.id,
      document_number: tx.receipt_number ?? tx.transaction_number ?? tx.id,
      document_date: tx.transaction_date ?? tx.created_at,
      customer: {
        name: tx.customer_name || "Walk-in Customer",
        tax_id: tx.customer_tax_id, phone: tx.customer_phone, address: null,
      },
      payment_method: primaryPayment?.payment_method ?? tx.payment_method,
      currency: tx.currency || "KES",
      subtotal: tx.subtotal || 0,
      tax_amount: tx.tax_amount || 0,
      total: tx.total || 0,
      notes: tx.notes,
      items: (tx.items ?? []).map((i: any) => ({
        product_id: i.product_id, description: i.product_name ?? i.description ?? "Item",
        quantity: i.quantity, unit_price: i.unit_price,
        line_total: i.line_total ?? i.total_price ?? 0,
        tax_amount: i.tax_amount || 0,
        discount_percent: i.discount_percent,
        tax_category: i.tax_category ?? null, tax_rate: i.tax_rate ?? null,
      })),
    };

    const { provider } = await loadProvider(supabase, organizationId);
    const creds = await loadCredentials(supabase, organizationId, doc.branch_id, provider.provider_key);
    const payload = buildSalesPayload(doc, provider, creds);
    const idem = `pos_transactions:${tx.id}:1`;

    await upsertTransmission(supabase, {
      organization_id: organizationId, branch_id: doc.branch_id,
      provider_key: provider.provider_key, document_kind: doc.document_kind,
      source_doc_type: doc.source_doc_type, source_doc_id: doc.source_doc_id,
      idempotency_key: idem, state: "transmitting", request_payload: payload,
    });

    const { status, body } = await postToProvider(provider, creds, "/saveTrnsSalesOsdc", payload);
    const success = status < 400 && body?.resultCd === "000";
    const cuNumber = body?.data?.rcptSign ?? null;
    const qrData = body?.data?.qrCodeUrl
      ?? (provider.qr_url_template && cuNumber ? provider.qr_url_template.replace("{signature}", cuNumber) : null);

    await upsertTransmission(supabase, {
      organization_id: organizationId, branch_id: doc.branch_id,
      provider_key: provider.provider_key, document_kind: doc.document_kind,
      source_doc_type: doc.source_doc_type, source_doc_id: doc.source_doc_id,
      idempotency_key: idem,
      state: success ? "succeeded" : "rejected",
      response_payload: body, fiscal_number: cuNumber,
      signature: body?.data?.rcptSign ?? null, qr_data: qrData,
      control_unit_id: body?.data?.sdcId ?? creds.device_serial,
      transmitted_at: success ? new Date().toISOString() : null,
      last_error: success ? null : (body?.resultMsg ?? `HTTP ${status}`),
    });

    return new Response(JSON.stringify({ success, cuNumber, qrCodeUrl: qrData, response: body }),
      { status: success ? 200 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("etims/pos error:", message);
    return new Response(JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}
