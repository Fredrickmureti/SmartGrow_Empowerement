import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  fetchCustomFields,
  fetchTemplate,
  type DocumentData,
  type DocumentType,
  type DocumentItem,
  type PaymentMethodData,
  type StatementTransaction,
  type StatementAgingBucket,
} from "../_shared/templateRenderer.ts";
import { generateDocumentPdf, generateStatementPdf } from "../_shared/pdfGenerator.ts";
import {
  buildStatementDataset,
  type CustomerLedgerRow,
} from "../_shared/reports/customerStatementDataset.ts";
import {
  buildVendorStatementDataset,
  type VendorLedgerRow,
} from "../_shared/reports/vendorStatementDataset.ts";

import { generateHrLetterPdf } from "../_shared/hrLetterGenerator.ts";
import { fetchHrLetter, getHrLetterTenancy, isHrLetterType } from "./hrLetterFetchers.ts";
import { mapEtimsToFiscalBlock } from "../_shared/pos/fiscalBlock.ts";
import { mergeReceiptSettings } from "../_shared/pos/mergeReceiptSettings.ts";
import { resolveReceiptTitle } from "../_shared/pos/resolveReceiptTitle.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Build an RFC 5987-safe Content-Disposition header. HTTP header values must
// be ByteStrings (latin-1); document numbers can contain unicode (e.g. "—",
// non-Latin scripts) or be null, which throws "Value is not a valid ByteString".
function buildContentDisposition(documentType: string, documentNumber: unknown, ext: string): string {
  const raw = `${documentType}-${documentNumber ?? "document"}.${ext}`;
  // ASCII fallback: replace any non-ASCII / quote / control char with "_"
  const ascii = raw.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(raw);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ── Branding column lists ────────────────────────────────────────────────
//
// Per the multi-entity ERP architecture (Odoo / Xero / QuickBooks):
// document branding (name, logo, address, tax id, currency) MUST come from
// the legal entity (`businesses`), NEVER from the workspace (`organizations`).
// Every fetcher therefore joins both:
//   - `organization` only for `id` + a tiny fallback (`base_currency`)
//   - `business` for the full identity stamp.
// `mapBusinessToOrg()` collapses the joined business row into the legacy
// `Organization` shape `DocumentData.organization` already expects, so the
// downstream renderer keeps working unchanged.
// `organizations` only has `id`, `name`, `logo_url` in this schema. We
// deliberately do NOT pull `name`/`logo_url` here because we never want to
// leak the workspace identity onto a customer document — the businesses
// row is the authoritative legal-entity stamp, mirroring Odoo's
// `res.company` model. The org join is kept solely so that, in the
// degraded case where a record has no `business_id`, we still have an id
// to reference for logging.
const ORG_FALLBACK_COLS = "id";
const BUSINESS_BRANDING_COLS =
  "id, name, legal_name, logo_url, email, phone, address, city, state, postal_code, country, tax_id, registration_number, base_currency, timezone";

/**
 * Map a joined `businesses` row into the `Organization` shape that
 * `DocumentData.organization` already exposes. Falls back to the joined
 * `organizations` row only if the business row is missing (which would
 * indicate a data integrity bug — no document should exist without a
 * `business_id`, but we degrade gracefully rather than rendering nothing).
 */
async function mapBusinessToOrg(supabase: any, business: any, orgFallback?: any, branchId?: string | null) {
  if (!business) {
    if (!orgFallback) return null;
    // Last-resort: workspace fallback. We deliberately do NOT show the
    // workspace name here — leave it blank so the renderer prints "—" or
    // an empty header rather than leaking tenant identity onto a customer
    // document.
    return {
      id: orgFallback.id,
      name: "",
      logo_url: null,
      base_currency: null,
    };
  }
  const mapped = {
    id: business.id,
    name: business.legal_name || business.name || "",
    logo_url: business.logo_url ?? null,
    email: business.email ?? null,
    phone: business.phone ?? null,
    address: business.address ?? null,
    city: business.city ?? null,
    state: business.state ?? null,
    postal_code: business.postal_code ?? null,
    country: business.country ?? null,
    tax_id: business.tax_id ?? null,
    base_currency: business.base_currency ?? null,
    registration_number: business.registration_number ?? null,
    timezone: business.timezone ?? null,
  };

  if (!branchId) return mapped;
  const { data, error } = await supabase.rpc("get_effective_company_config", {
    p_business_id: business.id,
    p_branch_id: branchId,
  });
  if (error || !data) {
    if (error) console.warn("[generate-document] effective company config failed", error.message);
    return mapped;
  }
  return {
    ...mapped,
    logo_url: data.logo_url?.value ?? mapped.logo_url,
    base_currency: data.base_currency?.value ?? mapped.base_currency,
    tax_id: data.tax_id?.value ?? mapped.tax_id,
  };
}

// ── Multi-unit pack provenance ─────────────────────────────────────────────
//
// Every transaction-line table that carries packaging columns (POS, invoice,
// estimate, proforma, credit note, PO, GRN, SO, DN, bill, sales return,
// purchase return) is joined with `packaging:product_packaging(name,
// qty_in_base_uom)` and `product:products(base_uom:units_of_measure(code,
// name))`. The helper below pulls the four presentation fields the renderers
// need so every document type ends up with the same shape — the receipt
// renderer (`_shared/receipt/items.ts`) and the PDF table
// (`_shared/pdf/components/LineItemsTable.ts`) both branch on them.
type PackJoin = { name?: string | null; qty_in_base_uom?: number | null } | null | undefined;
type UomJoin = { code?: string | null; name?: string | null } | null | undefined;
function packFields(it: any): {
  display_quantity: number | null;
  packaging_label: string | null;
  base_uom_label: string | null;
  uom_snapshot: string | null;
} {
  const pack: PackJoin = it?.packaging;
  const uom: UomJoin = it?.product?.base_uom;
  const base = (uom?.code || uom?.name || "ea") as string;
  const packName = (pack?.name ?? "") as string;
  const factor = Number(pack?.qty_in_base_uom);
  const dq = it?.display_quantity == null ? null : Number(it.display_quantity);
  const snap = it?.uom_snapshot
    || (packName
      ? (Number.isFinite(factor) && factor > 1
        ? `${packName} × ${factor} ${base}`
        : packName)
      : null);
  return {
    display_quantity: Number.isFinite(dq as number) ? (dq as number) : null,
    packaging_label: packName || null,
    base_uom_label: base,
    uom_snapshot: snap,
  };
}

// ── Data fetchers per document type ────────────────────────────────────────


/**
 * Snapshot first, live party second — mirrors
 * src/services/documents/snapshots/partyAddress.ts.
 */
function resolveSnapshotAddress(
  stored: string | null | undefined,
  party: any,
): string | null {
  const text = (stored ?? "").trim();
  if (text) return text;
  if (!party) return null;
  const cityLine = [party.city, party.state, party.postal_code]
    .map((part: any) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
  return (
    [party.address_line1, party.address_line2, cityLine, party.country]
      .map((part: any) => (part ?? "").trim())
      .filter(Boolean)
      .join("\n") || null
  );
}

async function fetchInvoice(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select(`
      *,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      invoice_items(*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name)))
    `)
    .eq("id", documentId)
    .single();

  if (error || !invoice) throw new Error(`Invoice not found: ${error?.message}`);

  const customFields = await fetchCustomFields(supabase, invoice.organization_id, "invoice", documentId);

  return {
    document_number: invoice.invoice_number,
    document_type: "invoice",
    status: invoice.status,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    subtotal: invoice.subtotal,
    tax_amount: invoice.tax_amount,
    discount_amount: invoice.discount_amount || 0,
    total: invoice.total,
    amount_paid: invoice.amount_paid || 0,
    currency: invoice.currency || "USD",
    notes: invoice.notes,
    terms: invoice.terms,
    contact: invoice.contact,
    billing_address: resolveSnapshotAddress(invoice.billing_address, invoice.contact),
    organization: await mapBusinessToOrg(supabase, invoice.business, invoice.organization, invoice.branch_id),
    business_id: invoice.business_id,
    organization_id: invoice.organization_id,
    items: (invoice.invoice_items || []).map((item: any) => ({
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      discount_percent: item.discount_percent,
      line_total: item.line_total,
      sku: item.sku,
      ...packFields(item),
    })),
    custom_fields: customFields,
  };
}

async function fetchEstimate(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(`
      *,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, country),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      estimate_items(*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name)))
    `)
    .eq("id", documentId)
    .single();

  if (error || !estimate) throw new Error(`Estimate not found: ${error?.message}`);

  const customFields = await fetchCustomFields(supabase, estimate.organization_id, "estimate", documentId);

  return {
    document_number: estimate.estimate_number,
    document_type: "estimate",
    status: estimate.status,
    issue_date: estimate.issue_date,
    expiry_date: estimate.expiry_date,
    subtotal: estimate.subtotal,
    tax_amount: estimate.tax_amount,
    discount_amount: estimate.discount_amount || 0,
    total: estimate.total,
    currency: estimate.currency || "USD",
    notes: estimate.notes,
    terms: estimate.terms,
    contact: estimate.contact,
    billing_address: resolveSnapshotAddress(estimate.billing_address, estimate.contact),
    organization: await mapBusinessToOrg(supabase, estimate.business, estimate.organization, estimate.branch_id),
    business_id: estimate.business_id,
    organization_id: estimate.organization_id,
    items: (estimate.estimate_items || []).map((item: any) => ({
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      discount_percent: item.discount_percent,
      line_total: item.line_total,
      ...packFields(item),
    })),
    custom_fields: customFields,
    customer_signature_url: estimate.customer_signature_url,
    signed_at: estimate.signed_at,
    signed_by_name: estimate.signed_by_name,
  };
}

async function fetchProforma(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: proforma, error } = await supabase
    .from("proforma_invoices")
    .select(`
      *,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      proforma_invoice_items(*, product:products(base_uom:units_of_measure!base_uom_id(code, name)))
    `)
    .eq("id", documentId)
    .single();

  if (error || !proforma) throw new Error(`Proforma not found: ${error?.message}`);

  const customFields = await fetchCustomFields(supabase, proforma.organization_id, "proforma", documentId);

  return {
    document_number: proforma.proforma_number,
    document_type: "proforma",
    status: proforma.status,
    issue_date: proforma.issue_date,
    expiry_date: proforma.expiry_date,
    subtotal: proforma.subtotal,
    tax_amount: proforma.tax_amount,
    discount_amount: proforma.discount_amount || 0,
    total: proforma.total,
    currency: proforma.currency || "USD",
    notes: proforma.notes,
    terms: proforma.terms,
    contact: proforma.contact,
    billing_address: resolveSnapshotAddress(proforma.billing_address, proforma.contact),
    organization: await mapBusinessToOrg(supabase, proforma.business, proforma.organization, proforma.branch_id),
    business_id: proforma.business_id,
    organization_id: proforma.organization_id,
    items: (proforma.proforma_invoice_items || []).map((item: any) => ({
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      discount_percent: item.discount_percent,
      line_total: item.line_total,
      ...packFields(item),
    })),
    custom_fields: customFields,
  };
}

async function fetchCreditNote(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: cn, error } = await supabase
    .from("credit_notes")
    .select(`
      *,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      credit_note_items(*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name)))
    `)
    .eq("id", documentId)
    .single();

  if (error || !cn) throw new Error(`Credit note not found: ${error?.message}`);

  const customFields = await fetchCustomFields(supabase, cn.organization_id, "credit_note", documentId);

  return {
    document_number: cn.credit_note_number,
    document_type: "credit_note",
    status: cn.status,
    issue_date: cn.issue_date,
    subtotal: cn.subtotal,
    tax_amount: cn.tax_amount,
    discount_amount: 0,
    total: cn.total,
    currency: cn.currency || "USD",
    notes: cn.notes,
    terms: null,
    contact: cn.contact,
    billing_address: resolveSnapshotAddress(cn.billing_address, cn.contact),
    organization: await mapBusinessToOrg(supabase, cn.business, cn.organization, cn.branch_id),
    business_id: cn.business_id,
    organization_id: cn.organization_id,
    items: (cn.credit_note_items || []).map((item: any) => ({
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      line_total: item.line_total,
      ...packFields(item),
    })),
    custom_fields: customFields,
  };
}

async function fetchPurchaseOrder(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: po, error } = await supabase
    .from("purchase_orders")
    .select(`
      *,
      vendor:contacts(name, email, phone, address_line1, city, state, postal_code),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      items:purchase_order_items(*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name)))
    `)
    .eq("id", documentId)
    .single();

  if (error || !po) throw new Error(`Purchase order not found: ${error?.message}`);

  return {
    document_number: po.po_number,
    document_type: "purchase_order",
    status: po.status,
    issue_date: po.order_date,
    due_date: po.expected_date,
    subtotal: po.subtotal,
    tax_amount: po.tax_amount,
    discount_amount: po.discount_amount || 0,
    total: po.total,
    currency: po.currency || "USD",
    notes: po.notes,
    terms: null,
    contact: po.vendor,
    organization: await mapBusinessToOrg(supabase, po.business, po.organization, po.branch_id),
    business_id: po.business_id,
    organization_id: po.organization_id,
    items: (po.items || []).map((item: any) => ({
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      line_total: item.line_total,
      ...packFields(item),
    })),
    shipping_address: po.shipping_address,
  };
}

// Wave 12 C2 — Goods Received Note fetcher. Backed by the `goods_receipts`
// table (the GRN is the receiving document against a purchase_order). The
// renderer reuses the purchase_order PDF template — totals/pricing columns
// are hidden because GRNs are quantity-only documents.
async function fetchGoodsReceivedNote(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: grn, error } = await supabase
    .from("goods_receipts")
    .select(`
      *,
      purchase_order:purchase_orders(po_number, vendor:contacts(name, email, phone, address_line1, city, state, postal_code), currency, shipping_address, deliver_to_warehouse:warehouses!purchase_orders_deliver_to_warehouse_id_fkey(name), deliver_to_branch:branches!purchase_orders_deliver_to_branch_id_fkey(name)),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      items:goods_receipt_items(*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name)))
    `)
    .eq("id", documentId)
    .single();

  if (error || !grn) throw new Error(`Goods received note not found: ${error?.message}`);

  return {
    document_number: grn.receipt_number,
    document_type: "goods_received_note",
    status: grn.status,
    issue_date: grn.receipt_date,
    due_date: null,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency: grn.purchase_order?.currency || "USD",
    notes: grn.notes,
    terms: null,
    contact: grn.purchase_order?.vendor ?? null,
    organization: await mapBusinessToOrg(supabase, grn.business, grn.organization, grn.branch_id),
    business_id: grn.business_id,
    organization_id: grn.organization_id,
    items: (grn.items || []).map((item: any) => ({
      description: item.description,
      quantity: item.quantity_received,
      unit_price: 0,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 0,
      ...packFields(item),
    })),
    // Receiving destination inherited from the PO — mirrors
    // src/services/documents/snapshots/purchasesGrn.ts.
    shipping_address:
      [
        grn.purchase_order?.deliver_to_warehouse?.name ??
          grn.purchase_order?.deliver_to_branch?.name ??
          null,
        grn.purchase_order?.shipping_address ?? null,
      ]
        .filter(Boolean)
        .join("\n") || null,
  };
}

// Phase B1 — Cash-drawer audit-slip fetcher. Returns the raw payload;
// the short-circuit renderer (see `drawer_slip` block in the main
// handler) formats it via `_shared/escpos/drawer.ts`. Joined shift +
// register + cashier are best-effort; the slip must still render if
// (for example) the cashier profile was deleted after the fact.
async function fetchDrawerSlip(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: mv, error } = await supabase
    .from("pos_cash_movements")
    .select(`
      id, organization_id, business_id, branch_id, shift_id, register_id,
      movement_type, amount, reason, reason_code, notes, performed_by,
      performed_at, manager_override_id,
      shift:pos_shifts(shift_number),
      register:pos_registers(name),
      cashier:profiles!performed_by(full_name, first_name, last_name),
      business:businesses(name, base_currency)
    `)
    .eq("id", documentId)
    .single();
  if (error || !mv) throw new Error(`Cash movement not found: ${error?.message}`);
  return {
    document_number: mv.id,
    document_type: "drawer_slip",
    status: "issued",
    issue_date: mv.performed_at,
    due_date: null,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: Number(mv.amount ?? 0),
    currency: mv.business?.base_currency ?? "USD",
    items: [],
    // Passthrough — the short-circuit reads these directly.
    drawer_slip: {
      movement_id: mv.id,
      movement_type: mv.movement_type,
      amount: Number(mv.amount ?? 0),
      reason: mv.reason,
      reason_code: mv.reason_code,
      notes: mv.notes,
      performed_at: mv.performed_at,
      manager_override_id: mv.manager_override_id,
      register_name: mv.register?.name ?? null,
      shift_number: mv.shift?.shift_number ?? null,
      cashier_name: mv.cashier?.full_name
        ?? [mv.cashier?.first_name, mv.cashier?.last_name].filter(Boolean).join(" ")
        ?? null,
      business_name: mv.business?.name ?? null,
      currency: mv.business?.base_currency ?? null,
    },
  } as unknown as DocumentData;
}

// ── Template type mapping ──────────────────────────────────────────────────



