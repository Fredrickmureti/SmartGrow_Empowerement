/**
 * Wave 7.2 — Sales invoice snapshot builder.
 *
 * Converts a sales invoice (header + items + contact + business) into
 * the JSON blob the shared rendering engine expects for
 * `document_kinds.code = 'sales.invoice'`.
 *
 * The output shape mirrors `DocumentData` (defined in
 * `supabase/functions/_shared/templateRenderer.ts`) so both the PDF
 * (A4 default) and thermal renderers consume the same canonical fields
 * — no per-medium template drift.
 *
 * Two entry points:
 *  - {@link buildSalesInvoiceSnapshot} — pure, unit-testable, requires
 *    fully-hydrated inputs.
 *  - {@link fetchAndBuildSalesInvoiceSnapshot} — Supabase-driven helper
 *    that mirrors the `fetchInvoice` fetcher in `generate-document`, so
 *    call sites (Invoices.tsx et al) migrate in two lines.
 *
 * This is Path A of ADR resolution for Wave 7.2 fork (1): each page
 * assembles its own snapshot rather than the RPC materializing
 * server-side. Chosen because it keeps `ensure_document_record` a pure
 * upsert and lets each module own its projection.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSnapshotItems } from "./lineItemUom";
import type { SnapshotBlob } from "./index";
import { resolveSnapshotAddress } from "./partyAddress";
import { fetchPaymentTermSnapshot, type SnapshotPaymentTerm } from "./paymentTerm";

// ---------- Input shapes (mirror what fetchInvoice selects) ----------

export interface SalesInvoiceItemRow {
  description: string | null;
  quantity: number;
  unit_price: number;
  tax_rate: number | null;
  tax_amount: number | null;
  discount_percent: number | null;
  line_total: number;
  sku?: string | null;
  packaging?: { name: string | null; qty_in_base_uom: number | null } | null;
  product?: {
    base_uom?: { code: string | null; name: string | null } | null;
  } | null;
  pack_quantity?: number | null;
  pack_size?: number | null;
  unit_of_measure?: string | null;
  /** Pack provenance forwarded to the renderers (see lineItemUom.ts). */
  display_quantity?: number | null;
  packaging_label?: string | null;
  base_uom_label?: string | null;
  uom_snapshot?: string | null;
}

interface SalesInvoiceItemSourceRow extends Omit<SalesInvoiceItemRow, "sku" | "packaging" | "product"> {
  product_id: string | null;
  packaging_id: string | null;
  display_uom_id: string | null;
  display_quantity: number | null;
  uom_snapshot: string | null;
}

export interface SalesInvoiceContactRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export interface SalesInvoiceBusinessRow {
  id: string;
  name: string | null;
  legal_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  logo_url?: string | null;
  base_currency?: string | null;
}

export interface SalesInvoiceHeaderRow {
  id: string;
  invoice_number: string;
  status: string;
  issue_date: string;
  due_date: string | null;
  subtotal: number;
  tax_amount: number;
  discount_amount: number | null;
  total: number;
  amount_paid: number | null;
  currency: string | null;
  notes: string | null;
  terms: string | null;
  /** Structured commercial term id (drives due_date); NOT T&C prose. */
  payment_term_id?: string | null;
  /** Hydrated term, frozen into the snapshot as values. */
  payment_term?: SnapshotPaymentTerm | null;
  organization_id: string;
  business_id: string | null;
  /** Frozen printed address; authoritative over live party data. */
  billing_address?: string | null;
  branch_id: string | null;
  contact: SalesInvoiceContactRow | null;
  business: SalesInvoiceBusinessRow | null;
  invoice_items: SalesInvoiceItemRow[] | null;
}

export interface BuildSalesInvoiceSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
}

/**
 * Deterministic: items are emitted in the order supplied and no wall-
 * clock timestamps are introduced, so repeat calls produce byte-identical
 * output. That's what keeps `ensure_document_record`'s upsert idempotent
 * on retry / reprint.
 */
