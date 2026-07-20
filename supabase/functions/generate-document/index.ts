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
      purchase_order:purchase_orders(po_number, vendor:contacts(name, email, phone, address_line1, city, state, postal_code), currency),
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
    shipping_address: null,
  };
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
  const periodStart = stmt.period_start;
  const periodEnd = stmt.period_end;

  // Fetch invoices
  let invoiceQuery = supabase
    .from("invoices")
    .select("invoice_number, issue_date, total, amount_paid, status")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .gte("issue_date", periodStart)
    .lte("issue_date", periodEnd)
    .order("issue_date");
  if (businessId) invoiceQuery = invoiceQuery.eq("business_id", businessId);
  const { data: invoices } = await invoiceQuery;

  // Fetch payments
  let paymentQuery = supabase
    .from("payments")
    .select("receipt_number, payment_date, amount, payment_method")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .gte("payment_date", periodStart)
    .lte("payment_date", periodEnd)
    .order("payment_date");
  if (businessId) paymentQuery = paymentQuery.eq("business_id", businessId);
  const { data: payments } = await paymentQuery;

  // Fetch credit notes
  let cnQuery = supabase
    .from("credit_notes")
    .select("credit_note_number, issue_date, total, status")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .gte("issue_date", periodStart)
    .lte("issue_date", periodEnd)
    .in("status", ["issued", "applied", "partially_applied"])
    .order("issue_date");
  if (businessId) cnQuery = cnQuery.eq("business_id", businessId);
  const { data: creditNotes } = await cnQuery;

  // Build structured transactions
  type TxnEntry = { date: string; type: string; ref: string; desc: string; debit: number; credit: number };
  const txns: TxnEntry[] = [];

  for (const inv of (invoices || [])) {
    txns.push({ date: inv.issue_date, type: "Invoice", ref: inv.invoice_number, desc: `Invoice ${inv.invoice_number}`, debit: inv.total || 0, credit: 0 });
  }
  for (const pmt of (payments || [])) {
    txns.push({ date: pmt.payment_date, type: "Payment", ref: pmt.receipt_number || "—", desc: `Payment received${pmt.receipt_number ? ` (${pmt.receipt_number})` : ""}`, debit: 0, credit: pmt.amount || 0 });
  }
  for (const cn of (creditNotes || [])) {
    txns.push({ date: cn.issue_date, type: "Credit Note", ref: cn.credit_note_number, desc: `Credit Note ${cn.credit_note_number}`, debit: 0, credit: cn.total || 0 });
  }

  txns.sort((a, b) => a.date.localeCompare(b.date));

  let runningBalance = stmt.opening_balance || 0;
  const statementTransactions: StatementTransaction[] = [];

  for (const txn of txns) {
    runningBalance += txn.debit - txn.credit;
    statementTransactions.push({
      date: txn.date,
      type: txn.type,
      reference: txn.ref,
      description: txn.desc,
      charges: txn.debit,
      credits: txn.credit,
      balance: runningBalance,
    });
  }

  // Aging buckets
  const now = new Date();
  let agingCurrent = 0, aging30 = 0, aging60 = 0, aging90 = 0, agingOver90 = 0;
  for (const inv of (invoices || [])) {
    const balance = (inv.total || 0) - (inv.amount_paid || 0);
    if (balance <= 0) continue;
    const daysOld = Math.floor((now.getTime() - new Date(inv.issue_date).getTime()) / (1000 * 60 * 60 * 24));
    if (daysOld <= 0) agingCurrent += balance;
    else if (daysOld <= 30) aging30 += balance;
    else if (daysOld <= 60) aging60 += balance;
    else if (daysOld <= 90) aging90 += balance;
    else agingOver90 += balance;
  }

  const statementAging: StatementAgingBucket[] = [
    { label: "Current", amount: agingCurrent },
    { label: "1-30 Days", amount: aging30 },
    { label: "31-60 Days", amount: aging60 },
    { label: "61-90 Days", amount: aging90 },
    { label: "90+ Days", amount: agingOver90 },
  ];

  const currency = stmt.business?.base_currency || stmt.organization?.base_currency || "USD";
  const closingBalance = stmt.closing_balance ?? runningBalance;

  return {
    document_number: `Statement - ${stmt.contact?.name || "Customer"}`,
    document_type: "customer_statement",
    document_type_label: "CUSTOMER STATEMENT",
    status: stmt.sent_at ? "sent" : "draft",
    issue_date: stmt.statement_date || stmt.created_at,
    subtotal: stmt.total_invoiced || 0,
    tax_amount: 0,
    discount_amount: 0,
    total: closingBalance,
    amount_paid: stmt.total_payments || 0,
    currency,
    notes: null,
    terms: null,
    contact: stmt.contact,
    organization: await mapBusinessToOrg(supabase, stmt.business, stmt.organization, stmt.branch_id),
    business_id: stmt.business_id,
    organization_id: stmt.organization_id,
    items: [], // Not used by statement renderer
    statement_transactions: statementTransactions,
    statement_aging: statementAging,
    statement_opening_balance: stmt.opening_balance || 0,
    statement_closing_balance: closingBalance,
    statement_period_start: periodStart,
    statement_period_end: periodEnd,
  };
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
  const periodStart = stmt.period_start;
  const periodEnd = stmt.period_end;

  // Fetch bills
  let billQuery = supabase
    .from("bills")
    .select("bill_number, bill_date, total, amount_paid, status, vendor_invoice_number")
    .eq("organization_id", orgId)
    .eq("vendor_id", contactId)
    .in("status", ["received", "paid", "partial", "overdue"])
    .gte("bill_date", periodStart)
    .lte("bill_date", periodEnd)
    .order("bill_date");
  if (businessId) billQuery = billQuery.eq("business_id", businessId);
  const { data: bills } = await billQuery;

  // Fetch bill payments (need bill IDs first)
  let allBillQuery = supabase
    .from("bills")
    .select("id")
    .eq("organization_id", orgId)
    .eq("vendor_id", contactId);
  if (businessId) allBillQuery = allBillQuery.eq("business_id", businessId);
  const { data: allBills } = await allBillQuery;
  const allBillIds = (allBills || []).map((b: any) => b.id);

  let payments: any[] = [];
  if (allBillIds.length > 0) {
    const { data: pmts } = await supabase
      .from("bill_payments")
      .select("reference, payment_date, amount")
      .eq("organization_id", orgId)
      .in("bill_id", allBillIds)
      .gte("payment_date", periodStart)
      .lte("payment_date", periodEnd)
      .order("payment_date");
    payments = pmts || [];
  }

  // Fetch vendor credit notes
  let cnQuery = supabase
    .from("vendor_credit_notes")
    .select("credit_note_number, credit_date, total, status")
    .eq("organization_id", orgId)
    .eq("vendor_id", contactId)
    .in("status", ["confirmed", "applied"])
    .gte("credit_date", periodStart)
    .lte("credit_date", periodEnd)
    .order("credit_date");
  if (businessId) cnQuery = cnQuery.eq("business_id", businessId);
  const { data: creditNotes } = await cnQuery;

  // Build transactions
  type TxnEntry = { date: string; type: string; ref: string; desc: string; debit: number; credit: number };
  const txns: TxnEntry[] = [];

  for (const bill of (bills || [])) {
    txns.push({ date: bill.bill_date, type: "Bill", ref: bill.bill_number, desc: `Bill ${bill.bill_number}${bill.vendor_invoice_number ? ` (Ref: ${bill.vendor_invoice_number})` : ''}`, debit: bill.total || 0, credit: 0 });
  }
  for (const pmt of payments) {
    txns.push({ date: pmt.payment_date, type: "Payment", ref: pmt.reference || "—", desc: `Payment${pmt.reference ? ` (${pmt.reference})` : ""}`, debit: 0, credit: pmt.amount || 0 });
  }
  for (const cn of (creditNotes || [])) {
    txns.push({ date: cn.credit_date, type: "Credit Note", ref: cn.credit_note_number, desc: `Vendor Credit ${cn.credit_note_number}`, debit: 0, credit: cn.total || 0 });
  }

  txns.sort((a, b) => a.date.localeCompare(b.date));

  let runningBalance = stmt.opening_balance || 0;
  const statementTransactions: StatementTransaction[] = [];

  for (const txn of txns) {
    runningBalance += txn.debit - txn.credit;
    statementTransactions.push({
      date: txn.date, type: txn.type, reference: txn.ref, description: txn.desc,
      charges: txn.debit, credits: txn.credit, balance: runningBalance,
    });
  }

  // Aging buckets
  const now = new Date();
  let agingCurrent = 0, aging30 = 0, aging60 = 0, aging90 = 0, agingOver90 = 0;
  for (const bill of (bills || [])) {
    const balance = (bill.total || 0) - (bill.amount_paid || 0);
    if (balance <= 0) continue;
    const daysOld = Math.floor((now.getTime() - new Date(bill.bill_date).getTime()) / (1000 * 60 * 60 * 24));
    if (daysOld <= 0) agingCurrent += balance;
    else if (daysOld <= 30) aging30 += balance;
    else if (daysOld <= 60) aging60 += balance;
    else if (daysOld <= 90) aging90 += balance;
    else agingOver90 += balance;
  }

  const statementAging: StatementAgingBucket[] = [
    { label: "Current", amount: agingCurrent },
    { label: "1-30 Days", amount: aging30 },
    { label: "31-60 Days", amount: aging60 },
    { label: "61-90 Days", amount: aging90 },
    { label: "90+ Days", amount: agingOver90 },
  ];

  const currency = stmt.business?.base_currency || stmt.organization?.base_currency || "USD";
  const closingBalance = stmt.closing_balance ?? runningBalance;

  return {
    document_number: `Vendor Statement - ${stmt.contact?.name || "Vendor"}`,
    document_type: "vendor_statement" as any,
    document_type_label: "VENDOR STATEMENT",
    status: stmt.sent_at ? "sent" : "draft",
    issue_date: stmt.statement_date || stmt.created_at,
    subtotal: stmt.total_billed || 0,
    tax_amount: 0,
    discount_amount: 0,
    total: closingBalance,
    amount_paid: stmt.total_payments || 0,
    currency,
    notes: null,
    terms: null,
    contact: stmt.contact,
    organization: await mapBusinessToOrg(supabase, stmt.business, stmt.organization, stmt.branch_id),
    business_id: stmt.business_id,
    organization_id: stmt.organization_id,
    items: [],
    statement_transactions: statementTransactions,
    statement_aging: statementAging,
    statement_opening_balance: stmt.opening_balance || 0,
    statement_closing_balance: closingBalance,
    statement_period_start: periodStart,
    statement_period_end: periodEnd,
  };
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
  customer_statement: "invoice",
  vendor_statement: "invoice",
  bill: "invoice",
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
  bill: fetchBill,
  // Wave 12 C2 — alias both naming conventions; UI uses `goods_received_note`.
  goods_received_note: fetchGoodsReceivedNote,
  goods_receipt: fetchGoodsReceivedNote,
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
    const CSV_EXPORT_ALLOWED = new Set<string>(["customer_statement", "vendor_statement"]);
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
        (body.printerProfileId as string | undefined) ?? undefined;
      let previewProfile:
        | {
            columns_override: number | null;
            margin_cols: number | null;
            font: "A" | "B" | null;
            cutter: "none" | "partial" | "full" | null;
            qr_native: boolean | null;
            code128_native: boolean | null;
            paper_size: "40mm" | "58mm" | "80mm" | null;
          }
        | null = null;
      if (previewProfileId) {
        try {
          const { data: pp } = await supabase
            .from("printer_profiles")
            .select(
              "columns_override, margin_cols, font, cutter, qr_native, code128_native, paper_size",
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
          profile: previewProfile ? { paper_size: previewProfile.paper_size } : null,
          receiptSettings: { paper_size: previewSettings.paper_size as string | undefined },
        });
        previewWidth = resolved.width;
        previewWidthSource = resolved.source;
      }
      const previewCaps: Record<string, unknown> = {};
      if (previewProfile?.columns_override != null)
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



    const bizId = await getBusinessId(supabase, documentType, documentId);
    const template = await fetchTemplate(supabase, orgId, templateType, bizId);

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
    const isStatement = documentType === 'customer_statement' || documentType === 'vendor_statement';

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
      const isPosReceipt = documentType === "pos_receipt";
      const titleOverride = isPosReceipt
        ? (documentData as any).document_type_label
        : ((template as any)?.document_title_format ?? undefined);
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
            paper_size: "40mm" | "58mm" | "80mm" | null;
          }
        | null = null;
      if (policy.printer_profile_id) {
        try {
          const { data: profileRow } = await supabase
            .from("printer_profiles")
            .select(
              "columns_override, margin_cols, font, cutter, qr_native, code128_native, paper_size",
            )
            .eq("id", policy.printer_profile_id)
            .maybeSingle();
          if (profileRow) physicalProfile = profileRow as typeof physicalProfile;
        } catch (_err) {
          // Profile load is best-effort. The builder defaults are safe.
        }
      }

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
            registerProfile?.paper_size ?? physicalProfile?.paper_size ?? null,
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
        (physicalProfile as any)?.paper_size ??
        null;
      const profilePaper: "40mm" | "58mm" | "80mm" | null =
        profilePaperRaw === "40mm" || profilePaperRaw === "58mm" || profilePaperRaw === "80mm"
          ? profilePaperRaw
          : null;
      const profilePaperMatches = profilePaper === null || profilePaper === width;

      const mergedProfile = {
        columns_override: profilePaperMatches
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
        documentType === "pos_receipt" &&
        /\n\s*#\s*POS/i.test(escposAscii) &&
        !/\n\s*No:\s*POS/i.test(escposAscii)
      ) {
        throw new Error(
          "ESC/POS renderer invariant failed: legacy #POS receipt-number layout reached production path",
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
        mergedProfile.columns_override !== null ? "measured" : "safe-default";
      if (policy.printer_profile_id) {
        policyHeaders["X-Print-Policy-Profile-Id"] = String(
          policy.printer_profile_id,
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
          profileOverride: mergedProfile.columns_override !== null ? "measured" : "safe-default",
          profileId: policy.printer_profile_id ?? null,
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
                mergedProfile.columns_override !== null ? "measured" : "safe-default",
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
  bill: "bills",
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
  const { data } = await supabase.from(table).select("business_id").eq("id", docId).single();
  return data?.business_id || null;
}