async function fetchReceipt(supabase: any, documentId: string): Promise<DocumentData> {
  // documentId can be the payment UUID, an invoice UUID, or a receipt_number string.
  let payment: any;
  // When the receipt is rendered against a SPECIFIC invoice (the
  // "View receipt" action on an invoice row), restrict the allocation
  // breakdown to that single invoice slice. Null = render every
  // allocation row attached to the payment.
  let restrictToInvoiceId: string | null = null;

  // NOTE: `payments.invoice_id` was DROPPED in ADR 0027. The single-invoice
  // FK no longer exists; all payment→invoice links live in
  // `payment_allocations`. We must NOT embed `invoice:invoices(...)` here
  // (the FK is gone, PostgREST 400s) and must NOT filter payments by
  // `invoice_id` (column does not exist).
  const PAYMENT_SELECT = `
    *,
    contact:contacts(name, email, phone, address_line1, city, state, postal_code),
    organization:organizations(${ORG_FALLBACK_COLS}),
    business:businesses(${BUSINESS_BRANDING_COLS})
  `;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId);
  const tried: string[] = [];

  if (isUuid) {
    tried.push("id");
    const uuidResult = await supabase
      .from("payments")
      .select(PAYMENT_SELECT)
      .eq("id", documentId)
      .maybeSingle();
    if (uuidResult.data) payment = uuidResult.data;

    // Legacy discriminator label kept for parity with the architecture
    // guard (`receipt-fetch-discriminators.test.ts`). The actual lookup
    // now goes through `payment_allocations` since `payments.invoice_id`
    // was dropped in ADR 0027.
    if (!payment) {
      tried.push("invoice_id");
    }

    // Bulk / multi-invoice payment looked up via the invoice id: scope the
    // allocation rendering to that one invoice so the printed receipt
    // matches the invoice the user clicked from.
    if (!payment) {
      tried.push("invoice_allocation");
      const allocResult = await supabase
        .from("payment_allocations")
        .select("payment_id")
        .eq("invoice_id", documentId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (allocResult.data?.payment_id) {
        const paymentResult = await supabase
          .from("payments")
          .select(PAYMENT_SELECT)
          .eq("id", allocResult.data.payment_id)
          .maybeSingle();
        if (paymentResult.data) {
          payment = paymentResult.data;
          restrictToInvoiceId = documentId;
        }
      }
    }
  }

  if (!payment) {
    tried.push("receipt_number");
    const receiptResult = await supabase
      .from("payments")
      .select(PAYMENT_SELECT)
      .eq("receipt_number", documentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (receiptResult.data) payment = receiptResult.data;
  }

  if (!payment) {
    throw new Error(
      `Receipt not found by [${tried.join(", ")}]: "${documentId}"`,
    );
  }

  const paymentMethodLabels: Record<string, string> = {
    bank_transfer: "Bank Transfer",
    cash: "Cash",
    credit_card: "Credit Card",
    check: "Check",
    mobile_money: "Mobile Money",
    other: "Other",
  };

  // ── Allocation-aware load ────────────────────────────────────────────
  // ALWAYS try `payment_allocations` for this payment id. This is the fix
  // for the long-standing "Payment for Invoice N/A" bug on bulk customer
  // payments rendered from Sales → Payments.
  let allocRows: Array<{
    invoice_id: string;
    amount: number;
    invoices: any;
  }> = [];
  {
    let q = supabase
      .from("payment_allocations")
      .select("invoice_id, amount, invoices(id, invoice_number, issue_date, total, amount_paid, currency)")
      .eq("payment_id", payment.id);
    if (restrictToInvoiceId) q = q.eq("invoice_id", restrictToInvoiceId);
    const { data } = await q;
    allocRows = (data ?? []) as any[];
  }

  // Sort by issue_date then invoice_number for stable, accountant-friendly order.
  allocRows.sort((a, b) => {
    const da = a.invoices?.issue_date ?? "";
    const db = b.invoices?.issue_date ?? "";
    if (da !== db) return da < db ? -1 : 1;
    const na = a.invoices?.invoice_number ?? "";
    const nb = b.invoices?.invoice_number ?? "";
    return na < nb ? -1 : na > nb ? 1 : 0;
  });

  const allocations = allocRows
    .filter((r) => r.invoices)
    .map((r) => {
      const inv = r.invoices;
      const applied = Number(r.amount) || 0;
      const total = Number(inv.total) || 0;
      const paid = Number(inv.amount_paid) || 0;
      // `amount_paid` on the invoice is post-application, so balance is
      // simply total - amount_paid. Clamp to zero for display.
      const balance = Math.max(0, total - paid);
      return {
        invoice_id: inv.id,
        invoice_number: inv.invoice_number || "",
        invoice_date: inv.issue_date ?? null,
        invoice_total: total,
        amount_applied: applied,
        balance_after: balance,
        currency: inv.currency || payment.currency || "USD",
      };
    });

  // Resolve currency: prefer uniform allocation currency; fall back through the chain.
  const allocCurrencies = new Set(allocations.map((a) => a.currency).filter(Boolean));
  const displayCurrency =
    (allocCurrencies.size === 1 ? [...allocCurrencies][0] : null)
    ?? payment.invoice?.currency
    ?? payment.business?.base_currency
    ?? payment.organization?.base_currency
    ?? "USD";

  // Totals derivation (items-as-truth contract):
  //   subtotal/total are ALWAYS Σ(items.line_total) — never derived from
  //   `payments.amount` independently. This prevents the historical
  //   "subtotal 300k + unapplied 300k = 600k" bug where a legacy payment
  //   missing an allocation row caused the renderer to add a phantom
  //   "unapplied" amount to the total without emitting a matching line.
  const totalApplied = allocations.reduce((s, a) => s + a.amount_applied, 0);
  const paymentAmount = Number(payment.amount) || 0;
  const hasLegacyInvoiceLink = allocations.length === 0 && !!payment.invoice?.invoice_number;
  const displayAmount = allocations.length > 0 ? totalApplied : paymentAmount;
  // Unapplied = cash received that did NOT settle any invoice line.
  // Only meaningful when rendering the entire payment AND we have real
  // allocations to compare against. In the legacy single-invoice link
  // case, the payment is fully applied by definition (the invoice_id FK
  // IS the allocation), so unapplied is 0.
  const unapplied = (restrictToInvoiceId || hasLegacyInvoiceLink || allocations.length === 0)
    ? 0
    : Math.max(0, paymentAmount - totalApplied);

  // Items: one line per allocation. When no allocations exist we keep a
  // single sane fallback line — but never the literal "N/A" placeholder.
  let items: any[];
  if (allocations.length > 0) {
    items = allocations.map((a) => ({
      description: a.invoice_date
        ? `Invoice ${a.invoice_number}  (${a.invoice_date})`
        : `Invoice ${a.invoice_number}`,
      quantity: 1,
      unit_price: a.amount_applied,
      tax_rate: 0,
      tax_amount: 0,
      line_total: a.amount_applied,
    }));
    if (unapplied > 0) {
      items.push({
        description: "Unapplied advance (on account)",
        quantity: 1,
        unit_price: unapplied,
        tax_rate: 0,
        tax_amount: 0,
        line_total: unapplied,
      });
    }
  } else if (payment.invoice?.invoice_number) {
    // Legacy single-invoice payment (`payments.invoice_id` set, no allocation row).
    items = [{
      description: `Invoice ${payment.invoice.invoice_number}`,
      quantity: 1,
      unit_price: displayAmount,
      tax_rate: 0,
      tax_amount: 0,
      line_total: displayAmount,
    }];
  } else {
    // True on-account advance (no allocations, no invoice link).
    items = [{
      description: "On-account payment",
      quantity: 1,
      unit_price: displayAmount,
      tax_rate: 0,
      tax_amount: 0,
      line_total: displayAmount,
    }];
  }

  // Items-as-truth: derive monetary totals from the items array ONLY.
  // Never add `payments.amount` (or any other independent figure) on top
  // — if the items sum disagrees with the cash on the payment, that is a
  // data-integrity issue to surface, not silently inflate.
  const itemsSubtotal = items.reduce((s, it) => s + (Number(it.line_total) || 0), 0);
  const itemsTax = items.reduce((s, it) => s + (Number(it.tax_amount) || 0), 0);
  const itemsTotal = itemsSubtotal + itemsTax;

  if (!restrictToInvoiceId && Math.abs(itemsTotal - paymentAmount) > 0.01) {
    console.warn(
      `[generate-document] receipt totals drift on payment ${payment.id}: ` +
      `items=${itemsTotal} payment.amount=${paymentAmount} ` +
      `allocations=${totalApplied} unapplied=${unapplied} — rendering items-as-truth.`,
    );
  }

  return {
    document_number: payment.receipt_number || `RCP-${payment.id.slice(0, 8)}`,
    document_type: "receipt",
    status: payment.status || "completed",
    issue_date: payment.payment_date,
    subtotal: itemsSubtotal,
    tax_amount: itemsTax,
    discount_amount: 0,
    total: itemsTotal,
    amount_paid: itemsTotal,
    currency: displayCurrency,
    notes: payment.notes,
    terms: null,
    contact: payment.contact,
    organization: await mapBusinessToOrg(supabase, payment.business, payment.organization, payment.branch_id),
    business_id: payment.business_id,
    organization_id: payment.organization_id,
    items,
    payment_method: paymentMethodLabels[payment.payment_method] || payment.payment_method,
    payment_reference: payment.reference ?? null,
    payment_allocations: allocations,
    unapplied_amount: unapplied,
  };
}

// ── POS Receipt fetcher (A4 document from pos_transactions) ────────────────

async function fetchPOSReceipt(
  supabase: any,
  documentId: string,
  opts?: { forceRefreshSettings?: boolean },
): Promise<DocumentData> {
  // Phase 3 — opt-in: when an operator selects "Use current receipt
  // settings" on the Reprint dialog, rebuild the merged receipt-settings
  // pair from live `businesses.receipt_settings` + `pos_settings` instead
  // of the frozen snapshot copy. All other snapshot fields (line items,
  // totals, branding, eTIMS) stay frozen so the receipt's audit identity
  // is preserved — only the rendering layer (paper width, columns, etc.)
  // refreshes.
  const forceRefreshSettings = opts?.forceRefreshSettings === true;
  // Stage B: prefer the frozen snapshot so reprints are byte-stable even if
  // products / branding / receipt settings have changed since the sale.
  const { data: snap } = await supabase
    .from("pos_receipt_snapshots")
    .select("payload")
    .eq("transaction_id", documentId)
    .maybeSingle();

  if (snap?.payload) {
    const p: any = snap.payload;
    const txn = p.transaction || {};
    const items = (p.items || []).map((it: any) => ({
      description: it.description ?? it.product_name ?? "Item",
      quantity: it.quantity,
      unit_price: it.unit_price,
      tax_rate: it.tax_rate || 0,
      tax_amount: it.tax_amount || 0,
      tax_rate_name: it.tax_rate_name ?? null,
      discount_percent: 0,
      discount_amount: it.discount_amount ?? 0,
      line_total: it.line_total,
      sku: it.sku ?? it.product_sku ?? null,
      // Multi-unit pack provenance — already frozen into the snapshot by
      // `_pos_build_receipt_snapshot`; forward so receipt renders the
      // transaction unit ("2 Strip") instead of base ("20").
      display_quantity: it.display_quantity ?? null,
      packaging_label: it.packaging_label ?? null,
      base_uom_label: it.base_uom_label ?? null,
      uom_snapshot: it.uom_snapshot ?? null,
    }));
    const payments = p.payments || [];
    // Defensive: snapshot payloads from different writers may use either
    // `payment_method` or `method` for the tender type. Treat both as the
    // same field so `actualPaid` and on-account detection cannot silently
    // mis-classify a fully-paid sale as INVOICE.
    const tenderOf = (pay: any) => pay?.payment_method ?? pay?.method ?? null;
    const actualPaid = payments
      .filter((pay: any) => tenderOf(pay) !== 'credit')
      .reduce((s: number, pay: any) => s + Number(pay.amount || 0), 0);
    const paymentSummary = payments.map((pay: any) => tenderOf(pay)).filter(Boolean).join(', ');
    // Phase 3 — opt-in refresh: re-resolve receipt settings from live DB
    // using the same hierarchy as the live-fallback path. Fall back to the
    // frozen snapshot copy on any failure so the reprint never breaks.
    let liveBusinessRs: Record<string, unknown> | null = null;
    let liveRegisterRs: Record<string, unknown> | null = null;
    if (forceRefreshSettings) {
      try {
        if (txn.business_id) {
          const { data: biz } = await supabase
            .from("businesses")
            .select("receipt_settings")
            .eq("id", txn.business_id)
            .maybeSingle();
          liveBusinessRs = (biz as any)?.receipt_settings ?? null;

          const { data: posRows } = await supabase
            .from("pos_settings")
            .select("register_id, branch_id, setting_value")
            .eq("business_id", txn.business_id)
            .eq("setting_key", "receipt_settings");
          const rows = (posRows ?? []) as Array<{
            register_id: string | null;
            branch_id: string | null;
            setting_value: Record<string, unknown> | null;
          }>;
          const byRegister = txn.register_id
            ? rows.find((r) => r.register_id === txn.register_id)
            : null;
          const byBranch = txn.branch_id
            ? rows.find((r) => r.register_id == null && r.branch_id === txn.branch_id)
            : null;
          const byBusiness = rows.find((r) => r.register_id == null && r.branch_id == null);
          liveRegisterRs = (byRegister?.setting_value
            ?? byBranch?.setting_value
            ?? byBusiness?.setting_value
            ?? null) as Record<string, unknown> | null;
        }
      } catch (e) {
        console.warn("[generate-document] force_refresh_settings: live fetch failed, falling back to frozen snapshot pair", e);
        liveBusinessRs = null;
        liveRegisterRs = null;
      }
    }
    const settingsSource: "refreshed" | "frozen" =
      forceRefreshSettings && (liveBusinessRs || liveRegisterRs) ? "refreshed" : "frozen";
    const mergedSettings = mergeReceiptSettings(
      settingsSource === "refreshed" ? liveBusinessRs : (p.business_receipt_settings ?? null),
      settingsSource === "refreshed" ? liveRegisterRs : (p.register_receipt_settings ?? null),
    );
    // Always recompute the title via the centralized resolver — never trust
    // a stale `document_type_label` frozen into the snapshot before the
    // resolver shipped (legacy "INVOICE" labels for fully-paid cash sales).
    const resolvedTitle = resolveReceiptTitle({
      total: Number(txn.total ?? 0),
      amount_paid: actualPaid,
      payments: payments.map((pay: any) => ({ payment_method: tenderOf(pay), amount: pay.amount })),
      tax_amount: Number(txn.tax_amount ?? 0),
      etims_cu_number: txn.etims_cu_number,
      is_voided: !!txn.is_voided,
      is_refund: !!txn.is_refund,
      is_reprint: false,
      legacy_title_mode: !!(mergedSettings as any)?.legacy_title_mode,
    });
    const fiscalBlock = mapEtimsToFiscalBlock({
      cu_number: txn.etims_cu_number ?? null,
      qr_data: txn.etims_qr_data ?? null,
      signature: txn.etims_signature ?? null,
      invoice_number: txn.etims_invoice_number ?? null,
      control_unit_id: txn.etims_control_unit_id ?? null,
    });
    return {
      document_number: txn.transaction_number,
      document_type: "pos_receipt" as any,
      document_type_label: resolvedTitle.title,
      status: txn.status || 'completed',
      branch_id: txn.branch_id ?? null,
      issue_date: txn.created_at,
      subtotal: txn.subtotal || 0,
      tax_amount: txn.tax_amount || 0,
      discount_amount: txn.discount_amount || 0,
      total: txn.total || 0,
      amount_paid: actualPaid,
      currency: p.business?.base_currency || p.organization?.base_currency || 'USD',
      notes: null,
      terms: null,
      contact: p.customer,
      organization: await mapBusinessToOrg(supabase, p.business, p.organization, txn.branch_id),
      business_id: txn.business_id,
      organization_id: txn.organization_id,
      items,
      payment_method: paymentSummary,
      cashier_name: p.cashier?.name ?? p.cashier_name ?? null,
      register_id: txn.register_id ?? null,
      register_name: p.register?.name ?? null,
      pos_payments: payments.map((pay: any) => ({
        payment_method: tenderOf(pay),
        amount: pay.amount,
        reference: pay.reference ?? null,
      })),
      etims_cu_number: txn.etims_cu_number ?? null,
      etims_qr_data: txn.etims_qr_data ?? null,
      fiscal_block: fiscalBlock,
      is_voided: !!txn.is_voided,
      is_refund: !!txn.is_refund,
      original_transaction_number: txn.original_transaction_number ?? null,
      pos_receipt_settings: mergedSettings,
      pos_receipt_settings_source: settingsSource,
      pos_printer_capabilities: (p.register as any)?.printer_capabilities ?? null,
      pos_register_printer_profile: (p.register as any)?.printer_profile ?? null,
    } as any;
  }

  const { data: txn, error } = await supabase
    .from("pos_transactions")
    .select(`
      *,
      customer:contacts(name, email, phone, address_line1, city, state, postal_code),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS})
    `)
    .eq("id", documentId)
    .single();

  if (error || !txn) throw new Error(`POS transaction not found: ${error?.message || documentId}`);

  // Side joins (separate queries — avoids depending on Postgres FK names
  // when calling through PostgREST embedded selects).
  let cashierName: string | null = null;
  if (txn.cashier_id) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("full_name")
      .or(`user_id.eq.${txn.cashier_id},id.eq.${txn.cashier_id}`)
      .maybeSingle();
    cashierName = prof?.full_name ?? null;
  }
  let registerName: string | null = null;
  if (txn.register_id) {
    const { data: reg } = await supabase
      .from("pos_registers")
      .select("register_name")
      .eq("id", txn.register_id)
      .maybeSingle();
    registerName = reg?.register_name ?? null;
  }
  let originalTxnNumber: string | null = null;
  if (txn.original_transaction_id) {
    const { data: orig } = await supabase
      .from("pos_transactions")
      .select("transaction_number")
      .eq("id", txn.original_transaction_id)
      .maybeSingle();
    originalTxnNumber = orig?.transaction_number ?? null;
  }

  // Fetch items — join packaging + base UoM so the receipt can render the
  // transaction unit ("2 Strip") instead of base ("20"). Same join shape as
  // the invoice/PO/SO fetchers (consumed by `packFields` below).
  const { data: items } = await supabase
    .from("pos_transaction_items")
    .select("*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name))")
    .eq("transaction_id", documentId)
    .order("sort_order", { ascending: true });

  // Fetch payments
  const { data: payments } = await supabase
    .from("pos_transaction_payments")
    .select("*")
    .eq("transaction_id", documentId);

  const paymentMethodLabels: Record<string, string> = {
    cash: "Cash", credit_card: "Credit Card", debit_card: "Debit Card",
    mobile_money: "Mobile Money", mpesa: "M-Pesa", credit: "Credit",
    bank_transfer: "Bank Transfer", gift_card: "Gift Card", other: "Other",
  };

  const paymentSummary = (payments || [])
    .map((p: any) => paymentMethodLabels[p.payment_method] || p.payment_method)
    .join(", ");

  // Calculate actual cash received (exclude credit — that's a receivable, not payment)
  const actualPaid = (payments || [])
    .filter((p: any) => p.payment_method !== 'credit')
    .reduce((sum: number, p: any) => sum + (p.amount || 0), 0);

  // Stage X7 — pull merged receipt settings (live fallback path).
  let businessReceiptSettings: Record<string, unknown> | null = null;
  let registerReceiptSettings: Record<string, unknown> | null = null;
  let printerCapabilities: Record<string, unknown> | null = null;
  // Company-level (canonical) receipt settings — branding, sections, content.
  if (txn.business_id) {
    const { data: biz } = await supabase
      .from("businesses")
      .select("receipt_settings")
      .eq("id", txn.business_id)
      .maybeSingle();
    businessReceiptSettings = (biz as any)?.receipt_settings ?? null;
  }
  // Resolve POS receipt-settings overrides with full precedence:
  //   register override → branch override → business/global POS override
  // (POSSettings UI saves overrides at register_id IS NULL / branch_id IS NULL
  //  so we MUST consult that level — without it, real receipts ignore the
  //  paper_size / item_display_format / etc. configured by the operator.)
  if (txn.business_id) {
    const { data: posRows } = await supabase
      .from("pos_settings")
      .select("register_id, branch_id, setting_value")
      .eq("business_id", txn.business_id)
      .eq("setting_key", "receipt_settings");
    const rows = (posRows ?? []) as Array<{ register_id: string | null; branch_id: string | null; setting_value: Record<string, unknown> | null }>;
    const byRegister = txn.register_id
      ? rows.find((r) => r.register_id === txn.register_id)
      : null;
    const byBranch = txn.branch_id
      ? rows.find((r) => r.register_id == null && r.branch_id === txn.branch_id)
      : null;
    const byBusiness = rows.find((r) => r.register_id == null && r.branch_id == null);
    registerReceiptSettings = (byRegister?.setting_value
      ?? byBranch?.setting_value
      ?? byBusiness?.setting_value
      ?? null) as Record<string, unknown> | null;
  }
  let registerPrinterProfile: Record<string, unknown> | null = null;
  if (txn.register_id) {
    const { data: regCaps } = await supabase
      .from("pos_registers")
      .select("printer_capabilities, printer_profile")
      .eq("id", txn.register_id)
      .maybeSingle();
    printerCapabilities = (regCaps as any)?.printer_capabilities ?? null;
    registerPrinterProfile = (regCaps as any)?.printer_profile ?? null;
  }
  const mergedReceiptSettings = mergeReceiptSettings(
    businessReceiptSettings,
    registerReceiptSettings,
  );

  // Stage A — centralized title resolver (shared with snapshot path).
  // Threads `legacy_title_mode` from merged settings (Phase F wiring).
  const etimsCu = (txn.snapshot as any)?.etims?.cu_number ?? null;
  const etimsQr = (txn.snapshot as any)?.etims?.qr_data ?? null;
  const resolvedTitle = resolveReceiptTitle({
    total: Number(txn.total ?? 0),
    amount_paid: actualPaid,
    payments: (payments || []) as any,
    tax_amount: Number(txn.tax_amount ?? 0),
    etims_cu_number: etimsCu,
    is_voided: !!txn.voided_at,
    is_refund: txn.transaction_type === "refund" || txn.transaction_type === "return",
    is_reprint: false,
    legacy_title_mode: !!(mergedReceiptSettings as any)?.legacy_title_mode,
  });
  const documentTypeLabel = resolvedTitle.title;
  const fiscalBlock = mapEtimsToFiscalBlock({
    cu_number: etimsCu,
    qr_data: etimsQr,
    signature: (txn.snapshot as any)?.etims?.signature ?? null,
    invoice_number: (txn.snapshot as any)?.etims?.invoice_number ?? null,
    control_unit_id: (txn.snapshot as any)?.etims?.control_unit_id ?? null,
  });

  return {
    document_number: txn.transaction_number,
    document_type: "pos_receipt" as any,
    document_type_label: documentTypeLabel,
    status: txn.status || "completed",
    branch_id: txn.branch_id ?? null,
    issue_date: txn.created_at,
    subtotal: txn.subtotal || 0,
    tax_amount: txn.tax_amount || 0,
    discount_amount: txn.discount_amount || 0,
    total: txn.total || 0,
    amount_paid: actualPaid,
    currency: txn.business?.base_currency || txn.organization?.base_currency || "USD",
    notes: null,
    terms: null,
    contact: txn.customer,
    organization: await mapBusinessToOrg(supabase, txn.business, txn.organization, txn.branch_id),
    business_id: txn.business_id,
    organization_id: txn.organization_id,
    items: (items || []).map((item: any) => ({
      description: item.product_name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate || 0,
      tax_amount: item.tax_amount || 0,
      tax_rate_name: item.tax_rate_name ?? null,
      discount_percent: item.discount_amount && item.unit_price > 0
        ? ((item.discount_amount / (item.quantity * item.unit_price)) * 100)
        : 0,
      discount_amount: item.discount_amount ?? 0,
      line_total: item.line_total,
      sku: item.sku ?? null,
      ...packFields(item),
    })),
    payment_method: paymentSummary,
    cashier_name: cashierName,
    register_id: txn.register_id ?? null,
    register_name: registerName,
    pos_payments: (payments || []).map((p: any) => ({
      payment_method: p.payment_method,
      amount: p.amount,
      reference: p.reference ?? null,
    })),
    etims_cu_number: etimsCu,
    etims_qr_data: etimsQr,
    fiscal_block: fiscalBlock,
    is_voided: !!txn.voided_at,
    is_refund: txn.transaction_type === "refund" || txn.transaction_type === "return",
    original_transaction_number: originalTxnNumber,
    pos_receipt_settings: mergedReceiptSettings,
    pos_receipt_settings_source: "live" as const,
    pos_printer_capabilities: printerCapabilities,
    pos_register_printer_profile: registerPrinterProfile,
  } as any;
}

// ── Sales Order fetcher ─────────────────────────────────────────────────────