export function buildSalesInvoiceSnapshot(
  invoice: SalesInvoiceHeaderRow,
): BuildSalesInvoiceSnapshotResult {
  if (!invoice.id) throw new Error("buildSalesInvoiceSnapshot: invoice.id required");
  if (!invoice.invoice_number) {
    throw new Error("buildSalesInvoiceSnapshot: invoice_number required");
  }
  if (!invoice.issue_date) {
    throw new Error("buildSalesInvoiceSnapshot: issue_date required");
  }

  const items = (invoice.invoice_items ?? []).map((item) => ({
    description: item.description,
    quantity: Number(item.quantity ?? 0),
    unit_price: Number(item.unit_price ?? 0),
    tax_rate: item.tax_rate == null ? null : Number(item.tax_rate),
    tax_amount: item.tax_amount == null ? null : Number(item.tax_amount),
    discount_percent:
      item.discount_percent == null ? null : Number(item.discount_percent),
    line_total: Number(item.line_total ?? 0),
    sku: item.sku ?? null,
    pack_quantity: item.pack_quantity ?? null,
    pack_size: item.pack_size ?? null,
    unit_of_measure:
      item.unit_of_measure ??
      item.packaging?.name ??
      item.product?.base_uom?.code ??
      null,
    // Pack provenance — the renderers (PDF LineItemsTable, receipt)
    // branch on these; omitting them prints base qty with an
    // invented "ea" unit.
    display_quantity: item.display_quantity ?? null,
    packaging_label: item.packaging_label ?? null,
    base_uom_label: item.base_uom_label ?? null,
    uom_snapshot: item.uom_snapshot ?? null,
  }));

  const currency = invoice.currency || "USD";

  const snapshot: SnapshotBlob = {
    document_type: "invoice",
    document_type_label: "INVOICE",
    document_number: invoice.invoice_number,
    status: invoice.status,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    subtotal: Number(invoice.subtotal ?? 0),
    tax_amount: Number(invoice.tax_amount ?? 0),
    discount_amount: Number(invoice.discount_amount ?? 0),
    total: Number(invoice.total ?? 0),
    amount_paid: Number(invoice.amount_paid ?? 0),
    currency,
    notes: invoice.notes ?? null,
    terms: invoice.terms ?? null,
    payment_term: invoice.payment_term ?? null,
    contact: invoice.contact,
    billing_address: resolveSnapshotAddress(invoice.billing_address, invoice.contact),
    business_id: invoice.business_id,
    organization_id: invoice.organization_id,
    branch_id: invoice.branch_id,
    items,
  };

  return {
    snapshot,
    documentNumber: invoice.invoice_number,
    documentDate: invoice.issue_date.slice(0, 10),
    organizationId: invoice.organization_id,
    businessId: invoice.business_id,
    branchId: invoice.branch_id,
    currency,
    sourceDocId: invoice.id,
  };
}

/**
 * Loads the exact columns the pure builder needs and returns its
 * result. Mirrors the projection in
 * `supabase/functions/generate-document/index.ts::fetchInvoice` so the
 * client-side snapshot lines up with the server-side historical fetcher
 * (until the generate-document short-circuit is retired in Wave 9).
 */
