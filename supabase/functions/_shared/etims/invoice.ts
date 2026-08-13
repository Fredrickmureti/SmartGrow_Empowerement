/**
 * Invoice → KRA eTIMS mapper (Kenya pack-driven).
 * All KRA specifics come from the localization pack via `adapter.ts`.
 */
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  loadProvider,
  loadCredentials,
  buildSalesPayload,
  postToProvider,
  upsertTransmission,
  type FiscalDocument,
} from "./adapter.ts";

async function toFiscalDocument(supabase: any, orgId: string, invoiceId: string): Promise<{ doc: FiscalDocument; invoice: any } | null> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("*, contact:contacts(*), items:invoice_items(*)")
    .eq("id", invoiceId)
    .eq("organization_id", orgId)
    .single();
  if (!invoice) return null;

  const items = await Promise.all((invoice.items ?? []).map(async (item: any) => {
    let taxCategory: string | null = null;
    let taxRate: number | null = null;
    let cls: string | null = null;
    let unit: string | null = null;
    let pkg: string | null = null;
    if (item.product_id) {
      const { data: product } = await supabase
        .from("products")
        .select("tax_rate_id")
        .eq("id", item.product_id)
        .single();
      // Country-specific fiscal metadata lives in product_tax_localization,
      // never on the product master.
      const { data: loc } = await supabase
        .from("product_tax_localization")
        .select("classification_code, unit_code, packaging_unit")
        .eq("product_id", item.product_id)
        .eq("jurisdiction", "KE")
        .maybeSingle();
      cls = loc?.classification_code ?? null;
      unit = loc?.unit_code ?? null;
      pkg = loc?.packaging_unit ?? null;
      if (product?.tax_rate_id) {
        const { data: tr } = await supabase
          .from("tax_rates").select("etims_tax_code, rate").eq("id", product.tax_rate_id).single();
        taxCategory = tr?.etims_tax_code ?? null;
        taxRate = tr?.rate ?? null;
      }
    }
    return {
      product_id: item.product_id,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      line_total: item.line_total,
      tax_amount: item.tax_amount || 0,
      discount_percent: item.discount_percent,
      etims_classification_code: cls,
      etims_unit_code: unit,
      etims_packaging_unit: pkg,
      tax_category: taxCategory,
      tax_rate: taxRate,
    };
  }));

  return {
    invoice,
    doc: {
      organization_id: orgId,
      branch_id: invoice.branch_id ?? null,
      document_kind: invoice.total >= 0 ? "invoice" : "credit_note",
      source_doc_type: "invoices",
      source_doc_id: invoice.id,
      document_number: invoice.invoice_number,
      document_date: invoice.invoice_date,
      customer: {
        name: invoice.contact?.name || "Walk-in Customer",
        tax_id: invoice.contact?.tax_id,
        phone: invoice.contact?.phone,
        address: invoice.contact?.address_line1,
      },
      payment_method: invoice.payment_method,
      currency: invoice.currency || "KES",
      subtotal: invoice.subtotal || 0,
      tax_amount: invoice.tax_amount || 0,
      total: invoice.total || 0,
      notes: invoice.notes,
      items,
    },
  };
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { organizationId, invoiceId } = await req.json();
    if (!organizationId || !invoiceId) {
      return new Response(JSON.stringify({ success: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { checkAppEntitlement, entitlementDeniedResponse } = await import("../entitlementCheck.ts");
    const ent = await checkAppEntitlement(supabase, organizationId, "etims");
    if (!ent.allowed) return entitlementDeniedResponse(ent, corsHeaders);

    const mapped = await toFiscalDocument(supabase, organizationId, invoiceId);
    if (!mapped) {
      return new Response(JSON.stringify({ success: false, error: "Invoice not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { doc, invoice } = mapped;

    const { provider } = await loadProvider(supabase, organizationId);
    const creds = await loadCredentials(supabase, organizationId, doc.branch_id, provider.provider_key);

    if (invoice.etims_transmission_status === "success" && invoice.etims_cu_number) {
      return new Response(JSON.stringify({ success: true, alreadyTransmitted: true, cuNumber: invoice.etims_cu_number }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const payload = buildSalesPayload(doc, provider, creds);
    const idem = `invoices:${invoice.id}:1`;
    await upsertTransmission(supabase, {
      organization_id: organizationId,
      branch_id: doc.branch_id,
      provider_key: provider.provider_key,
      document_kind: doc.document_kind,
      source_doc_type: doc.source_doc_type,
      source_doc_id: doc.source_doc_id,
      idempotency_key: idem,
      state: "transmitting",
      request_payload: payload,
    });

    const { status, body } = await postToProvider(provider, creds, "/saveTrnsSalesOsdc", payload);
    const success = status < 400 && body?.resultCd === "000";
    const cuNumber = body?.data?.rcptSign ?? null;
    const qrData = body?.data?.qrCodeUrl
      ?? (provider.qr_url_template && cuNumber ? provider.qr_url_template.replace("{signature}", cuNumber) : null);

    await upsertTransmission(supabase, {
      organization_id: organizationId,
      branch_id: doc.branch_id,
      provider_key: provider.provider_key,
      document_kind: doc.document_kind,
      source_doc_type: doc.source_doc_type,
      source_doc_id: doc.source_doc_id,
      idempotency_key: idem,
      state: success ? "succeeded" : "rejected",
      response_payload: body,
      fiscal_number: cuNumber,
      signature: body?.data?.rcptSign ?? null,
      qr_data: qrData,
      control_unit_id: body?.data?.sdcId ?? creds.device_serial,
      transmitted_at: success ? new Date().toISOString() : null,
      last_error: success ? null : (body?.resultMsg ?? `HTTP ${status}`),
    });

    if (success) {
      await supabase.from("invoices").update({
        etims_cu_number: cuNumber,
        etims_qr_code_url: qrData,
        etims_receipt_signature: body?.data?.rcptSign,
        etims_sdc_id: body?.data?.sdcId ?? creds.device_serial,
        etims_receipt_number: body?.data?.rcptNo,
        etims_mrc_number: body?.data?.mrcNo,
        etims_transmitted_at: new Date().toISOString(),
        etims_transmission_status: "success",
        etims_error_message: null,
      }).eq("id", invoice.id);
    } else {
      await supabase.from("invoices").update({
        etims_transmission_status: "failed",
        etims_error_message: body?.resultMsg ?? `HTTP ${status}`,
      }).eq("id", invoice.id);
    }

    return new Response(JSON.stringify({
      success,
      cuNumber,
      qrCodeUrl: qrData,
      response: body,
    }), { status: success ? 200 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("etims/invoice error:", message);
    return new Response(JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}