async function fetchSalesOrder(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: so, error } = await supabase
    .from("sales_orders")
    .select(`
      *,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      items:sales_order_items(*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name)))
    `)
    .eq("id", documentId)
    .single();

  if (error || !so) throw new Error(`Sales order not found: ${error?.message}`);

  return {
    document_number: so.so_number,
    document_type: "sales_order",
    document_type_label: "SALES ORDER",
    status: so.status,
    issue_date: so.order_date,
    due_date: so.expected_date,
    subtotal: so.subtotal,
    tax_amount: so.tax_amount,
    discount_amount: so.discount_amount || 0,
    total: so.total,
    amount_paid: 0,
    currency: so.currency || "USD",
    notes: so.notes,
    terms: null,
    contact: so.contact,
    organization: await mapBusinessToOrg(supabase, so.business, so.organization, so.branch_id),
    business_id: so.business_id,
    organization_id: so.organization_id,
    shipping_address: so.shipping_address,
    items: (so.items || []).map((item: any) => ({
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate,
      tax_amount: item.tax_amount,
      discount_percent: item.discount_percent,
      line_total: item.line_total,
      ...packFields(item),
    })),
  };
}

// ── Delivery Note fetcher ──────────────────────────────────────────────────

async function fetchDeliveryNote(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: dn, error } = await supabase
    .from("delivery_notes")
    .select(`
      *,
      contact:contacts!delivery_notes_contact_id_fkey(name, email, phone, address_line1, city, state, postal_code),
      received_by_contact:contacts!received_by_contact_id(name),
      delivery_proofs(received_by_name, received_at),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      items:delivery_note_items(*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name))),
      carrier:carriers(name, tracking_url_template),
      backorder_of:delivery_notes!backorder_of_dn_id(delivery_number)
    `)
    .eq("id", documentId)
    .single();

  if (error || !dn) throw new Error(`Delivery note not found: ${error?.message}`);

  // Dispatch-officer name: no FK from delivery_notes.dispatch_officer_id to
  // profiles, so fetch separately when present (best-effort).
  let dispatchOfficerName: string | null = null;
  if (dn.dispatch_officer_id) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", dn.dispatch_officer_id)
      .maybeSingle();
    dispatchOfficerName = prof?.full_name ?? null;
  }

  // Best-effort tracking URL: substitute {tracking_number} into the carrier template.
  let trackingUrl: string | null = null;
  if (dn.carrier?.tracking_url_template && dn.tracking_number) {
    trackingUrl = String(dn.carrier.tracking_url_template).replace(
      "{tracking_number}", encodeURIComponent(dn.tracking_number),
    );
  }

  // Recipient priority chain with UUID guard (defense in depth):
  // contact → POD → staff user (profiles.full_name) → legacy free-text.
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const podName: string | null = Array.isArray(dn.delivery_proofs) && dn.delivery_proofs[0]?.received_by_name
    ? String(dn.delivery_proofs[0].received_by_name).trim()
    : null;
  const legacyName: string | null = typeof dn.received_by === "string" ? dn.received_by.trim() : null;
  let receivedByUserName: string | null = null;
  if (dn.received_by_user_id && !dn.received_by_contact?.name && !podName) {
    const { data: rprof } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", dn.received_by_user_id)
      .maybeSingle();
    receivedByUserName = rprof?.full_name?.trim?.() ?? null;
  }
  const resolvedReceivedBy =
    (dn.received_by_contact?.name?.trim?.() || null)
    || (podName && !UUID_RE.test(podName) ? podName : null)
    || (receivedByUserName && !UUID_RE.test(receivedByUserName) ? receivedByUserName : null)
    || (legacyName && !UUID_RE.test(legacyName) ? legacyName : null);

  // Strip legacy automation tokens from notes (defense in depth).
  const cleanNotes = typeof dn.notes === "string"
    ? dn.notes
        .replace(/\s*Auto-created from invoice [^\[\n]*\[auto-from-invoice:[0-9a-fA-F-]{36}\]\s*(\(backfill\))?\s*/g, "")
        .replace(/\s*\[auto-from-invoice:[0-9a-fA-F-]{36}\]\s*/g, "")
        .trim() || null
    : dn.notes;

  return {
    document_number: dn.delivery_number,
    document_type: "delivery_note",
    document_type_label: "DELIVERY NOTE",
    status: dn.status,
    issue_date: dn.delivery_date,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency: dn.business?.base_currency || dn.organization?.base_currency || "KES",
    notes: cleanNotes,
    terms: null,
    contact: dn.contact,
    organization: await mapBusinessToOrg(supabase, dn.business, dn.organization, dn.branch_id),
    business_id: dn.business_id,
    organization_id: dn.organization_id,
    shipping_address: dn.shipping_address,
    items: (dn.items || []).map((item: any) => ({
      description: item.description,
      quantity: item.quantity_ordered,
      unit_price: 0,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 0,
      quantity_delivered: item.quantity_delivered,
      ...packFields(item),
    })),
    hide_amounts: true,
    driver_name: dn.driver_name,
    vehicle_number: dn.vehicle_number,
    // Stage V2 logistics fields
    shipping_method: dn.shipping_method,
    carrier_name: dn.carrier?.name ?? null,
    carrier_tracking_url: trackingUrl,
    tracking_number: dn.tracking_number,
    dispatch_route: dn.dispatch_route,
    dispatch_officer_name: dispatchOfficerName,
    dispatched_at: dn.dispatched_at,
    delivered_at: dn.delivered_at,
    ready_at: dn.ready_at,
    freight_cost: dn.freight_cost,
    freight_currency: dn.freight_currency,
    received_by_name: resolvedReceivedBy,
    is_backorder: !!dn.is_backorder,
    backorder_of_number: dn.backorder_of?.delivery_number ?? null,
  };
}

// ── Customer Statement fetcher ─────────────────────────────────────────────

async function fetchCustomerStatement(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: stmt, error } = await supabase
    .from("customer_statements")
    .select(`
      *,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, country, tax_id),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS})
    `)
    .eq("id", documentId)
    .single();

  if (error || !stmt) throw new Error(`Customer statement not found: ${error?.message}`);

  const contactId = stmt.contact_id;
  const orgId = stmt.organization_id;
  const businessId = stmt.business_id;
  const branchId = stmt.branch_id ?? null;
  const periodStart = stmt.period_start;
  const periodEnd = stmt.period_end;
  const currency = stmt.business?.base_currency || stmt.organization?.base_currency || "USD";

  // SOURCE OF TRUTH: the posted AR subledger (`customer_ledger_entries`),
  // folded by the SAME builder the app uses (`customerStatementDataset.ts`,
  // mirrored into _shared). The emailed PDF, the downloaded PDF and the
  // on-screen statement therefore project one dataset and cannot diverge.
  // This fetcher previously re-derived the statement from `invoices` +
  // `payments` + `credit_notes`, which charged draft/void invoices, ignored
  // branch and currency, hid refunds/deposits/reversals, and filtered credit
  // notes on a `credit_note_status` value that does not exist.
  let ledgerQuery = supabase
    .from("customer_ledger_entries")
    .select("entry_date, doc_type, doc_id, doc_ref, debit, credit, currency, created_at")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .lte("entry_date", periodEnd)
    .order("entry_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (businessId) ledgerQuery = ledgerQuery.eq("business_id", businessId);
  if (branchId) ledgerQuery = ledgerQuery.eq("branch_id", branchId);
  const { data: ledgerRows, error: ledgerError } = await ledgerQuery;
  if (ledgerError) throw new Error(`Customer statement ledger: ${ledgerError.message}`);

  const dataset = buildStatementDataset({
    rows: (ledgerRows || []) as CustomerLedgerRow[],
    periodStart,
    periodEnd,
    currency,
  });

  const TYPE_LABEL: Record<string, string> = {
    invoice: "Invoice",
    payment: "Payment",
    credit_note: "Credit Note",
    deposit: "Deposit",
    refund: "Refund",
    payment_reversal: "Payment Reversal",
  };

  const statementTransactions: StatementTransaction[] = dataset.transactions.map((t) => ({
    date: t.date,
    type: TYPE_LABEL[t.docType] ?? t.docType.replace(/_/g, " "),
    reference: t.reference,
    description: t.description,
    charges: t.debit,
    credits: t.credit,
    balance: t.balance,
    source_id: t.sourceId,
    source_type: t.docType,
  }));

  // Aging: the GL-anchored open-items projection, aged as of the period end
  // (never the server clock), so a reprint of a closed period reproduces the
  // original buckets. Bucket boundaries mirror the SQL definition.
  let agingQuery = supabase
    .from("finance_ar_open_items")
    .select("document_date, due_date, residual_amount, base_residual_amount")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .lte("document_date", periodEnd)
    .gt("residual_amount", 0.01);
  if (businessId) agingQuery = agingQuery.eq("business_id", businessId);
  if (branchId) agingQuery = agingQuery.eq("branch_id", branchId);
  const { data: openItems, error: agingError } = await agingQuery;
  if (agingError) throw new Error(`Customer statement aging: ${agingError.message}`);

  const asOf = Date.UTC(
    Number(periodEnd.slice(0, 4)),
    Number(periodEnd.slice(5, 7)) - 1,
    Number(periodEnd.slice(8, 10)),
  );
  const buckets = { not_due: 0, current: 0, days30: 0, days60: 0, days90: 0 };
  for (const row of (openItems || []) as any[]) {
    const residual = Number(row.base_residual_amount ?? row.residual_amount) || 0;
    if (residual <= 0.01) continue;
    const ref = String(row.due_date || row.document_date || periodEnd);
    const due = Date.UTC(
      Number(ref.slice(0, 4)),
      Number(ref.slice(5, 7)) - 1,
      Number(ref.slice(8, 10)),
    );
    const daysOverdue = Math.floor((asOf - due) / 86_400_000);
    const key =
      daysOverdue < 0
        ? "not_due"
        : daysOverdue <= 30
          ? "current"
          : daysOverdue <= 60
            ? "days30"
            : daysOverdue <= 90
              ? "days60"
              : "days90";
    buckets[key] += residual;
  }

  const statementAging: StatementAgingBucket[] = [
    { label: "Not yet due", amount: buckets.not_due },
    { label: "0–30 days", amount: buckets.current },
    { label: "31–60 days", amount: buckets.days30 },
    { label: "61–90 days", amount: buckets.days60 },
    { label: "90+ days", amount: buckets.days90 },
  ];

  const closingBalance = dataset.closingBalance;

  return {
    document_number: `Statement - ${stmt.contact?.name || "Customer"}`,
    document_type: "customer_statement",
    document_type_label: "CUSTOMER STATEMENT",
    status: stmt.sent_at ? "sent" : "draft",
    issue_date: stmt.statement_date || stmt.created_at,
    subtotal: dataset.totalCharges,
    tax_amount: 0,
    discount_amount: 0,
    total: closingBalance,
    amount_paid: dataset.totalCredits,
    currency,
    notes: dataset.otherCurrencies.length
      ? `This statement covers ${currency} activity only. This customer also has activity in: ${dataset.otherCurrencies.join(", ")}.`
      : null,
    terms: null,
    contact: stmt.contact,
    organization: await mapBusinessToOrg(supabase, stmt.business, stmt.organization, stmt.branch_id),
    business_id: stmt.business_id,
    organization_id: stmt.organization_id,
    items: [], // Not used by statement renderer
    statement_transactions: statementTransactions,
    statement_aging: statementAging,
    statement_opening_balance: dataset.openingBalance,
    statement_closing_balance: closingBalance,
    statement_period_start: periodStart,
    statement_period_end: periodEnd,
  };
}


// ── Legal Recipient Statement fetcher (ADR-0093 Phase 3) ────────────────────
//
// A legal-recipient statement is a reconciliation report of every accrual
// (payroll-side) vs. every remittance (payment-side) for one third-party
// recipient (court, agency, SACCO, creditor) over a caller-supplied
// [from, to] window. It is NOT persisted as a row like customer_statement
// — the data is computed live via the `legal_recipient_statement(recipient,
// from, to)` SQL function. Dates therefore ride in on the request body
// and are threaded in at the call site (see the `fetcher` dispatch below);
// this fetcher signature is intentionally different from the others.
async function fetchLegalRecipientStatement(
  supabase: any,
  recipientId: string,
  opts: { periodStart?: string; periodEnd?: string; businessId?: string | null },
): Promise<DocumentData> {
  const periodStart = opts.periodStart;
  const periodEnd = opts.periodEnd;
  if (!periodStart || !periodEnd) {
    throw new Error("legal_recipient_statement requires periodStart and periodEnd");
  }

  const { data: recipient, error: recErr } = await supabase
    .from("legal_recipients")
    .select(`
      id,
      organization_id,
      display_name,
      recipient_type_code,
      jurisdiction_country,
      jurisdiction_region,
      tax_id,
      contact_email,
      contact_phone,
      address,
      organization:organizations(${ORG_FALLBACK_COLS})
    `)
    .eq("id", recipientId)
    .single();

  if (recErr || !recipient) {
    throw new Error(`Legal recipient not found: ${recErr?.message ?? "no row"}`);
  }

  // Optional business branding — legal_recipients has no business_id column,
  // but callers who know which paying business owns the remittance can pass
  // it via body so the statement carries the correct letterhead. The business
  // is ALSO what resolves the statement currency; without it we would emit an
  // unbranded USD document even for a KES tenant.
  let business: any = null;
  if (opts.businessId) {
    const { data: bizRow } = await supabase
      .from("businesses")
      .select(BUSINESS_BRANDING_COLS)
      .eq("id", opts.businessId)
      .maybeSingle();
    business = bizRow ?? null;
  }
  if (!business) {
    // Graceful fallback for callers that omit businessId (scripts, older
    // clients): if the organization owns exactly ONE business, it is
    // unambiguously the paying entity — use its branding/currency. With two
    // or more we cannot guess, so we fall back to organization defaults.
    const { data: bizRows } = await supabase
      .from("businesses")
      .select(BUSINESS_BRANDING_COLS)
      .eq("organization_id", recipient.organization_id)
      .limit(2);
    if (Array.isArray(bizRows) && bizRows.length === 1) {
      business = bizRows[0];
    }
  }


  const { data: entries, error: stmtErr } = await supabase.rpc(
    "legal_recipient_statement",
    {
      p_recipient_id: recipientId,
      p_from: periodStart,
      p_to: periodEnd,
    },
  );
  if (stmtErr) {
    throw new Error(`legal_recipient_statement RPC failed: ${stmtErr.message}`);
  }

  // Accruals (+) increase balance owed to the recipient; remittances (-)
  // decrease it. Map onto the debit/credit shape the shared statement
  // renderer already understands so we reuse the exact PDF layout used
  // for customer/vendor statements.
  type Entry = {
    entry_date: string;
    entry_kind: "accrual" | "remittance";
    reference: string | null;
    amount: number;
  };
  const rows = ((entries ?? []) as Entry[]);

  let opening = 0; // computed opening balance for the period would require a
                   // separate rollup up to periodStart-1; leaving 0 here
                   // keeps the report scoped to the selected window and
                   // matches what the on-screen table shows.
  let running = opening;
  let totalAccrued = 0;
  let totalRemitted = 0;
  const statementTransactions: StatementTransaction[] = [];
  for (const r of rows) {
    const amount = Number(r.amount ?? 0);
    // Accruals are positive in the RPC (money now owed), remittances are
    // negative (money paid out). Statement uses debit=charges (increases
    // liability from the recipient's POV) and credit=payment.
    const debit = amount > 0 ? amount : 0;
    const credit = amount < 0 ? -amount : 0;
    if (r.entry_kind === "accrual") totalAccrued += debit;
    else totalRemitted += credit;
    running += amount;
    statementTransactions.push({
      date: r.entry_date,
      type: r.entry_kind === "accrual" ? "Accrual" : "Remittance",
      reference: r.reference ?? "—",
      description:
        r.entry_kind === "accrual"
          ? "Payroll accrual"
          : `Remittance${r.reference ? ` (${r.reference})` : ""}`,
      charges: debit,
      credits: credit,
      balance: running,
    });
  }

  const closing = running;
  const currency =
    (business?.base_currency as string | undefined) ||
    (recipient.organization?.base_currency as string | undefined) ||
    "USD";

  return {
    document_number: `Statement — ${recipient.display_name}`,
    document_type: "legal_recipient_statement",
    document_type_label: "RECIPIENT STATEMENT",
    status: "issued",
    issue_date: new Date().toISOString(),
    subtotal: totalAccrued,
    tax_amount: 0,
    discount_amount: 0,
    total: closing,
    amount_paid: totalRemitted,
    currency,
    notes: null,
    terms: null,
    contact: {
      name: recipient.display_name,
      email: recipient.contact_email,
      phone: recipient.contact_phone,
      address_line1: recipient.address,
      tax_id: recipient.tax_id,
    },
    organization: await mapBusinessToOrg(
      supabase,
      business,
      recipient.organization,
      null,
    ),
    business_id: (business?.id as string | undefined) ?? opts.businessId ?? null,
    organization_id: recipient.organization_id,
    items: [],
    statement_transactions: statementTransactions,
    statement_aging: [],
    statement_opening_balance: opening,
    statement_closing_balance: closing,
    statement_period_start: periodStart,
    statement_period_end: periodEnd,
  } as DocumentData;
}

// ── Bill (Vendor Bill) fetcher ──────────────────────────────────────────────

async function fetchBill(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: bill, error } = await supabase
    .from("bills")
    .select(`
      *,
      vendor:contacts(name, email, phone, address_line1, city, state, postal_code),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      items:bill_items(*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name)))
    `)
    .eq("id", documentId)
    .single();

  if (error || !bill) throw new Error(`Bill not found: ${error?.message}`);

  return {
    document_number: bill.bill_number,
    document_type: "bill" as any,
    document_type_label: "VENDOR BILL",
    status: bill.status,
    issue_date: bill.bill_date,
    due_date: bill.due_date,
    subtotal: bill.subtotal || 0,
    tax_amount: bill.tax_amount || 0,
    discount_amount: bill.discount_amount || 0,
    total: bill.total,
    amount_paid: bill.amount_paid || 0,
    currency: bill.currency || "USD",
    notes: bill.notes,
    terms: null,
    contact: bill.vendor,
    billing_address: resolveSnapshotAddress(bill.remit_to_address, bill.vendor),
    organization: await mapBusinessToOrg(supabase, bill.business, bill.organization, bill.branch_id),
    business_id: bill.business_id,
    organization_id: bill.organization_id,
    items: (bill.items || []).map((item: any) => ({
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate || 0,
      tax_amount: item.tax_amount || 0,
      line_total: item.line_total,
      ...packFields(item),
    })),
  };
}

// ── Sales Return fetcher ───────────────────────────────────────────────────

async function fetchSalesReturn(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: sr, error } = await supabase
    .from("sales_returns")
    .select(`
      *,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      items:sales_return_items(*, packaging:product_packaging(name, qty_in_base_uom), product:products(base_uom:units_of_measure!base_uom_id(code, name)))
    `)
    .eq("id", documentId)
    .single();

  if (error || !sr) throw new Error(`Sales return not found: ${error?.message}`);

  return {
    document_number: sr.return_number,
    document_type: "sales_return",
    document_type_label: "SALES RETURN",
    status: sr.status,
    issue_date: sr.return_date,
    subtotal: sr.subtotal || 0,
    tax_amount: sr.tax_amount || 0,
    discount_amount: 0,
    total: sr.total,
    currency: sr.currency || "USD",
    notes: sr.reason,
    terms: null,
    contact: sr.contact,
    organization: await mapBusinessToOrg(supabase, sr.business, sr.organization, sr.branch_id),
    business_id: sr.business_id,
    organization_id: sr.organization_id,
    items: (sr.items || []).map((item: any) => ({
      description: item.description || item.product_name || "Item",
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate || 0,
      tax_amount: item.tax_amount || 0,
      line_total: item.line_total,
      ...packFields(item),
    })),
  };
}

// ── Vendor Statement fetcher ───────────────────────────────────────────────