export async function fetchAndBuildSalesInvoiceSnapshot(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<BuildSalesInvoiceSnapshotResult> {
  // Do not use nested PostgREST embeds here. This installation intentionally
  // has no FK relationships on invoices/invoice_items, so schema-cache embeds
  // such as `product:products(...)` fail with PGRST200 before routing begins.
  const { data, error } = await supabase
    .from("invoices")
    .select(
      `
      id, invoice_number, status, issue_date, due_date,
      subtotal, tax_amount, discount_amount, total, amount_paid,
      currency, notes, terms, billing_address,
      organization_id, business_id, branch_id, contact_id, payment_term_id
      `,
    )
    .eq("id", invoiceId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildSalesInvoiceSnapshot: invoice ${invoiceId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }

  const { data: itemData, error: itemError } = await supabase
    .from("invoice_items")
    .select(
      `description, quantity, unit_price, tax_rate, tax_amount,
       discount_percent, line_total, product_id, packaging_id,
       display_uom_id, display_quantity, uom_snapshot, sort_order`,
    )
    .eq("invoice_id", invoiceId)
    .order("sort_order", { ascending: true });

  if (itemError) {
    throw new Error(
      `fetchAndBuildSalesInvoiceSnapshot: invoice ${invoiceId} items failed: ${itemError.message}`,
    );
  }

  const items = (itemData ?? []) as unknown as SalesInvoiceItemSourceRow[];
  const productIds = [...new Set(items.map((item) => item.product_id).filter((id): id is string => Boolean(id)))];
  const packagingIds = [...new Set(items.map((item) => item.packaging_id).filter((id): id is string => Boolean(id)))];
  const displayUomIds = [...new Set(items.map((item) => item.display_uom_id).filter((id): id is string => Boolean(id)))];

  const invoice = data as unknown as Omit<SalesInvoiceHeaderRow, "contact" | "business" | "invoice_items"> & {
    contact_id: string | null;
  };

  const [contactResult, businessResult, productsResult, packagingResult, displayUomsResult] =
    await Promise.all([
      invoice.contact_id
        ? supabase
            .from("contacts")
            .select("name, email, phone, address_line1, city, state, postal_code")
            .eq("id", invoice.contact_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      invoice.business_id
        ? supabase
            .from("businesses")
            .select("id, name, legal_name, email, phone, address, logo_url, base_currency")
            .eq("id", invoice.business_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      productIds.length
        ? supabase.from("products").select("id, sku, base_uom_id").in("id", productIds)
        : Promise.resolve({ data: [], error: null }),
      packagingIds.length
        ? supabase
            .from("product_packaging")
            .select("id, name, qty_in_base_uom")
            .in("id", packagingIds)
        : Promise.resolve({ data: [], error: null }),
      displayUomIds.length
        ? supabase.from("units_of_measure").select("id, code, name").in("id", displayUomIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

  const relatedError =
    contactResult.error ??
    businessResult.error ??
    productsResult.error ??
    packagingResult.error ??
    displayUomsResult.error;
  if (relatedError) {
    throw new Error(
      `fetchAndBuildSalesInvoiceSnapshot: invoice ${invoiceId} related data failed: ${relatedError.message}`,
    );
  }

  const products = (productsResult.data ?? []) as Array<{
    id: string;
    sku: string | null;
    base_uom_id: string | null;
  }>;
  const baseUomIds = [...new Set(products.map((product) => product.base_uom_id).filter((id): id is string => Boolean(id)))];
  const { data: baseUomData, error: baseUomError } = baseUomIds.length
    ? await supabase.from("units_of_measure").select("id, code, name").in("id", baseUomIds)
    : { data: [], error: null };
  if (baseUomError) {
    throw new Error(
      `fetchAndBuildSalesInvoiceSnapshot: invoice ${invoiceId} base units failed: ${baseUomError.message}`,
    );
  }

  const byId = <T extends { id: string }>(rows: T[]) =>
    new Map(rows.map((row) => [row.id, row]));
  const productById = byId(products);
  const packagingById = byId((packagingResult.data ?? []) as Array<{
    id: string;
    name: string | null;
    qty_in_base_uom: number | null;
  }>);
  const displayUomById = byId((displayUomsResult.data ?? []) as Array<{
    id: string;
    code: string | null;
    name: string | null;
  }>);
  const baseUomById = byId((baseUomData ?? []) as Array<{
    id: string;
    code: string | null;
    name: string | null;
  }>);

  const hydratedItems = items.map((item) => {
    const product = item.product_id ? productById.get(item.product_id) : undefined;
    return {
      ...item,
      packaging: item.packaging_id ? packagingById.get(item.packaging_id) ?? null : null,
      display_uom: item.display_uom_id ? displayUomById.get(item.display_uom_id) ?? null : null,
      product: product
        ? {
            sku: product.sku,
            base_uom: product.base_uom_id
              ? baseUomById.get(product.base_uom_id) ?? null
              : null,
          }
        : null,
    };
  });

  const hydrated = normalizeSnapshotItems(
    {
      ...invoice,
      contact: contactResult.data,
      business: businessResult.data,
      invoice_items: hydratedItems,
      payment_term: await fetchPaymentTermSnapshot(supabase, invoice.payment_term_id),
    },
    "invoice_items",
  );
  return buildSalesInvoiceSnapshot(hydrated as unknown as SalesInvoiceHeaderRow);
}