async function fetchVendorStatement(supabase: any, documentId: string): Promise<DocumentData> {
  const { data: stmt, error } = await supabase
    .from("vendor_statements")
    .select(`
      *,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, country, tax_id),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS})
    `)
    .eq("id", documentId)
    .single();

  if (error || !stmt) throw new Error(`Vendor statement not found: ${error?.message}`);

  const contactId = stmt.contact_id;
  const orgId = stmt.organization_id;
  const businessId = stmt.business_id;
  const branchId = stmt.branch_id ?? null;
  const periodStart = stmt.period_start;
  const periodEnd = stmt.period_end;
  const currency = stmt.business?.base_currency || stmt.organization?.base_currency || "USD";

  // SOURCE OF TRUTH: the posted AP subledger (`vendor_ledger_entries`),
  // folded by the SAME builder the app uses (`vendorStatementDataset.ts`,
  // mirrored into _shared). This fetcher previously re-derived the statement
  // from `bills` + `bill_payments` + `vendor_credit_notes`, which hard-coded
  // a status vocabulary, mis-attributed any payment settling several bills,
  // ignored branch and currency, and hid advances and payment reversals.
  let ledgerQuery = supabase
    .from("vendor_ledger_entries")
    .select("entry_date, doc_type, doc_id, doc_ref, debit, credit, currency, created_at")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .lte("entry_date", periodEnd)
    .order("entry_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (businessId) ledgerQuery = ledgerQuery.eq("business_id", businessId);
  if (branchId) ledgerQuery = ledgerQuery.eq("branch_id", branchId);
  const { data: ledgerRows, error: ledgerError } = await ledgerQuery;
  if (ledgerError) throw new Error(`Vendor statement ledger: ${ledgerError.message}`);

  const dataset = buildVendorStatementDataset({
    rows: (ledgerRows || []) as VendorLedgerRow[],
    periodStart,
    periodEnd,
    currency,
  });

  const TYPE_LABEL: Record<string, string> = {
    bill: "Bill",
    bill_payment: "Payment",
    payment: "Payment",
    vendor_credit_note: "Vendor Credit",
    credit_note: "Vendor Credit",
    advance: "Supplier Advance",
    payment_reversal: "Payment Reversal",
  };

  const statementTransactions: StatementTransaction[] = dataset.transactions.map((t) => ({
    date: t.date,
    type: TYPE_LABEL[t.docType] ?? t.docType.replace(/_/g, " "),
    reference: t.reference,
    description: t.description,
    charges: t.debit,
    credits: t.credit,
    balance: t.balance,
    source_id: t.sourceId,
    source_type: t.docType,
  }));

  // Aging: the point-in-time AP engine (`finance_ap_open_items_as_of`), the
  // same source as Aged Payables and `get_ap_summary`. Settlements count only
  // if they happened on or before the period end, and the bucket comes from
  // SQL (`finance_aging_bucket`) — a reprint of a closed period therefore
  // reproduces exactly what the screen showed for that date.
  const { data: openItems, error: agingError } = await supabase.rpc(
    "finance_ap_open_items_as_of",
    {
      _org_id: orgId,
      _business_id: businessId ?? null,
      _branch_id: branchId ?? null,
      _as_of: periodEnd,
    },
  );
  if (agingError) throw new Error(`Vendor statement aging: ${agingError.message}`);

  const buckets = { not_due: 0, current: 0, days30: 0, days60: 0, days90: 0 };
  for (const row of (openItems || []) as any[]) {
    if (row.contact_id !== contactId) continue;
    const residual = Number(row.base_residual_amount ?? row.residual_amount) || 0;
    if (residual <= 0.01) continue;
    const key = String(row.aging_bucket) as keyof typeof buckets;
    if (key in buckets) buckets[key] += residual;
  }


  const statementAging: StatementAgingBucket[] = [
    { label: "Not yet due", amount: buckets.not_due },
    { label: "0–30 days", amount: buckets.current },
    { label: "31–60 days", amount: buckets.days30 },
    { label: "61–90 days", amount: buckets.days60 },
    { label: "90+ days", amount: buckets.days90 },
  ];

  const closingBalance = dataset.closingBalance;

  return {
    document_number: `Vendor Statement - ${stmt.contact?.name || "Vendor"}`,
    document_type: "vendor_statement" as any,
    document_type_label: "VENDOR STATEMENT",
    status: stmt.sent_at ? "sent" : "draft",
    issue_date: stmt.statement_date || stmt.created_at,
    subtotal: dataset.totalCharges,
    tax_amount: 0,
    discount_amount: 0,
    total: closingBalance,
    amount_paid: dataset.totalCredits,
    currency,
    notes: dataset.otherCurrencies.length
      ? `This statement covers ${currency} activity only. This vendor also has activity in: ${dataset.otherCurrencies.join(", ")}.`
      : null,
    terms: null,
    contact: stmt.contact,
    organization: await mapBusinessToOrg(supabase, stmt.business, stmt.organization, stmt.branch_id),
    business_id: stmt.business_id,
    organization_id: stmt.organization_id,
    items: [],
    statement_transactions: statementTransactions,
    statement_aging: statementAging,
    statement_opening_balance: dataset.openingBalance,
    statement_closing_balance: closingBalance,
    statement_period_start: periodStart,
    statement_period_end: periodEnd,
  };
}

// ── Inventory / Warehouse A4 voucher fetchers (Wave 21) ────────────────
//
// These close the three GAP rows in `docs/printing-event-coverage.md`
// (`stock_adjustment`, `stock_transfer`, `vendor_return`). All three
// were previously rendered through page-local HTML printing, bypassing
// the enterprise PDF pipeline. They now flow through the canonical
// `generate-document` → `PdfBuilder` seam like every other A4 voucher.
//
// Media geometry + branding stay in the businesses row via
// `mapBusinessToOrg`. No client-side pdf-lib usage introduced (guarded
// by the `no-raw-pdf-lib-in-app` ESLint rule).

async function fetchStockAdjustment(
  supabase: any,
  documentId: string,
): Promise<DocumentData> {
  const { data: adj, error } = await supabase
    .from("stock_adjustments")
    .select(`
      *,
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      warehouse:warehouses(name),
      items:stock_adjustment_items(
        *,
        packaging:product_packaging(name, qty_in_base_uom),
        product:products(name, sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
    `)
    .eq("id", documentId)
    .single();

  if (error || !adj) {
    throw new Error(`Stock adjustment not found: ${error?.message}`);
  }

  return {
    document_number: adj.adjustment_number,
    document_type: "stock_adjustment",
    document_type_label: "STOCK ADJUSTMENT",
    status: adj.status,
    issue_date: adj.adjustment_date,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency: adj.business?.base_currency || "USD",
    notes: adj.notes || adj.reason || null,
    terms: null,
    contact: null,
    organization: await mapBusinessToOrg(
      supabase,
      adj.business,
      adj.organization,
      adj.branch_id,
    ),
    business_id: adj.business_id,
    organization_id: adj.organization_id,
    items: (adj.items || []).map((item: any) => ({
      description:
        item.product?.name ||
        item.notes ||
        `Product ${item.product_id?.slice?.(0, 8) ?? ""}`,
      quantity: item.quantity_adjustment,
      unit_price: item.unit_cost || 0,
      tax_rate: 0,
      tax_amount: 0,
      line_total: (item.quantity_adjustment || 0) * (item.unit_cost || 0),
      quantity_before: item.quantity_before,
      quantity_after: item.quantity_after,
      lot_number: item.lot_number,
      serial_number: item.serial_number,
      ...packFields(item),
    })),
    hide_amounts: true,
    // Extras surfaced for the invoice-shaped renderer header.
    warehouse_name: adj.warehouse?.name ?? null,
    adjustment_reason: adj.reason,
    adjustment_type: adj.adjustment_type,
  } as DocumentData;
}

async function fetchStockTransfer(
  supabase: any,
  documentId: string,
): Promise<DocumentData> {
  const { data: tr, error } = await supabase
    .from("stock_transfers")
    .select(`
      *,
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      from_warehouse:warehouses!from_warehouse_id(name),
      to_warehouse:warehouses!to_warehouse_id(name),
      items:stock_transfer_items(
        *,
        packaging:product_packaging(name, qty_in_base_uom),
        product:products(name, sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
    `)
    .eq("id", documentId)
    .single();

  if (error || !tr) {
    throw new Error(`Stock transfer not found: ${error?.message}`);
  }

  return {
    document_number: tr.transfer_number,
    document_type: "stock_transfer",
    document_type_label: "STOCK TRANSFER",
    status: tr.status,
    issue_date: tr.transfer_date,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency: tr.business?.base_currency || "USD",
    notes: tr.notes || null,
    terms: null,
    contact: null,
    organization: await mapBusinessToOrg(
      supabase,
      tr.business,
      tr.organization,
      tr.from_branch_id ?? tr.to_branch_id ?? null,
    ),
    business_id: tr.business_id,
    organization_id: tr.organization_id,
    items: (tr.items || []).map((item: any) => ({
      description:
        item.product?.name ||
        item.notes ||
        `Product ${item.product_id?.slice?.(0, 8) ?? ""}`,
      quantity: item.quantity_sent ?? item.quantity_requested,
      unit_price: 0,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 0,
      quantity_requested: item.quantity_requested,
      quantity_sent: item.quantity_sent,
      quantity_received: item.quantity_received,
      ...packFields(item),
    })),
    hide_amounts: true,
    from_warehouse_name: tr.from_warehouse?.name ?? null,
    to_warehouse_name: tr.to_warehouse?.name ?? null,
    expected_arrival_date: tr.expected_arrival_date,
    actual_arrival_date: tr.actual_arrival_date,
  } as DocumentData;
}

async function fetchPurchaseReturn(
  supabase: any,
  documentId: string,
): Promise<DocumentData> {
  const { data: pr, error } = await supabase
    .from("purchase_returns")
    .select(`
      *,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, tax_id),
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      purchase_order:purchase_orders(po_number),
      goods_receipt:goods_receipts(receipt_number),
      items:purchase_return_items(
        *,
        packaging:product_packaging(name, qty_in_base_uom),
        product:products(name, sku, base_uom:units_of_measure!base_uom_id(code, name))
      )
    `)
    .eq("id", documentId)
    .single();

  if (error || !pr) {
    throw new Error(`Vendor return not found: ${error?.message}`);
  }

  return {
    document_number: pr.return_number,
    document_type: "vendor_return",
    document_type_label: "VENDOR RETURN",
    status: pr.status,
    issue_date: pr.return_date,
    subtotal: pr.subtotal || 0,
    tax_amount: pr.tax_amount || 0,
    discount_amount: 0,
    total: pr.total || 0,
    currency: pr.currency || pr.business?.base_currency || "USD",
    notes: pr.notes || pr.reason || null,
    terms: null,
    contact: pr.contact,
    organization: await mapBusinessToOrg(
      supabase,
      pr.business,
      pr.organization,
      pr.branch_id,
    ),
    business_id: pr.business_id,
    organization_id: pr.organization_id,
    // The supplier's copy is worthless without the chain it came from: the
    // RMA the supplier issued, the PO they shipped against and the GRN we
    // booked. Rendered through the header custom-field block so no new
    // template surface is needed.
    custom_fields: buildVendorReturnHeaderFields(pr),
    items: (pr.items || []).map((item: any) => ({
      description:
        decorateVendorReturnLine(
          item.description ||
            item.product?.name ||
            `Item ${item.product_id?.slice?.(0, 8) ?? ""}`,
          item,
        ),
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate || 0,
      tax_amount: item.tax_amount || 0,
      line_total: item.line_total,
      return_reason: item.return_reason,
      condition: item.condition,
      ...packFields(item),
    })),
  } as DocumentData;
}

/** Reason codes as the operator chose them; mirrors PURCHASE_RETURN_REASON_CODES. */
const VENDOR_RETURN_REASON_LABELS: Record<string, string> = {
  damaged: "Damaged in transit",
  defective: "Defective / quality reject",
  wrong_item: "Wrong item supplied",
  over_delivery: "Over-delivery",
  expired: "Expired / short shelf life",
  not_ordered: "Not ordered",
  price_dispute: "Price or billing dispute",
  other: "Other",
};

/**
 * Header meta for the supplier-facing RMA. Every entry is dropped when empty —
 * the renderer only draws custom fields with a value — so a financial-only
 * adjustment prints without empty logistics rows.
 */
// deno-lint-ignore no-explicit-any
function buildVendorReturnHeaderFields(pr: any) {
  const rows: Array<[string, string | null]> = [
    ["RMA Reference", pr.rma_reference ?? null],
    [
      "Return Type",
      pr.return_kind === "financial" ? "Financial adjustment (no goods)" : "Goods return",
    ],
    [
      "Reason",
      pr.reason_code ? (VENDOR_RETURN_REASON_LABELS[pr.reason_code] ?? pr.reason_code) : null,
    ],
    ["Purchase Order", pr.purchase_order?.po_number ?? null],
    ["Goods Receipt", pr.goods_receipt?.receipt_number ?? null],
    ["Dispatched", pr.dispatched_at ? String(pr.dispatched_at).slice(0, 10) : null],
  ];
  return rows
    .filter(([, value]) => value != null && value !== "")
    .map(([field_label, field_value]) => ({
      field_label,
      field_value: field_value as string,
      field_type: "text",
      document_section: "header",
    }));
}

/**
 * Lot / serial / condition travel with the physical goods, so they belong on
 * the printed line rather than in a column the shared renderer does not have.
 */
// deno-lint-ignore no-explicit-any
function decorateVendorReturnLine(description: string, item: any): string {
  const parts: string[] = [];
  if (item.lot_number) parts.push(`Lot ${item.lot_number}`);
  if (item.serial_number) parts.push(`S/N ${item.serial_number}`);
  if (item.condition) parts.push(String(item.condition).replace(/_/g, " "));
  if (item.return_reason) {
    parts.push(
      VENDOR_RETURN_REASON_LABELS[item.return_reason] ??
        String(item.return_reason).replace(/_/g, " "),
    );
  }
  return parts.length ? `${description} (${parts.join(" · ")})` : description;
}

// ── Cycle-count documents (ADR 0106) ───────────────────────────────────────
//
// REMOVED (2026-08-17). The four count artifacts are built by the canonical
// snapshot pipeline — `src/services/documents/snapshots/wmsCount.ts`, frozen
// through `resolveSourceDocumentRecord` and drawn by `render-document`.
// The fetchers that used to live here were a shadow path: they read
// `wms_count_lines` directly, ignored the `approval_state` resolution (so a
// posted count still read "a supervisor must approve"), and resolved people
// against `profiles.id` when the key is `profiles.user_id`, which is why the
// sign-off block rendered blank. Do not reintroduce them.

// ── Dispatch documents (ADR 0110) ──────────────────────────────────────────
// One bundle, four projections. Dispatch orchestrates and REQUESTS these
// artifacts; the Document Platform owns rendering. None of these fetchers
// write anything.

interface ManifestBundle {
  manifest: any;
  cartons: any[];
  lpns: Record<string, any>;
  deliveryNotes: any[];
  proof: any | null;
}

async function loadManifestBundle(
  supabase: any,
  manifestId: string,
): Promise<ManifestBundle> {
  const { data: manifest, error } = await supabase
    .from("wms_loading_manifests")
    .select(`
      *,
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      warehouse:warehouses(name, code),
      carrier:carriers(name, carrier_kind, contact_phone, contact_email),
      carrier_service:carrier_services(name, code, transit_days),
      trailer_visit:wms_trailer_visits(trailer_ref, driver_name, driver_phone, seal_out)
    `)
    .eq("id", manifestId)
    .single();

  if (error || !manifest) {
    throw new Error(`Loading manifest not found: ${error?.message}`);
  }

  const { data: links } = await supabase
    .from("wms_manifest_cartons")
    .select("id, sequence, loaded_at, carton_id")
    .eq("manifest_id", manifestId)
    .order("sequence", { ascending: true });

  const cartonIds = (links || []).map((l: any) => l.carton_id).filter(Boolean);
  const { data: cartonRows } = cartonIds.length
    ? await supabase
        .from("wms_pack_cartons")
        .select(
          "id, sales_order_id, wave_id, weight_kg, length_cm, width_cm, height_cm, " +
            "sealed_at, shipment_lpn_id",
        )
        .in("id", cartonIds)
    : { data: [] };

  const cartonById: Record<string, any> = {};
  for (const c of cartonRows || []) cartonById[c.id] = c;

  const lpnIds = (cartonRows || [])
    .map((c: any) => c.shipment_lpn_id)
    .filter(Boolean);
  const { data: lpnRows } = lpnIds.length
    ? await supabase
        .from("wms_license_plates")
        .select("id, code, status")
        .in("id", lpnIds)
    : { data: [] };
  const lpns: Record<string, any> = {};
  for (const l of lpnRows || []) lpns[l.id] = l;

  const cartons = (links || []).map((l: any) => ({
    ...l,
    carton: cartonById[l.carton_id] ?? null,
  }));

  // ADR 0109 — the manifest is the outbound spine, so the paperwork can
  // name the customer deliveries this load physically carries.
  const { data: notes } = await supabase
    .from("delivery_notes")
    .select("id, delivery_number, status, delivery_address, contact_id")
    .eq("manifest_id", manifestId)
    .limit(200);

  const { data: proof } = await supabase
    .from("wms_dispatch_proofs")
    .select("seal_number, driver_name, driver_id_ref, captured_at, gps_lat, gps_lng")
    .eq("manifest_id", manifestId)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    manifest,
    cartons,
    lpns,
    deliveryNotes: notes || [],
    proof: proof ?? null,
  };
}

function manifestDocumentBase(
  bundle: ManifestBundle,
  documentType: string,
  label: string,
) {
  const { manifest, cartons, proof } = bundle;
  const totalWeight = cartons.reduce(
    (sum, c) => sum + Number(c.carton?.weight_kg ?? 0),
    0,
  );
  return {
    document_number: manifest.code,
    document_type: documentType,
    document_type_label: label,
    status: manifest.state,
    issue_date: manifest.dispatched_at || manifest.closed_at || manifest.created_at,
    due_date: manifest.planned_departure_at ?? null,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency: manifest.business?.base_currency || "USD",
    notes: manifest.notes || null,
    terms: null,
    contact: null,
    business_id: manifest.business_id,
    organization_id: manifest.organization_id,
    hide_amounts: true,
    warehouse_name: manifest.warehouse?.name ?? null,
    carrier_name: manifest.carrier?.name ?? null,
    carrier_kind: manifest.carrier?.carrier_kind ?? null,
    carrier_service_name: manifest.carrier_service?.name ?? null,
    tracking_number: manifest.tracking_number ?? null,
    tracking_url: manifest.tracking_url ?? null,
    trailer_ref: manifest.trailer_visit?.trailer_ref ?? null,
    driver_name: proof?.driver_name ?? manifest.trailer_visit?.driver_name ?? null,
    seal_number: proof?.seal_number ?? manifest.trailer_visit?.seal_out ?? null,
    proof_captured_at: proof?.captured_at ?? null,
    carton_count: cartons.length,
    total_weight_kg: Number(totalWeight.toFixed(3)),
    delivery_numbers: bundle.deliveryNotes
      .map((n: any) => n.delivery_number)
      .filter(Boolean),
  };
}

function cartonLines(bundle: ManifestBundle) {
  return bundle.cartons.map((l: any) => ({
    description: `Carton ${l.sequence}`,
    sku: bundle.lpns[l.carton?.shipment_lpn_id]?.code ?? null,
    lpn_code: bundle.lpns[l.carton?.shipment_lpn_id]?.code ?? null,
    quantity: 1,
    weight_kg: l.carton?.weight_kg ?? null,
    dimensions_cm:
      l.carton?.length_cm && l.carton?.width_cm && l.carton?.height_cm
        ? `${l.carton.length_cm}×${l.carton.width_cm}×${l.carton.height_cm}`
        : null,
    sealed_at: l.carton?.sealed_at ?? null,
    loaded_at: l.loaded_at ?? null,
    unit_price: 0,
    tax_rate: 0,
    tax_amount: 0,
    line_total: 0,
  }));
}

/** Bill of lading — the carrier's contract of carriage for this load. */
async function fetchBillOfLading(
  supabase: any,
  documentId: string,
): Promise<DocumentData> {
  const bundle = await loadManifestBundle(supabase, documentId);
  const { manifest } = bundle;
  return {
    ...manifestDocumentBase(bundle, "bill_of_lading", "BILL OF LADING"),
    organization: await mapBusinessToOrg(
      supabase,
      manifest.business,
      manifest.organization,
      manifest.branch_id,
    ),
    items: cartonLines(bundle),
  } as unknown as DocumentData;
}

/** Dispatch manifest — the internal load sheet, carton by carton. */
async function fetchDispatchManifest(
  supabase: any,
  documentId: string,
): Promise<DocumentData> {
  const bundle = await loadManifestBundle(supabase, documentId);
  const { manifest } = bundle;
  return {
    ...manifestDocumentBase(bundle, "dispatch_manifest", "DISPATCH MANIFEST"),
    organization: await mapBusinessToOrg(
      supabase,
      manifest.business,
      manifest.organization,
      manifest.branch_id,
    ),
    items: cartonLines(bundle),
  } as unknown as DocumentData;
}

/** Packing list — travels with the goods; per delivery, per carton. */
async function fetchPackingList(
  supabase: any,
  documentId: string,
): Promise<DocumentData> {
  const bundle = await loadManifestBundle(supabase, documentId);
  const { manifest, cartons } = bundle;

  const soIds = [
    ...new Set(cartons.map((c: any) => c.carton?.sales_order_id).filter(Boolean)),
  ];
  const { data: orders } = soIds.length
    ? await supabase
        .from("sales_orders")
        .select("id, order_number")
        .in("id", soIds)
    : { data: [] };
  const orderById: Record<string, any> = {};
  for (const o of orders || []) orderById[o.id] = o;

  return {
    ...manifestDocumentBase(bundle, "packing_list", "PACKING LIST"),
    organization: await mapBusinessToOrg(
      supabase,
      manifest.business,
      manifest.organization,
      manifest.branch_id,
    ),
    items: cartons.map((l: any) => ({
      description: `Carton ${l.sequence}`,
      sku: bundle.lpns[l.carton?.shipment_lpn_id]?.code ?? null,
      order_number: orderById[l.carton?.sales_order_id]?.order_number ?? null,
      quantity: 1,
      weight_kg: l.carton?.weight_kg ?? null,
      unit_price: 0,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 0,
    })),
  } as unknown as DocumentData;
}

/**
 * Carrier label — one 4x6 artifact per load. The tracking number must
 * already be allocated (`wms_allocate_tracking_number`); rendering never
 * mints one, so a label can never disagree with the manifest.
 */
async function fetchCarrierLabel(
  supabase: any,
  documentId: string,
): Promise<DocumentData> {
  const bundle = await loadManifestBundle(supabase, documentId);
  const { manifest } = bundle;
  return {
    ...manifestDocumentBase(bundle, "carrier_label", "CARRIER LABEL"),
    organization: await mapBusinessToOrg(
      supabase,
      manifest.business,
      manifest.organization,
      manifest.branch_id,
    ),
    barcode_value: manifest.tracking_number ?? manifest.code,
    items: cartonLines(bundle),
  } as unknown as DocumentData;
}

/**
 * Labour worksheet (WLM Phase F) — the paper counterpart of an operator's
 * handheld work list. `documentId` is a `wms_operators.id`.
 *
 * Read model only: it projects the operator's currently held tasks plus the
 * day's earned/clocked figures. It never assigns, never claims and never
 * writes a labour entry — paper is an output of the labour engine, never an
 * input to it.
 */
async function fetchLabourWorksheet(
  supabase: any,
  documentId: string,
): Promise<DocumentData> {
  const { data: operator, error } = await supabase
    .from("wms_operators")
    .select(`
      *,
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      warehouse:warehouses(name, code, branch_id),
      employee:employees(first_name, last_name, employee_number)
    `)
    .eq("id", documentId)
    .single();

  if (error || !operator) {
    throw new Error(`Operator not found: ${error?.message}`);
  }

  const { data: tasks } = await supabase
    .from("wms_tasks")
    .select(
      "id, task_type, state, priority, quantity, uom, sla_at, zone_id, product_id, source_location_id, destination_location_id",
    )
    .eq("warehouse_id", operator.warehouse_id)
    .eq("assignee_user_id", operator.user_id)
    .in("state", ["assigned", "claimed", "in_progress", "paused", "resumed"])
    .order("priority", { ascending: false })
    .limit(200);

  const rows: any[] = tasks || [];
  const productIds = [...new Set(rows.map((t) => t.product_id).filter(Boolean))];
  const locationIds = [
    ...new Set(
      [
        ...rows.map((t) => t.source_location_id),
        ...rows.map((t) => t.destination_location_id),
      ].filter(Boolean),
    ),
  ];

  const [productRes, locationRes] = await Promise.all([
    productIds.length
      ? supabase.from("products").select("id, name, sku").in("id", productIds)
      : Promise.resolve({ data: [] }),
    locationIds.length
      ? supabase
          .from("stock_locations")
          .select("id, name, code, barcode")
          .in("id", locationIds)
      : Promise.resolve({ data: [] }),
  ]);

  const products: Record<string, any> = {};
  for (const p of productRes?.data || []) products[p.id] = p;
  const locations: Record<string, any> = {};
  for (const l of locationRes?.data || []) locations[l.id] = l;

  const today = new Date().toISOString().slice(0, 10);
  const { data: util } = await supabase
    .from("wms_operator_utilisation_view")
    .select("tasks_completed, earned_seconds, direct_seconds, indirect_seconds, idle_seconds, true_utilisation")
    .eq("warehouse_id", operator.warehouse_id)
    .eq("user_id", operator.user_id)
    .eq("day", today)
    .maybeSingle();

  const operatorName =
    [operator.employee?.first_name, operator.employee?.last_name]
      .filter(Boolean)
      .join(" ") ||
    operator.operator_code ||
    "Operator";

  return {
    document_number: operator.operator_code || operator.id.slice(0, 8),
    document_type: "labour_worksheet",
    document_type_label: "LABOUR WORKSHEET",
    status: operator.status,
    issue_date: new Date().toISOString(),
    due_date: null,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency: operator.business?.base_currency || "USD",
    notes: operator.notes || null,
    terms: null,
    contact: null,
    business_id: operator.business_id,
    organization_id: operator.organization_id,
    hide_amounts: true,
    warehouse_name: operator.warehouse?.name ?? null,
    operator_name: operatorName,
    operator_status: operator.status,
    tasks_completed_today: Number(util?.tasks_completed ?? 0),
    earned_minutes_today: Math.round(Number(util?.earned_seconds ?? 0) / 60),
    clocked_minutes_today: Math.round(
      (Number(util?.direct_seconds ?? 0) +
        Number(util?.indirect_seconds ?? 0) +
        Number(util?.idle_seconds ?? 0)) /
        60,
    ),
    organization: await mapBusinessToOrg(
      supabase,
      operator.business,
      operator.organization,
      operator.warehouse?.branch_id ?? null,
    ),
    items: rows.map((t) => ({
      description:
        products[t.product_id]?.name ||
        String(t.task_type).replace(/_/g, " ").toUpperCase(),
      sku: products[t.product_id]?.sku ?? null,
      location_name:
        locations[t.source_location_id]?.name ||
        locations[t.source_location_id]?.code ||
        null,
      location_barcode: locations[t.source_location_id]?.barcode ?? null,
      destination_name:
        locations[t.destination_location_id]?.name ||
        locations[t.destination_location_id]?.code ||
        null,
      quantity: Number(t.quantity ?? 0),
      uom: t.uom ?? null,
      task_state: t.state,
      task_priority: t.priority ?? 0,
      sla_at: t.sla_at ?? null,
      unit_price: 0,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 0,
    })),
  } as unknown as DocumentData;
}

/**
 * WLM Phase I — shift roster / labour plan sheet.
 *
 * `documentId` is a `warehouses.id`; the window defaults to today .. +13 days
 * and can be narrowed with `periodStart` / `periodEnd` on the request body.
 * Read model only — the roster lives in `wms_operator_shifts`.
 */
async function fetchLabourRoster(
  supabase: any,
  documentId: string,
  opts?: { periodStart?: string; periodEnd?: string },
): Promise<DocumentData> {
  const { data: warehouse, error } = await supabase
    .from("warehouses")
    .select(`
      id, name, code, branch_id, business_id, organization_id,
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS})
    `)
    .eq("id", documentId)
    .single();

  if (error || !warehouse) {
    throw new Error(`Warehouse not found: ${error?.message}`);
  }

  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = opts?.periodStart || iso(today);
  const to =
    opts?.periodEnd ||
    iso(new Date(today.getTime() + 13 * 24 * 60 * 60 * 1000));

  const { data: shifts } = await supabase
    .from("wms_operator_shifts")
    .select(`
      id, shift_date, start_time, end_time, break_minutes, status, notes,
      operator:wms_operators(
        operator_code,
        employee:employees(first_name, last_name, employee_number)
      ),
      pattern:wms_shift_patterns(code, name)
    `)
    .eq("warehouse_id", documentId)
    .gte("shift_date", from)
    .lte("shift_date", to)
    .neq("status", "cancelled")
    .order("shift_date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(500);

  const rows: any[] = shifts || [];

  const plannedMinutes = rows.reduce((sum, s) => {
    const [sh, sm] = String(s.start_time).split(":").map(Number);
    const [eh, em] = String(s.end_time).split(":").map(Number);
    let mins = eh * 60 + em - (sh * 60 + sm);
    if (mins <= 0) mins += 24 * 60;
    return sum + Math.max(0, mins - Number(s.break_minutes || 0));
  }, 0);

  return {
    document_number: `${warehouse.code || "WH"}-${from}`,
    document_type: "labour_roster",
    document_type_label: "SHIFT ROSTER",
    status: "published",
    issue_date: new Date().toISOString(),
    due_date: null,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency: warehouse.business?.base_currency || "USD",
    notes: null,
    terms: null,
    contact: null,
    business_id: warehouse.business_id,
    organization_id: warehouse.organization_id,
    hide_amounts: true,
    warehouse_name: warehouse.name ?? null,
    period_start: from,
    period_end: to,
    planned_shifts: rows.length,
    planned_hours: Math.round((plannedMinutes / 60) * 10) / 10,
    organization: await mapBusinessToOrg(
      supabase,
      warehouse.business,
      warehouse.organization,
      warehouse.branch_id ?? null,
    ),
    items: rows.map((s) => {
      const emp = s.operator?.employee;
      const name =
        [emp?.first_name, emp?.last_name].filter(Boolean).join(" ") ||
        s.operator?.operator_code ||
        "Operator";
      return {
        description: `${s.shift_date} — ${name}`,
        sku: s.operator?.operator_code ?? emp?.employee_number ?? null,
        shift_date: s.shift_date,
        operator_name: name,
        shift_window: `${String(s.start_time).slice(0, 5)}–${String(s.end_time).slice(0, 5)}`,
        pattern_name: s.pattern?.name ?? null,
        break_minutes: Number(s.break_minutes || 0),
        shift_status: s.status,
        quantity: 1,
        uom: "shift",
        unit_price: 0,
        tax_rate: 0,
        tax_amount: 0,
        line_total: 0,
      };
    }),
  } as unknown as DocumentData;
}

/**
 * ADR-0112 Phase 5 — wave paperwork.
 *
 * One bundle, two artifacts: the pick list (line-by-line walk order for the
 * floor) and the wave summary (supervisor's release sheet). Both are read
 * models over `wms_pick_waves`; rendering never plans, never releases and
 * never touches a reservation.
 */
async function loadWaveBundle(supabase: any, waveId: string) {
  const { data: wave, error } = await supabase
    .from("wms_pick_waves")
    .select(`
      *,
      organization:organizations(${ORG_FALLBACK_COLS}),
      business:businesses(${BUSINESS_BRANDING_COLS}),
      warehouse:warehouses(name, code, branch_id),
      strategy_row:wms_wave_strategies(code, name, kind),
      carrier:carriers(name)
    `)
    .eq("id", waveId)
    .single();

  if (error || !wave) throw new Error(`Wave not found: ${error?.message}`);

  const { data: lines } = await supabase
    .from("wms_pick_wave_lines")
    .select(
      "id, sales_order_id, product_id, lot_number, quantity_ordered, quantity_picked",
    )
    .eq("wave_id", waveId)
    .limit(2000);

  const { data: tasks } = await supabase
    .from("wms_tasks")
    .select(
      "id, task_type, state, product_id, quantity, uom, source_location_id, destination_location_id, priority, assignee_user_id",
    )
    .eq("wave_id", waveId)
    .limit(2000);

  const rows: any[] = lines || [];
  const taskRows: any[] = tasks || [];

  const productIds = [
    ...new Set(
      [...rows, ...taskRows].map((r: any) => r.product_id).filter(Boolean),
    ),
  ];
  const { data: productRows } = productIds.length
    ? await supabase
        .from("products")
        .select("id, name, sku")
        .in("id", productIds)
    : { data: [] };
  const products: Record<string, any> = {};
  for (const p of productRows || []) products[p.id] = p;

  const locationIds = [
    ...new Set(
      taskRows.flatMap((t: any) => [t.source_location_id, t.destination_location_id])
        .filter(Boolean),
    ),
  ];
  const { data: locationRows } = locationIds.length
    ? await supabase
        .from("stock_locations")
        .select("id, name, code, barcode")
        .in("id", locationIds)
    : { data: [] };
  const locations: Record<string, any> = {};
  for (const l of locationRows || []) locations[l.id] = l;

  const soIds = [...new Set(rows.map((r: any) => r.sales_order_id).filter(Boolean))];
  const { data: orderRows } = soIds.length
    ? await supabase
        .from("sales_orders")
        .select("id, order_number")
        .in("id", soIds)
    : { data: [] };
  const orders: Record<string, any> = {};
  for (const o of orderRows || []) orders[o.id] = o;

  return { wave, lines: rows, tasks: taskRows, products, locations, orders };
}

function waveDocumentBase(
  bundle: Awaited<ReturnType<typeof loadWaveBundle>>,
  documentType: string,
  label: string,
) {
  const { wave } = bundle;
  return {
    document_number: wave.wave_number,
    document_type: documentType,
    document_type_label: label,
    status: wave.state,
    issue_date: wave.released_at || wave.created_at,
    due_date: wave.cutoff_at ?? null,
    subtotal: 0,
    tax_amount: 0,
    discount_amount: 0,
    total: 0,
    currency: wave.business?.base_currency || "USD",
    notes: wave.notes ?? null,
    terms: null,
    contact: null,
    business_id: wave.business_id,
    organization_id: wave.organization_id,
    hide_amounts: true,
    warehouse_name: wave.warehouse?.name ?? null,
    wave_number: wave.wave_number,
    wave_state: wave.state,
    wave_strategy: wave.strategy_row?.name || wave.strategy || null,
    wave_priority: wave.priority ?? null,
    carrier_name: wave.carrier?.name ?? null,
    cutoff_at: wave.cutoff_at ?? null,
    planned_start_at: wave.planned_start_at ?? null,
    released_at: wave.released_at ?? null,
  };
}

/** Wave pick list — the paper walk order for the floor. */
async function fetchWavePickList(
  supabase: any,
  documentId: string,
): Promise<DocumentData> {
  const bundle = await loadWaveBundle(supabase, documentId);
  const { wave, tasks, lines, products, locations, orders } = bundle;

  // Prefer generated pick tasks (they carry walk order + bin); fall back to
  // wave lines when the wave has not been released yet.
  const picks = tasks.filter((t: any) => t.task_type === "pick");
  const source = picks.length ? picks : lines;

  const items = picks.length
    ? picks
        .sort((a: any, b: any) => {
          const la = locations[a.source_location_id]?.code || "";
          const lb = locations[b.source_location_id]?.code || "";
          return la.localeCompare(lb);
        })
        .map((t: any) => ({
          description: products[t.product_id]?.name || "Unknown product",
          sku: products[t.product_id]?.sku ?? null,
          location_name:
            locations[t.source_location_id]?.code
            || locations[t.source_location_id]?.name
            || null,
          location_barcode: locations[t.source_location_id]?.barcode ?? null,
          destination_name:
            locations[t.destination_location_id]?.code
            || locations[t.destination_location_id]?.name
            || null,
          quantity: Number(t.quantity ?? 0),
          picked_quantity: null,
          uom: t.uom ?? null,
          task_state: t.state,
          unit_price: 0,
          tax_rate: 0,
          tax_amount: 0,
          line_total: 0,
        }))
    : lines.map((l: any) => ({
        description: products[l.product_id]?.name || "Unknown product",
        sku: products[l.product_id]?.sku ?? null,
        order_number: orders[l.sales_order_id]?.order_number ?? null,
        lot_number: l.lot_number ?? null,
        quantity: Number(l.quantity_ordered ?? 0),
        picked_quantity: null,
        unit_price: 0,
        tax_rate: 0,
        tax_amount: 0,
        line_total: 0,
      }));

  return {
    ...waveDocumentBase(bundle, "wave_pick_list", "WAVE PICK LIST"),
    organization: await mapBusinessToOrg(
      supabase,
      wave.business,
      wave.organization,
      wave.warehouse?.branch_id ?? wave.branch_id ?? null,
    ),
    total_lines: source.length,
    items,
  } as unknown as DocumentData;
}

/** Wave summary — supervisor release sheet: demand, progress, readiness. */
async function fetchWaveSummary(
  supabase: any,
  documentId: string,
): Promise<DocumentData> {
  const bundle = await loadWaveBundle(supabase, documentId);
  const { wave, tasks, lines, products, orders } = bundle;

  const byOrder: Record<string, { lines: number; ordered: number; picked: number }> = {};
  for (const l of lines) {
    const key = l.sales_order_id || "unassigned";
    const agg = (byOrder[key] ||= { lines: 0, ordered: 0, picked: 0 });
    agg.lines += 1;
    agg.ordered += Number(l.quantity_ordered ?? 0);
    agg.picked += Number(l.quantity_picked ?? 0);
  }

  const completed = tasks.filter((t: any) => t.state === "completed").length;

  return {
    ...waveDocumentBase(bundle, "wave_summary", "WAVE SUMMARY"),
    organization: await mapBusinessToOrg(
      supabase,
      wave.business,
      wave.organization,
      wave.warehouse?.branch_id ?? wave.branch_id ?? null,
    ),
    total_orders: Object.keys(byOrder).length,
    total_lines: lines.length,
    total_tasks: tasks.length,
    completed_tasks: completed,
    estimated_pick_minutes: wave.estimated_pick_minutes ?? null,
    estimated_units: wave.estimated_units ?? null,
    estimated_cartons: wave.estimated_cartons ?? null,
    readiness_state:
      (wave.readiness && (wave.readiness as any).state) ?? null,
    readiness_checked_at: wave.readiness_checked_at ?? null,
    items: Object.entries(byOrder).map(([soId, agg]) => ({
      description:
        orders[soId]?.order_number
        || (soId === "unassigned" ? "Unassigned demand" : soId),
      sku: null,
      order_number: orders[soId]?.order_number ?? null,
      line_count: agg.lines,
      quantity: agg.ordered,
      picked_quantity: agg.picked,
      unit_price: 0,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 0,
    })),
    // Products touched, for the supervisor's at-a-glance mix.
    product_count: new Set(lines.map((l: any) => l.product_id).filter(Boolean)).size,
    product_names: [
      ...new Set(
        lines.map((l: any) => products[l.product_id]?.name).filter(Boolean),
      ),
    ].slice(0, 20),
  } as unknown as DocumentData;
}

const TEMPLATE_TYPE_MAP: Record<string, string> = {
  invoice: "invoice",
  estimate: "estimate",
  proforma: "proforma",
  credit_note: "credit_note",
  purchase_order: "purchase_order",
  receipt: "receipt",
  pos_receipt: "receipt",
  sales_order: "invoice",
  delivery_note: "invoice",
  sales_return: "credit_note",
  // Statements are ledgers, not transactional documents. Mapping them to the
  // tenant's invoice template made them inherit invoice labels ("Bill To"),
  // an item table and an "Amount Paid / Balance Due" block. An unmatched
  // template_type falls back to DEFAULT_TEMPLATE_SETTINGS (branding only),
  // which is exactly what a statement wants until a tenant configures one.
  customer_statement: "statement",
  vendor_statement: "statement",
  legal_recipient_statement: "statement",
  bill: "invoice",
  // Wave 21 — inventory / warehouse A4 vouchers.
  // These reuse the invoice template shape (numbered header, tabular
  // body, totals block optional). Media geometry + branding still
  // come from `businesses` via `mapBusinessToOrg`.
  stock_adjustment: "invoice",
  stock_transfer: "invoice",
  vendor_return: "credit_note",
  purchase_return: "credit_note",
  // ADR 0110 — dispatch paperwork. The bill of lading and the dispatch
  // manifest are the carrier-facing artifacts; the packing list travels
  // with the goods; the carrier label is a 4x6 thermal artifact and is
  // deliberately NOT an A4 invoice shape.
  bill_of_lading: "invoice",
  dispatch_manifest: "invoice",
  packing_list: "invoice",
  carrier_label: "invoice",
  // WLM Phase I — labour paperwork resolves its OWN template rows. It must
  // not inherit the tenant's invoice template: bank details, payment
  // instructions and finance watermarks have no business on a work sheet.
  labour_worksheet: "labour_worksheet",
  labour_roster: "labour_roster",
  // ADR-0112 Phase 5 — wave paperwork reuses the tabular invoice shape;
  // money columns are stripped by the overrides below.
  wave_pick_list: "invoice",
  wave_summary: "invoice",
};

/**
 * WLM Phase I — per-type template overlay for labour paperwork.
 *
 * Applied on top of whatever `fetchTemplate` resolves so that a tenant who
 * has never configured a `labour_worksheet` template still gets a work sheet
 * (no money columns, no banking block, an operator signature line) rather
 * than the invoice defaults.
 */
const LABOUR_TEMPLATE_OVERRIDES: Record<string, Record<string, unknown>> = {
  labour_worksheet: {
    show_unit_price: false,
    show_tax_column: false,
    show_discount_column: false,
    show_subtotal: false,
    show_discount_total: false,
    show_tax_breakdown: false,
    show_total_in_words: false,
    show_payment_instructions: false,
    show_bank_details: false,
    show_payment_methods: false,
    show_signature_line: true,
    signature_label: "Operator signature",
    show_status_badge: true,
  },
  labour_roster: {
    show_unit_price: false,
    show_tax_column: false,
    show_discount_column: false,
    show_subtotal: false,
    show_discount_total: false,
    show_tax_breakdown: false,
    show_total_in_words: false,
    show_payment_instructions: false,
    show_bank_details: false,
    show_payment_methods: false,
    show_signature_line: true,
    signature_label: "Supervisor signature",
    show_status_badge: false,
  },
  // ADR-0112 Phase 5 — wave documents are floor paperwork, never finance.
  wave_pick_list: {
    show_unit_price: false,
    show_tax_column: false,
    show_discount_column: false,
    show_subtotal: false,
    show_discount_total: false,
    show_tax_breakdown: false,
    show_total_in_words: false,
    show_payment_instructions: false,
    show_bank_details: false,
    show_payment_methods: false,
    show_signature_line: true,
    signature_label: "Picker signature",
    show_status_badge: true,
  },
  wave_summary: {
    show_unit_price: false,
    show_tax_column: false,
    show_discount_column: false,
    show_subtotal: false,
    show_discount_total: false,
    show_tax_breakdown: false,
    show_total_in_words: false,
    show_payment_instructions: false,
    show_bank_details: false,
    show_payment_methods: false,
    show_signature_line: true,
    signature_label: "Supervisor signature",
    show_status_badge: true,
  },
  // Purchase returns (RMA). The supplier copy is a goods-and-reason
  // document: it keeps the valuation ladder (the debit note is claimed
  // against it) but must never carry OUR payment instructions or bank
  // details — money flows the other way on a return.
  vendor_return: {
    show_payment_instructions: false,
    show_bank_details: false,
    show_payment_methods: false,
    show_total_in_words: false,
    show_signature_line: true,
    signature_label: "Received by (supplier)",
    show_status_badge: true,
  },
  purchase_return: {
    show_payment_instructions: false,
    show_bank_details: false,
    show_payment_methods: false,
    show_total_in_words: false,
    show_signature_line: true,
    signature_label: "Received by (supplier)",
    show_status_badge: true,
  },
};


const FETCHER_MAP: Record<string, (supabase: any, id: string) => Promise<DocumentData>> = {
  invoice: fetchInvoice,
  estimate: fetchEstimate,
  proforma: fetchProforma,
  credit_note: fetchCreditNote,
  purchase_order: fetchPurchaseOrder,
  receipt: fetchReceipt,
  pos_receipt: fetchPOSReceipt,
  // Wave 10 — kitchen tickets reuse the POS receipt fetcher to read the
  // frozen snapshot. The kitchen render path then projects the receipt's
  // items down to a `KitchenTicketData` shape and IGNORES every receipt
  // field that doesn't belong on a kitchen ticket (totals, payments,
  // tax, fiscal blocks, branding).
  kitchen_ticket: fetchPOSReceipt,
  sales_order: fetchSalesOrder,
  delivery_note: fetchDeliveryNote,
  sales_return: fetchSalesReturn,
  customer_statement: fetchCustomerStatement,
  vendor_statement: fetchVendorStatement,
  // Sentinel — the real dispatch for legal_recipient_statement is
  // special-cased at the call site so it can receive periodStart/periodEnd
  // from the request body. Registered here only so the "Unsupported
  // document type" gate lets the request through.
  legal_recipient_statement: (async () => {
    throw new Error("legal_recipient_statement must be dispatched via the special-case call site");
  }) as unknown as (supabase: any, id: string) => Promise<DocumentData>,
  bill: fetchBill,
  // Wave 12 C2 — alias both naming conventions; UI uses `goods_received_note`.
  goods_received_note: fetchGoodsReceivedNote,
  goods_receipt: fetchGoodsReceivedNote,
  // Wave 21 — inventory / warehouse A4 vouchers.
  stock_adjustment: fetchStockAdjustment,
  stock_transfer: fetchStockTransfer,
  // `vendor_return` is the canonical name in the coverage matrix; the
  // legacy alias `purchase_return` resolves to the same fetcher so both
  // client naming conventions work.
  vendor_return: fetchPurchaseReturn,
  purchase_return: fetchPurchaseReturn,
  // Phase B1 — cash-drawer audit slip (SOX / PCI evidence for every
  // out-of-band drawer open). Backed by `pos_cash_movements`; the
  // short-circuit renderer bypasses the invoice/receipt pipeline
  // entirely (no templates, no branding config, no fiscal blocks).
  drawer_slip: fetchDrawerSlip,
  // ADR 0110 — dispatch documents. Dispatch REQUESTS documents; it never
  // renders them. Four artifacts, four fetchers over one manifest bundle.
  bill_of_lading: fetchBillOfLading,
  dispatch_manifest: fetchDispatchManifest,
  packing_list: fetchPackingList,
  carrier_label: fetchCarrierLabel,
  // WLM Phase F — the paper twin of the handheld work list; read model only.
  labour_worksheet: fetchLabourWorksheet,
  // WLM Phase I — shift roster sheet keyed by warehouse id.
  labour_roster: fetchLabourRoster,
  // ADR-0112 Phase 5 — wave paperwork, keyed by wave id.
  wave_pick_list: fetchWavePickList,
  wave_summary: fetchWaveSummary,


};

// ── Main Handler ───────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ code: 401, message: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    const { data: userData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !userData?.user) {
      return new Response(
        JSON.stringify({ code: 401, message: "Invalid JWT" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const body = await req.json();
    const { documentType, documentId, format } = body;
    // Stage P3 (ADR-0008): optional paper override. Accepts a preset name
    // ("a4" | "letter" | "a5" | "80mm" | "58mm") or { widthMm, heightMm }.
    // Default behaviour (A4 portrait) is unchanged when omitted.
    const paperFormat = body.paperFormat;
    const renderMode = body.renderMode;
    const branchIdOverride = body.branchId ?? null;
    // UX-1 (post ADR-0008): when the caller is rendering a *preview* of a
    // document whose print policy is thermal (ESC/POS), it can ask the
    // server to render the PDF at the thermal width instead of being
    // coerced to A4. The PDF is intended for on-screen preview / archive
    // / download; the actual print transport is still ESC/POS via a
    // separate request. Default false preserves prior behaviour.
    const previewAtThermalWidth = body.previewAtThermalWidth === true;
    // Phase 3 — opt-in: rebuild receipt settings from live DB on reprint
    // even when a frozen snapshot exists. Default false keeps the existing
    // byte-stable reprint contract.
    const forceRefreshSettings = body.force_refresh_settings === true;

    // ─── Subscription entitlement check (deferred until orgId is known) ───
    const { checkSubscriptionActive: checkSubActive, entitlementDeniedResponse: entDenied } = await import("../_shared/entitlementCheck.ts");

    // Stage P5 (ADR-0008): supported output formats are "pdf" (default) and
    // "escpos" (raw bytes for thermal printers). Both are produced by the
    // SAME fetchers / policy resolver — one unified engine. The HTML preview
    // branch was removed in Stage G.
    if (format && format !== "pdf" && format !== "escpos" && format !== "zpl" && format !== "csv") {
      return new Response(
        JSON.stringify({ error: `Unsupported format "${format}". Supported: "pdf", "escpos", "zpl", "csv".` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Milestone C.1 — tabular exports are gated to statement document types.
    // `format=csv` for anything else 400s here so it never reaches the
    // sales/receipt/label renderer path by accident.
    const CSV_EXPORT_ALLOWED = new Set<string>(["customer_statement", "vendor_statement", "legal_recipient_statement"]);
    if (format === "csv" && !CSV_EXPORT_ALLOWED.has(String(documentType))) {
      return new Response(
        JSON.stringify({ error: `format="csv" is only supported for: ${[...CSV_EXPORT_ALLOWED].join(", ")}.` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Audit Wave 11 (P0 R6): ZPL rendering MOVED below tenant gating ───
    // The ZPL early-exit that used to live here bypassed the org-membership
    // and subscription-entitlement checks (see `2026-06-10-hardware-print-
    // reaudit.md` §12). It now runs after `getOrganizationId` →
    // `user_roles` membership → `checkSubActive`, mirroring the
    // kitchen_ticket short-circuit placement.



    // ── Stage R1.6: synthetic Test Print branch ───────────────────────────
    // `pos_receipt_preview` is a settings-validation surface. It NEVER reads
    // or writes pos_transactions; the entire DocumentData is built from the
    // request body. Used by the "Send test print" buttons in Settings →
    // Receipts and POS Settings → Receipts so cashiers/admins can validate
    // the live settings → bytes pipeline without ringing up a fake sale.
    if (documentType === "pos_receipt_preview") {
      if (format && format !== "escpos") {
        return new Response(
          JSON.stringify({ error: "pos_receipt_preview only supports format=escpos." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // Hard guard: reject anything that smells like a real DB id. The only
      // legal `documentId` here is the literal sentinel "test-print".
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (documentId && documentId !== "test-print") {
        if (UUID_RE.test(String(documentId))) {
          return new Response(
            JSON.stringify({ error: "pos_receipt_preview cannot reference a real transaction id." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
      const previewSettings = (body.receiptSettings ?? {}) as Record<string, unknown>;
      const previewBranding = (body.branding ?? {}) as Record<string, unknown>;
      // Bug 2 fix — width resolution deferred until printer profile is
      // loaded below. Placeholder assigned after `resolvePaperWidth(...)`.
      let previewWidth: "40mm" | "58mm" | "80mm" = "80mm";
      let previewWidthSource: string = "engine-default";
      const currency = (previewBranding.base_currency as string) || "USD";
      const fixtureItems = [
        {
          description: "Espresso (double)",
          quantity: 2,
          unit_price: 3.5,
          tax_rate: 16,
          tax_amount: 1.12,
          tax_rate_name: "VAT 16%",
          discount_percent: 0,
          discount_amount: 0,
          line_total: 7.0,
          sku: "BEV-ESP-2",
        },
        {
          description: "Croissant",
          quantity: 1,
          unit_price: 2.25,
          tax_rate: 16,
          tax_amount: 0.36,
          tax_rate_name: "VAT 16%",
          discount_percent: 10,
          discount_amount: 0.23,
          line_total: 2.02,
          sku: "BAK-CRO-1",
        },
        {
          description: "Bottled water 500ml",
          quantity: 1,
          unit_price: 1.0,
          tax_rate: 0,
          tax_amount: 0,
          tax_rate_name: "Zero",
          discount_percent: 0,
          discount_amount: 0,
          line_total: 1.0,
          sku: "BEV-WTR-500",
        },
      ];
      const subtotal = 10.02;
      const tax = 1.48;
      const total = 10.02;
      const previewDoc: any = {
        document_number: "TEST-PRINT-0001",
        document_type: "pos_receipt",
        document_type_label: "TEST PRINT",
        status: "completed",
        issue_date: new Date().toISOString(),
        subtotal,
        tax_amount: tax,
        discount_amount: 0.23,
        total,
        amount_paid: total,
        currency,
        notes: null,
        terms: null,
        contact: { name: "Walk-in Customer" },
        organization: {
          id: "preview",
          name: previewBranding.name || "Your Company",
          legal_name: previewBranding.legal_name ?? null,
          logo_url: previewBranding.logo_url ?? null,
          email: previewBranding.email ?? null,
          phone: previewBranding.phone ?? null,
          address: previewBranding.address ?? null,
          city: previewBranding.city ?? null,
          state: previewBranding.state ?? null,
          postal_code: previewBranding.postal_code ?? null,
          country: previewBranding.country ?? null,
          tax_id: previewBranding.tax_id ?? null,
          base_currency: currency,
          timezone: previewBranding.timezone ?? null,
        },
        items: fixtureItems,
        payment_method: "Cash",
        cashier_name: (body.cashierName as string) || "Test Cashier",
        register_id: null,
        register_name: (body.registerName as string) || "Test Register",
        pos_payments: [
          { payment_method: "cash", amount: total, reference: null },
        ],
        etims_cu_number: previewSettings.show_etims_info ? "KRACU0100000001" : null,
        etims_qr_data: previewSettings.show_etims_qr
          ? "https://etims.kra.go.ke/preview"
          : null,
        is_voided: false,
        is_refund: false,
        original_transaction_number: null,
        pos_receipt_settings: previewSettings,
      };
      // Wave 6b cutover — route through the shared row producer so the
      // test-print bytes match the on-screen preview and the thermal PDF
      // exactly. `renderDocumentEscPos` is the ESC/POS twin of
      // `renderThermalPdf`; both consume `buildReceiptLines(...)`.
      const { renderDocumentEscPosWithResult } = await import(
        "../_shared/escpos/renderDocumentEscPos.ts"
      );
      const { resolvePaperWidth: _resolvePreviewWidth } = await import(
        "../_shared/receipt/resolvePaperWidth.ts"
      );
      const { RENDERER_ID: _previewRendererId, sha256Hex: _previewSha } =
        await import("../_shared/escpos/rendererVersion.ts");
      // Phase A.2 — test print MUST resolve through the same physical
      // printer-profile path as a real receipt, otherwise the operator
      // tests against the engine defaults instead of their actual printer.
      const previewProfileId =
        (body.deviceAssignmentId as string | undefined) ?? undefined;
      let previewProfile:
        | {
            columns_override: number | null;
            margin_cols: number | null;
            font: "A" | "B" | null;
            cutter: "none" | "partial" | "full" | null;
            qr_native: boolean | null;
            code128_native: boolean | null;
            paper_format: "40mm" | "58mm" | "80mm" | null;
            is_calibrated: boolean | null;
          }
        | null = null;
      if (previewProfileId) {
        try {
          // Phase 6: `device_assignments` is the sole registry. Callers pass
          // the assignment id directly — the legacy profile mirror is gone.
          const { data: pp } = await supabase
            .from("device_assignments")
            .select(
              "columns_override, margin_cols, font, cutter, qr_native, code128_native, paper_format, is_calibrated",
            )
            .eq("id", previewProfileId)
            .maybeSingle();
          if (pp) previewProfile = pp as typeof previewProfile;
        } catch (_err) {
          // best-effort
        }
      }
      // Bug 2 fix — resolve the paper width AFTER the profile is loaded.
      // Physical printer paper wins over receipt-editor intent (Star /
      // Epson / Odoo pattern). See `resolvePaperWidth.ts`.
      {
        const resolved = _resolvePreviewWidth({
          requestOverride: body.paperFormat as string | undefined,
          profile: previewProfile ? { paper_size: previewProfile.paper_format } : null,
          receiptSettings: { paper_size: previewSettings.paper_size as string | undefined },
        });
        previewWidth = resolved.width;
        previewWidthSource = resolved.source;
      }
      const previewCaps: Record<string, unknown> = {};
      if (previewProfile?.is_calibrated && previewProfile.columns_override != null)
        previewCaps.columns_override = previewProfile.columns_override;
      if (previewProfile?.qr_native != null)
        previewCaps.qr_native = previewProfile.qr_native;
      if (previewProfile?.code128_native != null)
        previewCaps.code128_native = previewProfile.code128_native;
      if (previewProfile?.cutter != null) {
        previewCaps.auto_cut = previewProfile.cutter !== "none";
        previewCaps.partial_cut = previewProfile.cutter === "partial";
      }
      const rsForPreview: Record<string, unknown> = { ...previewSettings };
      if (
        previewProfile?.margin_cols != null &&
        rsForPreview.margin_cols == null
      ) {
        rsForPreview.margin_cols = previewProfile.margin_cols;
      }
      const { bytes: previewBytes, rows: previewRows } = renderDocumentEscPosWithResult(previewDoc, {
        width: previewWidth,
        receiptSettings: rsForPreview,
        capabilities:
          Object.keys(previewCaps).length > 0
            ? (previewCaps as any)
            : undefined,
        font: previewProfile?.font ?? undefined,
      });
      const _previewByteHash = await _previewSha(previewBytes as Uint8Array);
      console.log(
        JSON.stringify({
          tag: "receipt-render",
          documentType: "pos_receipt_preview",
          documentId: "test-print",
          format: "escpos",
          renderer: _previewRendererId,
          paper: previewWidth,
          paperSource: previewWidthSource,
          bytes: (previewBytes as Uint8Array).length,
          sha256: _previewByteHash,
          profileId: previewProfileId ?? null,
        }),
      );
      return new Response(previewBytes as unknown as BodyInit, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": buildContentDisposition(
            "pos_receipt_preview",
            "test-print",
            "bin",
          ),
          "X-Print-Policy-Source": "test-print",
          "X-Print-Policy-Paper": previewWidth,
          "X-Print-Policy-Paper-Source": previewWidthSource,
          "X-Print-Policy-Columns": String(previewRows.columns),
          "X-Print-Policy-Font": previewRows.font,
          ...(previewProfileId
            ? { "X-Print-Policy-Profile-Id": previewProfileId }
            : {}),
          "X-Print-Policy-Render-Mode": "escpos",
          "X-Print-Policy-Coerced": "0",
          "X-Renderer": _previewRendererId,
          "X-Renderer-Byte-Sha256": _previewByteHash,
          "Access-Control-Expose-Headers":
            "X-Print-Policy-Source, X-Print-Policy-Paper, X-Print-Policy-Paper-Source, X-Print-Policy-Render-Mode, X-Print-Policy-Coerced, X-Print-Policy-Columns, X-Print-Policy-Font, X-Print-Policy-Profile-Id, X-Renderer, X-Renderer-Byte-Sha256",
        },
      });
    }

    if (!documentType || !documentId) {
      return new Response(
        JSON.stringify({ error: "documentType and documentId are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── HR letters (Phase 6.1) ────────────────────────────────────────
    // HR letters are prose documents, not tabular sales documents. They
    // do NOT go through the sales template / payment_methods / escpos /
    // statement pipeline. They render via the dedicated HR generator,
    // and still land in `document_artifacts` for audit parity.
    if (isHrLetterType(documentType)) {
      const tenancy = await getHrLetterTenancy(supabase, documentType, documentId);
      if (!tenancy.organization_id) {
        return new Response(
          JSON.stringify({ error: "Document not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data: membership } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userData.user.id)
        .eq("organization_id", tenancy.organization_id)
        .eq("is_active", true)
        .maybeSingle();
      if (!membership) {
        return new Response(
          JSON.stringify({ error: "Forbidden" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const hrData = await fetchHrLetter(supabase, documentType, documentId);
      const hrBytes = await generateHrLetterPdf(hrData, { paperFormat: "a4" }, supabase);

      // Immutable artifact — same persistence pipeline as sales docs.
      const hrPolicyHeaders: Record<string, string> = {
        "Access-Control-Expose-Headers": "X-Document-Artifact-Id, X-Document-Artifact-Version",
      };
      try {
        const {
          shouldPersistArtifact,
          isBlockingType,
          persistArtifact,
        } = await import("../_shared/documents/persistArtifact.ts");
        if (shouldPersistArtifact(documentType, { persistOptIn: body.persist !== false })) {
          const p = persistArtifact({
            supabase,
            bytes: hrBytes,
            organizationId: tenancy.organization_id,
            businessId: tenancy.business_id,
            branchId: null,
            documentType,
            documentId,
            documentNumber: hrData.document_number ?? null,
            intent: typeof body.intent === "string" ? body.intent : null,
            templateId: null,
            templateVersion: null,
            policyId: null,
            mimeType: "application/pdf",
            renderMode: "pdf",
            paperFormat: "a4",
            copies: 1,
            renderedBy: userData.user.id,
            renderedVia: "generate-document",
            metadata: { hr_letter: true },
          });
          if (isBlockingType(documentType)) {
            const persisted = await p;
            if (persisted) {
              hrPolicyHeaders["X-Document-Artifact-Id"] = persisted.id;
              hrPolicyHeaders["X-Document-Artifact-Version"] = String(persisted.version);
            }
          }
        }
      } catch (err) {
        console.error("[artifact] HR letter persistence hook failed (non-fatal):", (err as Error).message);
      }

      return new Response(hrBytes as unknown as BodyInit, {
        headers: {
          ...corsHeaders,
          ...hrPolicyHeaders,
          "Content-Type": "application/pdf",
          "Content-Disposition": buildContentDisposition(documentType, hrData.document_number, "pdf"),
        },
      });
    }

    const fetcher = FETCHER_MAP[documentType];
    if (!fetcher) {
      return new Response(
        JSON.stringify({ error: `Unsupported document type: ${documentType}. Supported: ${Object.keys(FETCHER_MAP).join(', ')}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch document data — special-case pos_receipt to forward Phase 3
    // force_refresh_settings flag.
    const documentData = documentType === "pos_receipt"
      ? await fetchPOSReceipt(supabase, documentId, { forceRefreshSettings })
      : documentType === "legal_recipient_statement"
      ? await fetchLegalRecipientStatement(supabase, documentId, {
          periodStart: typeof body.periodStart === "string" ? body.periodStart : undefined,
          periodEnd: typeof body.periodEnd === "string" ? body.periodEnd : undefined,
          businessId: typeof body.businessId === "string" ? body.businessId : null,
        })
      : await fetcher(supabase, documentId);

    // Fetch template
    const templateType = TEMPLATE_TYPE_MAP[documentType as DocumentType] || documentType;
    const orgId = await getOrganizationId(supabase, documentType, documentId);

    // ─── Tenant isolation: caller must be an active member of orgId ───
    if (!orgId) {
      return new Response(
        JSON.stringify({ error: "Document not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    {
      const { data: membership } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userData.user.id)
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .maybeSingle();
      if (!membership) {
        return new Response(
          JSON.stringify({ error: "Forbidden" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }



    // ─── Subscription entitlement check (now that we have orgId) ───
    const subResult = await checkSubActive(supabase, orgId);
    if (!subResult.allowed) {
      return entDenied(subResult, corsHeaders);
    }


    // ── Phase 3 (convergence, 2026-08-06): canonical-artifact short-circuit ──
    //
    // `generate-document` predates the document model. Its `fetchX`
    // projections read LIVE rows, so a reprint issued after an edit could
    // disagree with the copy that was printed, archived and emailed.
    //
    // For every document kind that has been onboarded onto the document
    // model (i.e. an un-superseded `document_records` row exists for the
    // source pair), the canonical bytes now win: an archived artifact if
    // one exists, otherwise a fresh render of the FROZEN snapshot through
    // `render-document`. Kinds with no record fall through to the legacy
    // fetcher below, unchanged — that is the retirement ramp: as snapshot
    // builders land, the legacy projections stop being reachable.
    //
    // Deliberately NOT short-circuited:
    //   • non-PDF formats (escpos / zpl / csv) — routed by their own branches
    //   • thermal-width PDF previews — a disposition-specific rendition
    //   • `force_refresh_settings` reprints — an explicit "re-read live" ask
    const wantsCanonicalPdf =
      (!format || format === "pdf") &&
      !previewAtThermalWidth &&
      renderMode !== "thermal" &&
      !forceRefreshSettings;

    if (wantsCanonicalPdf) {
      try {
        const { resolveCanonicalPdf } = await import(
          "../_shared/documents/canonicalPdf.ts"
        );
        const canonical = await resolveCanonicalPdf({
          supabase,
          documentType,
          documentId,
          paperFormat: typeof paperFormat === "string" ? paperFormat : null,
          authorization: authHeader,
        });
        if (canonical) {
          console.log(
            `[canonical] ${documentType}/${documentId} served via ${canonical.source}` +
              ` (record ${canonical.documentRecordId})`,
          );
          return new Response(canonical.bytes as unknown as BodyInit, {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/pdf",
              "Content-Disposition": buildContentDisposition(
                documentType,
                (documentData as any)?.document_number ?? documentId,
                "pdf",
              ),
              "X-Document-Canonical-Source": canonical.source,
              "X-Document-Record-Id": canonical.documentRecordId ?? "",
              ...(canonical.artifactId
                ? { "X-Document-Artifact-Id": canonical.artifactId }
                : {}),
              "Access-Control-Expose-Headers":
                "X-Document-Canonical-Source, X-Document-Record-Id, X-Document-Artifact-Id",
            },
          });
        }
      } catch (err) {
        // Never fail a print because the canonical path is unavailable —
        // the legacy renderer below is still a correct (if live-read)
        // representation of the same document.
        console.error(
          `[canonical] falling back to legacy projection for ${documentType}/${documentId}:`,
          (err as Error).message,
        );
      }
    }

    // ── Milestone C.1: tabular export (CSV) short-circuit ──────────────
    // Statement CSVs consume the same `documentData` produced by the
    // fetchers above so the row-by-row content matches the PDF byte-for-
    // byte at fetch time. Persisted via the standard immutable-artifact
    // pipeline with `render_mode: "export"` so version history lists
    // both the PDF and CSV renders of the same statement.
    if (format === "csv") {
      const { buildStatementCsv } = await import("../_shared/exports/statementCsv.ts");
      const csvBytes = buildStatementCsv(documentData);
      const csvMime = "text/csv; charset=utf-8";
      const csvHeaders: Record<string, string> = {
        "X-Print-Policy-Render-Mode": "export",
        "Access-Control-Expose-Headers":
          "X-Print-Policy-Render-Mode, X-Document-Artifact-Id, X-Document-Artifact-Version",
      };
      try {
        const {
          shouldPersistArtifact,
          persistArtifact,
        } = await import("../_shared/documents/persistArtifact.ts");
        if (shouldPersistArtifact(documentType, { persistOptIn: body.persist !== false })) {
          const persisted = await persistArtifact({
            supabase,
            bytes: csvBytes,
            organizationId: orgId,
            businessId: await getBusinessId(supabase, documentType, documentId),
            branchId: (documentData as any)?.branch_id ?? null,
            documentType,
            documentId,
            documentNumber: (documentData as any)?.document_number ?? null,
            intent: typeof body.intent === "string" ? body.intent : "export",
            templateId: null,
            templateVersion: null,
            policyId: null,
            mimeType: csvMime,
            renderMode: "export",
            paperFormat: "n/a",
            copies: 1,
            renderedBy: userData.user.id,
            renderedVia: "generate-document",
            metadata: { export_format: "csv" },
          });
          if (persisted) {
            csvHeaders["X-Document-Artifact-Id"] = persisted.id;
            csvHeaders["X-Document-Artifact-Version"] = String(persisted.version);
          }
        }
      } catch (err) {
        console.error("[artifact] csv persistence hook failed (non-fatal):", (err as Error).message);
      }
      return new Response(csvBytes as unknown as BodyInit, {
        headers: {
          ...corsHeaders,
          ...csvHeaders,
          "Content-Type": csvMime,
          "Content-Disposition": buildContentDisposition(
            documentType,
            (documentData as any)?.document_number ?? documentId,
            "csv",
          ),
        },
      });
    }

    // ── Wave 11 (P0 R6): ZPL label rendering — gated branch ─────────────
    // Was previously at the top of the handler (pre-auth). Now sits AFTER
    // org-membership + entitlement so cross-org `format=zpl` calls 403.
    if (format === "zpl") {
      const { buildLabelZpl } = await import("../_shared/printing/zpl/builder.ts");
      try {
        const bytes = await buildLabelZpl(supabase, documentType, documentId);
        return new Response(bytes as unknown as BodyInit, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${documentType}-${documentId}.zpl"`,
            "X-Print-Format": "zpl",
          },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: `ZPL render failed: ${(err as Error).message}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ─── Wave 10 (audit P3 #16): kitchen_ticket short-circuit ──────────

    // Kitchen tickets never carry totals, payments, taxes, fiscal blocks,
    // branding, or per-document templates. They route to the dedicated
    // ESC/POS builder and bypass the receipt/PDF pipeline entirely so a
    // template/policy mis-config can never bleed pricing onto a cook's
    // station. Always emits ESC/POS bytes regardless of caller `format`.
    if (documentType === "kitchen_ticket") {
      const { buildKitchenTicketEscPos } = await import(
        "../_shared/escpos/kitchen.ts"
      );
      const items = ((documentData as any).items ?? []).map((it: any) => {
        const rawMods = it?.modifiers;
        const modifiers = Array.isArray(rawMods)
          ? rawMods
            .map((m: any) =>
              typeof m === "string"
                ? m
                : (m?.label ?? m?.name ?? m?.value ?? null)
            )
            .filter((m: unknown): m is string => typeof m === "string" && m.trim().length > 0)
          : [];
        return {
          description: String(it?.description ?? it?.product_name ?? "Item"),
          quantity: Number(it?.quantity ?? 1),
          modifiers,
          notes: typeof it?.notes === "string" ? it.notes : null,
        };
      });
      // Caller may pin a station/course/table via the request body so a
      // single transaction can fan out to multiple stations without the
      // server having to model station-routing rules yet.
      const station = typeof body.station === "string" ? body.station : null;
      const course = typeof body.course === "string" ? body.course : null;
      const table = typeof body.table === "string" ? body.table : null;
      const widthHint: "40mm" | "58mm" | "80mm" =
        body.paperFormat === "40mm" || body.paperFormat === "58mm"
          ? body.paperFormat
          : "80mm";
      const bytes = buildKitchenTicketEscPos(
        {
          order_number: String((documentData as any).document_number ?? documentId),
          placed_at: (documentData as any).issue_date ?? new Date().toISOString(),
          station,
          course,
          table,
          customer_name: (documentData as any).contact?.name ?? null,
          register_name: (documentData as any).register_name ?? null,
          cashier_name: (documentData as any).cashier_name ?? null,
          items,
        },
        { width: widthHint },
      );
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": buildContentDisposition(
            documentType,
            (documentData as any).document_number ?? documentId,
            "bin",
          ),
          "X-Print-Policy-Render-Mode": "escpos",
          "X-Print-Policy-Paper": widthHint,
          "Access-Control-Expose-Headers":
            "X-Print-Policy-Render-Mode, X-Print-Policy-Paper",
        },
      });
    }

    // ─── Phase B1: drawer_slip short-circuit ───────────────────────────
    //
    // Drawer slips are compliance evidence, not commercial documents.
    // They bypass templates, branding, fiscal blocks, and payment
    // methods entirely and always emit ESC/POS bytes at the caller's
    // paper width. Never call `fetchTemplate` for this type — there is
    // no template to look up.
    if (documentType === "drawer_slip") {
      const { buildDrawerSlipEscPos } = await import("../_shared/escpos/drawer.ts");
      const slip = (documentData as any).drawer_slip ?? {};
      const widthHint: "40mm" | "58mm" | "80mm" =
        body.paperFormat === "40mm" || body.paperFormat === "58mm" ? body.paperFormat : "80mm";
      const labelMap: Record<string, string> = {
        opening_float: "OPENING FLOAT",
        cash_in: "CASH IN",
        cash_out: "CASH OUT",
        float: "OPENING FLOAT",
        pickup: "PICKUP",
        drop: "SAFE DROP",
        safe_drop: "SAFE DROP",
        bank_deposit: "BANK DEPOSIT",
        petty_cash_out: "PETTY CASH",
        correction: "CORRECTION",
      };
      const bytes = buildDrawerSlipEscPos({
        movement_label: labelMap[String(slip.movement_type ?? "")] ?? "DRAWER OPEN",
        amount: slip.amount ?? null,
        currency: slip.currency ?? null,
        performed_at: slip.performed_at ?? new Date().toISOString(),
        reason: slip.reason ?? null,
        reason_code: slip.reason_code ?? null,
        notes: slip.notes ?? null,
        business_name: slip.business_name ?? null,
        register_name: slip.register_name ?? null,
        cashier_name: slip.cashier_name ?? null,
        shift_number: slip.shift_number ?? null,
        manager_override_id: slip.manager_override_id ?? null,
        movement_id: slip.movement_id ?? null,
      }, { width: widthHint });
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": buildContentDisposition("drawer_slip", slip.movement_id ?? documentId, "bin"),
          "X-Print-Policy-Render-Mode": "escpos",
          "X-Print-Policy-Paper": widthHint,
          "Access-Control-Expose-Headers": "X-Print-Policy-Render-Mode, X-Print-Policy-Paper",
        },
      });
    }





    const bizId = await getBusinessId(supabase, documentType, documentId);
    const fetchedTemplate = await fetchTemplate(supabase, orgId, templateType, bizId);
    // WLM Phase I — labour paperwork forces its operational shape on top of
    // whatever the tenant configured, so no finance block can leak onto it.
    const template = LABOUR_TEMPLATE_OVERRIDES[documentType]
      ? ({ ...fetchedTemplate, ...LABOUR_TEMPLATE_OVERRIDES[documentType] } as typeof fetchedTemplate)
      : fetchedTemplate;


    // Fetch structured payment methods — template-level flag is the single source of truth
    const showPaymentMethods = (template as any).show_payment_methods !== false; // default true
    if (showPaymentMethods) {
      try {
        const paymentMethodIds = (template as any).payment_method_ids;
        let query = supabase
          .from("organization_payment_methods")
          .select("id, type, label, details, is_default, display_order, qr_code_enabled")
          .eq("organization_id", orgId)
          .eq("is_active", true)
          .order("display_order", { ascending: true });

        // Strict company isolation: payment methods MUST belong to the same
        // business as the document being rendered. Without this filter, a
        // 2-company workspace would leak Company B's banks onto Company A's
        // invoices.
        if (bizId) {
          query = query.eq("business_id", bizId);
        }

        // Template-level filter: if specific methods selected, only show those
        if (paymentMethodIds && Array.isArray(paymentMethodIds) && paymentMethodIds.length > 0) {
          query = query.in("id", paymentMethodIds);
        } else {
          // No specific methods selected — fall back to default methods
          query = query.eq("is_default", true);
        }

        const { data: methods } = await query;
        if (methods && methods.length > 0) {
          documentData.payment_methods = methods as PaymentMethodData[];
          console.log(`Attached ${methods.length} payment methods to document`);
        }
      } catch (err) {
        console.error("Payment methods fetch error (continuing without them):", err);
      }
    }
    // Choose renderer: dedicated statement renderer or generic
    const isStatement = documentType === 'customer_statement' || documentType === 'vendor_statement' || documentType === 'legal_recipient_statement';

    // Stage P4 (ADR-0008): resolve effective print policy. Caller overrides
    // win; otherwise consult document_print_policies; otherwise A4/PDF.
    const { resolvePrintPolicy, coercePaperRenderMode } = await import(
      "../_shared/printing/resolvePolicy.ts"
    );
    const effectiveBranchId =
      branchIdOverride ??
      ((documentData as any)?.branch_id ?? null);
    const policy = await resolvePrintPolicy(supabase, {
      businessId: bizId,
      branchId: effectiveBranchId,
      documentType,
      override: {
        paperFormat,
        renderMode,
      },
    });

    // Stage P5 (ADR-0008): effective output format. Request `format` wins;
    // otherwise honour policy.render_mode. ESC/POS only emits when format
    // explicitly resolves to "escpos" (PDF remains the safe default).
    const requestedFormat: "pdf" | "escpos" =
      format === "escpos" || (!format && policy.render_mode === "escpos") ? "escpos" : "pdf";

    // Coerce illegal (documentType, paper, render_mode) triples — e.g. an
    // A4 invoice template asked for on 80 mm paper, or a `pos_receipt`
    // requested as PDF on a thermal width. The coercion function is the
    // single source of truth so the architecture guard (Fix 5) can replay
    // the exact same rules in CI.
    // Pass through the caller's explicit `format` so explicit PDF requests
    // (Save PDF / Email PDF) are never silently coerced into ESC/POS bytes.
    const explicitFormat: "pdf" | "escpos" | undefined =
      format === "pdf" || format === "escpos" ? format : undefined;
    const coerced = coercePaperRenderMode(
      documentType,
      policy.paper_format,
      requestedFormat,
      explicitFormat,
    );
    let effectiveFormat: "pdf" | "escpos" = coerced.render_mode;
    // Phase 4 (ADR-0008): paper-format and render-mode are orthogonal. The
    // coercer now returns the resolved thermal paper directly when an
    // explicit PDF is requested — no POS-only escape hatch needed. The PDF
    // builder handles 40/58/80mm via density: "narrow" for every document
    // type routed through this function.
    let effectivePaperOverride: typeof coerced.paper_format | null = null;
    void previewAtThermalWidth; // deprecated flag — kept for wire compatibility.

    // V1 (ADR-0008): expose the resolved policy back to the UI so operators
    // can see whether a request was driven by an override / branch / business
    // policy / system default — without leaking the policy table contents.
    // Fix 1: also surface coercion outcome so the UI can explain *why* the
    // requested combination was overridden (e.g. "PDF preview unavailable on
    // thermal paper — switch to A4 or download .bin").
    // HTTP header values must be ByteStrings (latin-1). Any non-ASCII char
    // (em-dash, smart quotes, unicode in policy reasons) throws
    // "Value is not a valid ByteString" when constructing the Response.
    const toHeaderAscii = (v: unknown): string =>
      String(v ?? "").replace(/[^\x20-\x7E]/g, "_");
    const policyHeaders: Record<string, string> = {
      "X-Print-Policy-Source": toHeaderAscii(policy.source),
      "X-Print-Policy-Paper": toHeaderAscii(coerced.paper_format),
      "X-Print-Policy-Render-Mode": toHeaderAscii(effectiveFormat),
      "X-Print-Policy-Coerced": coerced.coerced ? "1" : "0",
      "Access-Control-Expose-Headers":
        "X-Print-Policy-Source, X-Print-Policy-Paper, X-Print-Policy-Render-Mode, X-Print-Policy-Coerced, X-Print-Policy-Coerce-Reason, X-Receipt-Settings-Source",
    };
    if (coerced.reason) {
      policyHeaders["X-Print-Policy-Coerce-Reason"] = toHeaderAscii(coerced.reason);
    }
    // Phase 3 — surface whether the receipt settings used to build this
    // response came from the frozen snapshot, were refreshed from the
    // current editor, or were resolved live (no snapshot existed).
    const rsSource = (documentData as any).pos_receipt_settings_source;
    if (rsSource) {
      policyHeaders["X-Receipt-Settings-Source"] = toHeaderAscii(rsSource);
    }

    if (effectiveFormat === "escpos") {
      // Wave 6b cutover — the ESC/POS wire path now shares the row
      // producer with the thermal PDF path (see renderDocumentEscPos.ts).
      // This closes the "PDF looks clean, raw ESC/POS is misaligned"
      // discrepancy the operator saw with the Espresso emulator.
      const { renderDocumentEscPosWithResult } = await import(
        "../_shared/escpos/renderDocumentEscPos.ts"
      );
      const { resolvePaperWidth } = await import(
        "../_shared/receipt/resolvePaperWidth.ts"
      );
      const {
        RENDERER_ID: _rendererId,
        LAYOUT_CONTRACT_VERSION: _layoutContractVersion,
        sha256Hex: _sha,
      } = await import(
        "../_shared/escpos/rendererVersion.ts"
      );
      // POS receipts: title comes from resolveReceiptTitle() (already on
      // documentData.document_type_label) — never let an A4 invoice
      // template's "INVOICE" title override a fully-paid cash sale.
      //
      // Non-POS docs (proforma, estimate, delivery note, credit note, PO,
      // bill, sales order, statement, return, …): the template's
      // `document_title_format` defaults to the literal string "INVOICE"
      // for every tenant that never customised it, which would stamp
      // "INVOICE" on top of a proforma / DN / credit note on the ESC/POS
      // wire path while the PDF path (pdfGenerator.ts) already ignores
      // that default. Mirror the PDF rule: only honour the template
      // title when it has been customised away from the default. Fall
      // back to the fetcher-provided `document_type_label`, then let
      // `documentToInput.ts::TITLE_BY_TYPE` resolve the correct label.
      const isPosReceipt = documentType === "pos_receipt";
      const templateTitleRaw =
        typeof (template as any)?.document_title_format === "string"
          ? ((template as any).document_title_format as string).trim()
          : "";
      const customTemplateTitle =
        templateTitleRaw && templateTitleRaw.toUpperCase() !== "INVOICE"
          ? templateTitleRaw
          : undefined;
      const titleOverride = isPosReceipt
        ? (documentData as any).document_type_label
        : (customTemplateTitle ?? (documentData as any).document_type_label ?? undefined);
      // Phase A.2 — load the resolved printer_profiles row (if any) so the
      // builder uses real per-printer columns/margins/font instead of the
      // engine's defaults. This is what stops 80mm receipts from overflowing
      // on printers whose true Font A column count is 42 (not 48), 58mm
      // handhelds whose count is 30 (not 32), or 40mm label printers whose
      // count is 24 by default but may be 16/32 depending on hardware.
      let physicalProfile:
        | {
            columns_override: number | null;
            margin_cols: number | null;
            font: "A" | "B" | null;
            cutter: "none" | "partial" | "full" | null;
            qr_native: boolean | null;
            code128_native: boolean | null;
            paper_format: "40mm" | "58mm" | "80mm" | null;
            is_calibrated: boolean | null;
          }
        | null = null;
      // Phase 6 — canonical device resolution. Preference order:
      //   1. policy.device_assignment_id  → direct pin (canonical column).
      //   2. policy.intent                 → role-only routing via `resolve_device`
      //      (server-authoritative tie-break, identical to the client UI).
      // Emits one `hardware.route.decision` per resolved policy so the DoD
      // grep across sales / purchases / POS / inventory / WMS shows the
      // single canonical resolver on every printable intent.
      let resolvedAssignmentId: string | null = null;
      let routeDecisionSource: "device_pin" | "intent_role" | "none" = "none";
      if (policy.device_assignment_id) {
        resolvedAssignmentId = policy.device_assignment_id;
        routeDecisionSource = "device_pin";
      } else if (policy.intent) {
        try {
          const { roleForIntent } = await import("../_shared/printing/intentToRole.ts");
          const role = roleForIntent(policy.intent);
          if (role) {
            const { data: resolvedRows, error: resolveErr } = await supabase.rpc(
              "resolve_device",
              {
                _organization_id: orgId,
                _role: role,
                _business_id: bizId,
                _scope_kind: null,
                _scope_id: null,
              },
            );
            if (!resolveErr) {
              const first = Array.isArray(resolvedRows) ? resolvedRows[0] : resolvedRows;
              if (first && typeof (first as { id?: unknown }).id === "string") {
                resolvedAssignmentId = (first as { id: string }).id;
                routeDecisionSource = "intent_role";
              }
            }
          }
        } catch (_err) {
          // Best-effort — role-based resolution failures fall through to defaults.
        }
      }
      if (resolvedAssignmentId) {
        try {
          const { data: profileRow } = await supabase
            .from("device_assignments")
            .select(
              "columns_override, margin_cols, font, cutter, qr_native, code128_native, paper_format, is_calibrated",
            )
            .eq("id", resolvedAssignmentId)
            .maybeSingle();
          if (profileRow) physicalProfile = profileRow as typeof physicalProfile;
        } catch (_err) {
          // Profile load is best-effort. The builder defaults are safe.
        }
      }
      console.info("[hardware.route.decision]", {
        surface: "generate-document",
        documentType,
        organizationId: orgId,
        businessId: bizId,
        source: routeDecisionSource,
        assignmentId: resolvedAssignmentId,
        intent: policy.intent ?? null,
      });


      // pos_registers.printer_profile JSON (set by the register editor)
      // overrides the policy profile for that register only — operators
      // can pin a specific physical printer to a register without
      // affecting the branch/business policy.
      const registerProfile =
        (documentData as any).pos_register_printer_profile ?? null;

      // Bug 2 fix — resolve paper width AFTER the printer profile is
      // loaded, with the physical device winning over the receipt
      // editor's intent. See `_shared/receipt/resolvePaperWidth.ts` and
      // the Star/Epson/Odoo precedence rationale.
      const rsForWidth = (documentData as any).pos_receipt_settings ?? null;
      const resolvedPaper = resolvePaperWidth({
        requestOverride: typeof body.paperFormat === "string" ? body.paperFormat : undefined,
        profile: {
          paper_size:
            registerProfile?.paper_size ?? physicalProfile?.paper_format ?? null,
        },
        receiptSettings: { paper_size: rsForWidth?.paper_size ?? undefined },
        policyDefault: coerced.paper_format,
      });
      const width: "40mm" | "58mm" | "80mm" = resolvedPaper.width;

      // Audit fix (Phase 2): paper-scope the physical column/margin overrides.
      // A printer profile records corrections for a SPECIFIC paper size
      // (e.g. an 80mm printer whose true Font A column count is 42, not 48).
      // If the operator switches the receipt to 58mm but the profile was
      // tuned for 80mm, applying columns_override=42 on 58mm paper overflows.
      // Drop the override (and margin_cols) when the profile's intended
      // paper differs from the resolved width — the engine's PrinterProfile
      // defaults are safe per-paper.
      const profilePaperRaw =
        registerProfile?.paper_size ??
        physicalProfile?.paper_format ??
        null;
      const profilePaper: "40mm" | "58mm" | "80mm" | null =
        profilePaperRaw === "40mm" || profilePaperRaw === "58mm" || profilePaperRaw === "80mm"
          ? profilePaperRaw
          : null;
      const profilePaperMatches = profilePaper === null || profilePaper === width;

      const mergedProfile = {
        is_calibrated:
          registerProfile?.is_calibrated ?? physicalProfile?.is_calibrated ?? false,
        columns_override: profilePaperMatches &&
            (registerProfile?.is_calibrated ?? physicalProfile?.is_calibrated ?? false)
          ? (registerProfile?.columns_override ??
            physicalProfile?.columns_override ??
            null)
          : null,
        margin_cols: profilePaperMatches
          ? (registerProfile?.margin_cols ?? physicalProfile?.margin_cols ?? null)
          : null,
        font: (registerProfile?.font ?? physicalProfile?.font ?? null) as
          | "A"
          | "B"
          | null,
        cutter: registerProfile?.cutter ?? physicalProfile?.cutter ?? null,
        qr_native:
          registerProfile?.qr_native ?? physicalProfile?.qr_native ?? null,
        code128_native:
          registerProfile?.code128_native ??
          physicalProfile?.code128_native ??
          null,
      };

      // Merge profile capabilities with any caller-supplied capabilities.
      const callerCaps =
        ((documentData as any).pos_printer_capabilities ?? null) as
          | Record<string, unknown>
          | null;
      const capabilities = {
        ...(callerCaps ?? {}),
        ...(mergedProfile.columns_override !== null
          ? { columns_override: mergedProfile.columns_override }
          : {}),
        ...(mergedProfile.qr_native !== null
          ? { qr_native: mergedProfile.qr_native }
          : {}),
        ...(mergedProfile.code128_native !== null
          ? { code128_native: mergedProfile.code128_native }
          : {}),
        ...(mergedProfile.cutter !== null
          ? {
              auto_cut: mergedProfile.cutter !== "none",
              partial_cut: mergedProfile.cutter === "partial",
            }
          : {}),
      };

      // If the printer profile pins a margin and receipt settings did not
      // set one, surface it through receiptSettings.margin_cols so the
      // builder picks it up.
      const rsForBuild = {
        ...((documentData as any).pos_receipt_settings ?? {}),
      };
      if (
        mergedProfile.margin_cols !== null &&
        (rsForBuild as any).margin_cols == null
      ) {
        (rsForBuild as any).margin_cols = mergedProfile.margin_cols;
      }

      // Fold footerNote (from the document template) into receipt settings
      // when the settings row does not already provide one — the shared
      // engine renders footer text via `receipt_footer`.
      const rsWithFooter: Record<string, unknown> = { ...rsForBuild };
      const templateFooter = (template as any)?.footer_text;
      if (templateFooter && !rsWithFooter.receipt_footer) {
        rsWithFooter.receipt_footer = String(templateFooter);
      }
      const { bytes: escposBytes, rows: escposRows } = renderDocumentEscPosWithResult(documentData, {
        width,
        title: titleOverride,
        receiptSettings: rsWithFooter,
        capabilities: capabilities as any,
        font: mergedProfile.font ?? undefined,
      });
      const escposAscii = new TextDecoder("latin1").decode(escposBytes as Uint8Array);
      if (
        width === "58mm" &&
        mergedProfile.columns_override === null &&
        (escposRows.columns !== 32 || escposRows.font !== "A")
      ) {
        throw new Error(
          `ESC/POS 58mm safety invariant failed: uncalibrated output resolved to ${escposRows.columns} columns / Font ${escposRows.font}`,
        );
      }
      if (
        documentType === "pos_receipt" &&
        /\n\s*#\s*POS/i.test(escposAscii) &&
        !/\n\s*No:\s*POS/i.test(escposAscii)
      ) {
        throw new Error(
          "ESC/POS renderer invariant failed: legacy #POS receipt-number layout reached production path",
        );
      }
      if (documentType === "pos_receipt" && /\n\s*Status\s*:/i.test(escposAscii)) {
        throw new Error(
          "ESC/POS renderer invariant failed: legacy POS status row reached production path",
        );
      }
      // Phase A.5 — header transparency. Expose the resolved physical
      // context so the emulator/test-print decoder shows what the server
      // actually used (paper, columns, font, profile id).
      policyHeaders["X-Print-Policy-Paper"] = width;
      policyHeaders["X-Print-Policy-Columns"] = String(escposRows.columns);
      policyHeaders["X-Print-Policy-Font"] = escposRows.font;
      policyHeaders["X-Print-Policy-Margin-Columns"] = String(escposRows.marginCols);
      policyHeaders["X-Print-Policy-Profile-Override"] =
        mergedProfile.columns_override !== null ? "calibrated" : "safe-default";
      if (policy.device_assignment_id) {
        policyHeaders["X-Print-Policy-Profile-Id"] = String(
          policy.device_assignment_id,
        );
      }
      // Observability — expose the actual bytes' fingerprint + renderer
      // version and paper-source so operators can prove which code path
      // produced the ESC/POS stream in the emulator/on the wire.
      const _byteHash = await _sha(escposBytes as Uint8Array);
      policyHeaders["X-Renderer"] = _rendererId;
      policyHeaders["X-Renderer-Byte-Sha256"] = _byteHash;
      policyHeaders["X-Print-Policy-Paper-Source"] = resolvedPaper.source;
      console.log(
        JSON.stringify({
          tag: "receipt-render",
          documentType,
          documentId,
          format: "escpos",
          renderer: _rendererId,
          paper: width,
          paperSource: resolvedPaper.source,
          columns: escposRows.columns,
          marginColumns: escposRows.marginCols,
          font: escposRows.font,
          profileOverride: mergedProfile.columns_override !== null ? "calibrated" : "safe-default",
          profileId: policy.device_assignment_id ?? null,
          bytes: (escposBytes as Uint8Array).length,
          sha256: _byteHash,
        }),
      );
      policyHeaders["Access-Control-Expose-Headers"] =
        "X-Print-Policy-Source, X-Print-Policy-Paper, X-Print-Policy-Paper-Source, X-Print-Policy-Render-Mode, X-Print-Policy-Coerced, X-Print-Policy-Coerce-Reason, X-Print-Policy-Columns, X-Print-Policy-Font, X-Print-Policy-Margin-Columns, X-Print-Policy-Profile-Override, X-Print-Policy-Profile-Id, X-Receipt-Settings-Source, X-Renderer, X-Renderer-Byte-Sha256";

      // ADR-0084 Wave B3.2 — persist ESC/POS bytes for byte-identical
      // reprint + fiscal audit. Blocking for pos_receipt (auditors need
      // the guarantee); fire-and-forget for others via the allow-list.
      const escposPersistOptIn = body.persist !== false;
      try {
        const {
          shouldPersistArtifact,
          isBlockingType,
          persistArtifact,
        } = await import("../_shared/documents/persistArtifact.ts");
        if (shouldPersistArtifact(documentType, { persistOptIn: escposPersistOptIn })) {
          const persistPromise = persistArtifact({
            supabase,
            bytes: escposBytes as Uint8Array,
            organizationId: orgId,
            businessId: bizId,
            branchId: effectiveBranchId,
            documentType,
            documentId,
            documentNumber:
              (documentData as any)?.document_number ?? null,
            intent: typeof body.intent === "string" ? body.intent : null,
            templateId: (template as any)?.id ?? null,
            templateVersion: (template as any)?.version ?? null,
            policyId: (policy as any)?.policy_id ?? null,
            mimeType: "application/octet-stream",
            renderMode: "escpos",
            paperFormat: String(policyHeaders["X-Print-Policy-Paper"] ?? coerced.paper_format),
            copies: Number((policy as any)?.copies ?? 1),
            renderedBy: userData.user.id,
            renderedVia: "generate-document",
            metadata: {
              renderer_id: _rendererId,
              layout_contract_version: _layoutContractVersion,
              paper: escposRows.paper,
              columns: escposRows.columns,
              margin_columns: escposRows.marginCols,
              font: escposRows.font,
              profile_override:
                mergedProfile.columns_override !== null ? "calibrated" : "safe-default",
            },
          }).then((res) => {
            if (res) {
              console.log(
                `[artifact] ${documentType}/${documentId} escpos v${res.version}` +
                  (res.deduped ? " (deduped)" : " (new)"),
              );
            }
            return res;
          });
          if (isBlockingType(documentType)) {
            const persisted = await persistPromise;
            if (persisted) {
              policyHeaders["X-Document-Artifact-Id"] = persisted.id;
              policyHeaders["X-Document-Artifact-Version"] = String(persisted.version);
              policyHeaders["Access-Control-Expose-Headers"] +=
                ", X-Document-Artifact-Id, X-Document-Artifact-Version";
            }
          }
        }
      } catch (err) {
        console.error(
          "[artifact] escpos persistence hook failed (non-fatal):",
          (err as Error).message,
        );
      }

      return new Response(escposBytes as unknown as BodyInit, {
        headers: {
          ...corsHeaders,
          ...policyHeaders,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": buildContentDisposition(documentType, documentData.document_number, "bin"),
        },
      });
    }


    // Wave 13 — POS receipts are fundamentally thermal artifacts. Their
    // true width lives in `pos_receipt_settings.paper_size`, NOT in the
    // per-tenant `document_print_policies` row (which may be absent or
    // set to A4 for a business that never configured a policy). Promote
    // the receipt-editor width to `effectivePaper` before the routing
    // gate so `isThermalWidth` and response headers reflect reality and
    // the self-defending guard in `generateDocumentPdf` gets the truth.
    const _rsForRouting = (documentData as unknown as {
      pos_receipt_settings?: { paper_size?: string };
    }).pos_receipt_settings ?? {};
    const _rsPaper = String(_rsForRouting.paper_size ?? "").toLowerCase();
    const _rsPaperThermal =
      _rsPaper === "40mm" || _rsPaper === "58mm" || _rsPaper === "80mm"
        ? (_rsPaper as "40mm" | "58mm" | "80mm")
        : null;
    const effectivePaper =
      effectivePaperOverride
      ?? (documentType === "pos_receipt" && _rsPaperThermal
        ? _rsPaperThermal
        : coerced.paper_format);
    const renderOptions = { paperFormat: effectivePaper };

    // ── Thermal PDF path (ADR-0008 follow-up) ─────────────────────────
    // 40 / 58 / 80 mm PDF requests do NOT go through the A4 invoice
    // pipeline (`generateDocumentPdf`). They are rendered by the shared
    // receipt engine — the same `LineMeta[]` that drives the on-screen
    // monospace preview and the ESC/POS byte stream. This is what keeps
    // the printed PDF structurally identical to the operator's preview
    // instead of being a squeezed A4 with coordinate-drawn text.
    const isThermalWidth =
      effectivePaper === "40mm"
      || effectivePaper === "58mm"
      || effectivePaper === "80mm";
    const isReceiptLike =
      documentType === "pos_receipt" || documentType === "receipt";

    // Wave 6a (ADR-0085 follow-up) — POS receipts must NEVER fall through
    // to the A4 invoice pipeline. Even when the resolved policy paper
    // format is A4/Letter/A5 (org has no explicit thermal policy row) the
    // receipt is still fundamentally a thermal-column artifact: the
    // operator's preview, the ESC/POS bytes and the archived PDF all have
    // to be structurally identical. Resolve the render width from the
    // receipt editor (`pos_receipt_settings.paper_size`), fall back to
    // the policy width if it is already thermal, else default to 80mm.
    const rsFromDoc = (documentData as unknown as {
      pos_receipt_settings?: { paper_size?: string };
    }).pos_receipt_settings ?? {};
    const rsPaperSize = rsFromDoc.paper_size;
    const thermalWidthForReceipt: "40mm" | "58mm" | "80mm" =
      rsPaperSize === "40mm" || effectivePaper === "40mm" ? "40mm" :
      rsPaperSize === "58mm" || effectivePaper === "58mm" ? "58mm" :
      rsPaperSize === "80mm" || effectivePaper === "80mm" ? "80mm" :
      "80mm";
    // Wave 10 — paper-aware routing. ANY thermal-width document (invoice,
    // PO, quote, delivery note, sales order…) must flow through the
    // engine, not the A4 coordinate renderer. Statements stay on
    // `generateStatementPdf` (structurally A4-only). POS receipts always
    // route through the engine even when the org's policy paper is
    // A4/Letter, because a receipt is fundamentally a thermal artifact.
    const routeThroughThermalEngine =
      !isStatement && (isThermalWidth || documentType === "pos_receipt");
    console.log(
      `[thermal-route] docType=${documentType} effPaper=${effectivePaper} ` +
        `isReceiptLike=${isReceiptLike} isStatement=${isStatement} ` +
        `isThermalWidth=${isThermalWidth} route=${routeThroughThermalEngine} ` +
        `thermalWidth=${thermalWidthForReceipt}`,
    );

    let pdfBytes: Uint8Array;
    if (routeThroughThermalEngine) {
      const { buildReceiptLines } = await import(
        "../_shared/receipt/lines.ts"
      );
      const { documentToReceiptInput } = await import(
        "../_shared/receipt/documentToInput.ts"
      );
      const { renderThermalPdf } = await import(
        "../_shared/receipt/pdf/renderThermalPdf.ts"
      );
      // Pin the engine's paper width to the resolved thermal width so
      // the row producer, PDF and ESC/POS stream all share one grid.
      const rsForPdf = {
        ...((documentData as unknown as {
          pos_receipt_settings?: Record<string, unknown>;
        }).pos_receipt_settings ?? {}),
        paper_size: thermalWidthForReceipt,
      };
      const engineInput = documentToReceiptInput(documentData, {
        settings: rsForPdf,
        title:
          (documentData as unknown as { document_type_label?: string })
            .document_type_label,
      });
      const rows = buildReceiptLines(engineInput);
      pdfBytes = await renderThermalPdf(rows);
      policyHeaders["X-Print-Policy-Renderer"] = "thermal-engine";
      policyHeaders["X-Print-Policy-Effective-Paper"] = thermalWidthForReceipt;
      policyHeaders["X-Print-Policy-Columns"] = String(rows.columns);
      policyHeaders["Access-Control-Expose-Headers"] +=
        ", X-Print-Policy-Renderer, X-Print-Policy-Columns, X-Print-Policy-Effective-Paper";
    } else {
      pdfBytes = isStatement
        ? await generateStatementPdf(documentData, template, renderOptions)
        : await generateDocumentPdf(documentData, template, renderOptions);
    }

    // ADR-0084 Wave B3.2 — persist an immutable artifact row + storage
    // object so reprints are byte-identical and regenerations preserve
    // the supersedes_id chain. Idempotent by content-sha256. Callers
    // that only want a preview can pass `persist:false` in the request
    // body to opt out.
    const persistOptIn = body.persist !== false;
    try {
      const {
        shouldPersistArtifact,
        isBlockingType,
        persistArtifact,
      } = await import("../_shared/documents/persistArtifact.ts");
      if (shouldPersistArtifact(documentType, { persistOptIn })) {
        const persistPromise = persistArtifact({
          supabase,
          bytes: pdfBytes as Uint8Array,
          organizationId: orgId,
          businessId: bizId,
          branchId: effectiveBranchId,
          documentType,
          documentId,
          documentNumber:
            (documentData as any)?.document_number ?? null,
          intent: typeof body.intent === "string" ? body.intent : null,
          templateId: (template as any)?.id ?? null,
          templateVersion: (template as any)?.version ?? null,
          policyId: (policy as any)?.policy_id ?? null,
          mimeType: "application/pdf",
          renderMode: effectiveFormat,
          paperFormat: String(effectivePaper),
          copies: Number((policy as any)?.copies ?? 1),
          renderedBy: userData.user.id,
          renderedVia: "generate-document",
          metadata: {
            coerced: coerced.coerced === true,
            coerce_reason: coerced.reason ?? null,
          },
        }).then((res) => {
          if (res) {
            console.log(
              `[artifact] ${documentType}/${documentId} v${res.version}` +
                (res.deduped ? " (deduped)" : " (new)"),
            );
          }
          return res;
        });
        if (isBlockingType(documentType)) {
          const persisted = await persistPromise;
          if (persisted) {
            policyHeaders["X-Document-Artifact-Id"] = persisted.id;
            policyHeaders["X-Document-Artifact-Version"] = String(persisted.version);
            policyHeaders["Access-Control-Expose-Headers"] +=
              ", X-Document-Artifact-Id, X-Document-Artifact-Version";
          }
        }
      }
    } catch (err) {
      console.error(
        "[artifact] persistence hook failed (non-fatal):",
        (err as Error).message,
      );
    }

    return new Response(pdfBytes as unknown as BodyInit, {
      headers: {
        ...corsHeaders,
        ...policyHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": buildContentDisposition(documentType, documentData.document_number, "pdf"),
      },
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error generating document:", error);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ── Helpers to extract org/business IDs ────────────────────────────────────

const TABLE_MAP: Record<string, string> = {
  invoice: "invoices",
  estimate: "estimates",
  proforma: "proforma_invoices",
  credit_note: "credit_notes",
  purchase_order: "purchase_orders",
  receipt: "payments",
  pos_receipt: "pos_transactions",
  // Wave 10 (audit P3 #16): kitchen tickets are sourced from the same
  // pos_transactions row as the customer receipt. The renderer projects
  // it down to a `KitchenTicketData` shape; the source row's tenancy is
  // still what gates membership/entitlement checks.
  kitchen_ticket: "pos_transactions",
  sales_order: "sales_orders",
  delivery_note: "delivery_notes",
  sales_return: "sales_returns",
  customer_statement: "customer_statements",
  vendor_statement: "vendor_statements",
  // documentId for legal_recipient_statement is a legal_recipients.id;
  // period window rides in on the request body.
  legal_recipient_statement: "legal_recipients",
  bill: "bills",
  // Wave 21 — inventory / warehouse A4 vouchers.
  stock_adjustment: "stock_adjustments",
  stock_transfer: "stock_transfers",
  vendor_return: "purchase_returns",
  purchase_return: "purchase_returns",
  goods_received_note: "goods_receipts",
  goods_receipt: "goods_receipts",
  // ADR 0110 — every dispatch artifact hangs off one loading manifest.
  bill_of_lading: "wms_loading_manifests",
  dispatch_manifest: "wms_loading_manifests",
  packing_list: "wms_loading_manifests",
  carrier_label: "wms_loading_manifests",
  // WLM — the worksheet is keyed by operator, the roster by warehouse.
  labour_worksheet: "wms_operators",
  labour_roster: "warehouses",
  // ADR-0112 Phase 5 — both wave artifacts hang off one wave.
  wave_pick_list: "wms_pick_waves",
  wave_summary: "wms_pick_waves",
};

async function getOrganizationId(supabase: any, docType: string, docId: string): Promise<string> {
  const table = TABLE_MAP[docType];
  if (!table) throw new Error(`Unknown document type for org lookup: ${docType}`);
  const { data } = await supabase.from(table).select("organization_id").eq("id", docId).single();
  return data?.organization_id;
}

async function getBusinessId(supabase: any, docType: string, docId: string): Promise<string | null> {
  const table = TABLE_MAP[docType];
  if (!table) return null;
  // legal_recipients has no business_id column; the caller may pass one
  // via the request body, but the master row itself is org-scoped.
  if (docType === "legal_recipient_statement") return null;
  const { data } = await supabase.from(table).select("business_id").eq("id", docId).single();
  return data?.business_id || null;
}
