/**
 * Sales Document PDF Generator (unified pipeline)
 *
 * Stage 2/3 closure: this file used to be ~990 LoC of hand-rolled pdf-lib.
 * It now composes the SAME primitives every other report uses:
 *   - PdfBuilder (page lifecycle)
 *   - BrandedHeader / drawPageNumber / drawFinalFooter (chrome)
 *   - LineItemsTable (line items)
 *   - TotalsBlock (subtotal / tax / total / amount paid / balance due)
 *   - NotesBlock (notes, terms, payment instructions)
 *
 * The public API (generateDocumentPdf, generateStatementPdf) is unchanged
 * so callers (generate-document, send-document-email, etc.) keep working.
 */

import {
  PdfBuilder,
  drawBrandedHeader,
  embedLogo,
  drawPageNumber,
  drawFinalFooter,
  drawLineItemsTable,
  drawTotalsBlock,
  drawNotesBlock,
  drawDataTable,
  drawSummaryBlock,
  resolveTypography,
  theme,
  type LineItem,
  type PaperPreset,
  type PaperSpec,
} from "./pdf/index.ts";

/**
 * Stage P3 (ADR-0008): callers may pass a `paperFormat` to render a
 * thermal-width PDF (`"58mm"` / `"80mm"` / explicit mm spec). When omitted,
 * the renderer defaults to A4 portrait — exactly the pre-Stage-P3 behaviour.
 *
 * `orientation` is an escape hatch for layout-pinned callers. Statements
 * default to landscape (ledger presentation); transactional documents are
 * unaffected.
 */
export interface DocumentRenderOptions {
  paperFormat?: PaperPreset | PaperSpec;
  orientation?: "portrait" | "landscape";
}
import { fetchLogoBytes as fetchLogoBytesCached, getOrganizationBranding } from "./branding/index.ts";
import {
  type TemplateSettings,
  type DocumentData,
  type CustomField,
  DEFAULT_TEMPLATE_SETTINGS,
} from "./templateRenderer.ts";
import { formatAccountingNumber as formatCurrency, formatDate } from "./format/index.ts";
import type { OrganizationBranding } from "./branding/index.ts";

// ── Branding resolution ──────────────────────────────────────────────────
//
// Stage L (W3): the document pipeline used to maintain its own
// `orgToBranding(joinedOrgRow)` mapper. That created a second branding shape
// parallel to the one produced by `getOrganizationBranding()` (the central
// loader behind reports + payslips + audit certs), with its own cache state.
//
// `resolveBranding` now collapses the two paths:
//   1. If `data.organization_id` is set AND a Supabase client is wired in,
//      load via `getOrganizationBranding()` so the central logo byte cache
//      is reused across the request.
//   2. Otherwise fall back to mapping the joined `data.organization` row
//      that the `generate-document` fetchers already pre-fetched. This keeps
//      every existing caller working unchanged.
//
// The shape returned matches `OrganizationBranding` exactly in both cases,
// so downstream components see one canonical record.

function mapJoinedOrgRow(org: any): OrganizationBranding | undefined {
  if (!org) return undefined;
  return {
    id: org.id,
    name: org.name ?? "",
    logo_url: org.logo_url ?? null,
    address: org.address ?? null,
    city: org.city ?? null,
    state: org.state ?? null,
    country: org.country ?? null,
    postal_code: org.postal_code ?? null,
    phone: org.phone ?? null,
    email: org.email ?? null,
    tax_id: org.tax_id ?? null,
    base_currency: org.base_currency ?? null,
  };
}

async function resolveBranding(
  data: DocumentData,
  // deno-lint-ignore no-explicit-any
  supabase?: any,
): Promise<OrganizationBranding | undefined> {
  // Branding source-of-truth priority (matches Odoo / Xero / QuickBooks):
  //   1. Document's explicit business_id  → load that legal entity
  //   2. Document's organization_id       → fall back to org's primary business
  //   3. Pre-joined `data.organization`   → last-resort literal
  // We NEVER use the tenant/workspace name for customer-facing branding.
  const businessId =
    (data as any).business_id ?? (data.organization as any)?.business_id ?? null;
  const orgId =
    (data as any).organization_id ?? (data.organization as any)?.id ?? null;

  if (supabase && (businessId || orgId)) {
    const central = await getOrganizationBranding(supabase, orgId, businessId);
    if (central) return central;
  }
  return mapJoinedOrgRow(data.organization);
}

// Document type → display title
const DOC_LABELS: Record<string, string> = {
  invoice: "INVOICE",
  estimate: "ESTIMATE",
  proforma: "PROFORMA INVOICE",
  credit_note: "CREDIT NOTE",
  purchase_order: "PURCHASE ORDER",
  receipt: "RECEIPT",
  delivery_note: "DELIVERY NOTE",
  bill: "VENDOR BILL",
  pos_receipt: "SALES RECEIPT",
  sales_order: "SALES ORDER",
  sales_return: "SALES RETURN",
};

// Document type → recipient block label
const BILL_TO_LABELS: Record<string, string> = {
  invoice: "Bill To:",
  estimate: "Quote For:",
  proforma: "Bill To:",
  credit_note: "Credit To:",
  purchase_order: "Vendor:",
  receipt: "Received From:",
  pos_receipt: "Customer:",
  sales_order: "Customer:",
  delivery_note: "Deliver To:",
  sales_return: "Return From:",
  bill: "Vendor:",
};

// ── Recipient (simplified for sales docs — left-aligned only) ─────────────

function drawSalesRecipient(
  builder: PdfBuilder,
  label: string,
  contact: any,
  customFields: CustomField[],
): void {
  const { state, fontRegular, fontBold } = builder;
  const { margin } = state;
  const page = builder.page;

  // Section label
  page.drawText(label, {
    x: margin, y: builder.y,
    size: theme.size.sectionLabel, font: fontBold, color: theme.color.medGray,
  });
  builder.y -= 13;

  if (contact?.name) {
    page.drawText(contact.name, {
      x: margin, y: builder.y,
      size: theme.size.recipientName, font: fontBold, color: theme.color.text,
    });
    builder.y -= 14;
  }
  if (contact?.company && contact.company !== contact.name) {
    page.drawText(contact.company, {
      x: margin, y: builder.y,
      size: theme.size.orgDetail, font: fontRegular, color: theme.color.medGray,
    });
    builder.y -= 11;
  }
  if (contact?.email) {
    page.drawText(contact.email, {
      x: margin, y: builder.y,
      size: theme.size.orgDetail, font: fontRegular, color: theme.color.medGray,
    });
    builder.y -= 11;
  }
  if (contact?.phone) {
    page.drawText(contact.phone, {
      x: margin, y: builder.y,
      size: theme.size.orgDetail, font: fontRegular, color: theme.color.medGray,
    });
    builder.y -= 11;
  }
  if (contact?.address_line1) {
    const parts = [contact.address_line1, contact.city, contact.state, contact.postal_code].filter(Boolean);
    page.drawText(parts.join(", "), {
      x: margin, y: builder.y,
      size: theme.size.orgDetail, font: fontRegular, color: theme.color.medGray,
    });
    builder.y -= 11;
  }

  // Custom fields in 'details' section
  const detailsFields = customFields.filter((cf) => cf.document_section === "details" && cf.field_value);
  for (const cf of detailsFields) {
    page.drawText(`${cf.field_label}: ${cf.field_value}`, {
      x: margin, y: builder.y,
      size: theme.size.orgDetail, font: fontRegular, color: theme.color.medGray,
    });
    builder.y -= 11;
  }

  builder.y -= 10;
}

// ── Document Meta (issue date, due date, etc., right-aligned) ─────────────

function drawDocumentMeta(
  builder: PdfBuilder,
  data: DocumentData,
  customFields: CustomField[],
): void {
  const { state, fontRegular, fontBold } = builder;
  const { margin, pageWidth } = state;
  const page = builder.page;
  const rightX = pageWidth - margin;
  const startY = builder.y;
  const labelSize = theme.size.orgDetail;
  const valueSize = theme.size.summaryValue;

  const metas: Array<{ label: string; value: string }> = [];
  metas.push({ label: "Document #", value: data.document_number });
  if (data.issue_date) metas.push({ label: "Issue Date", value: formatDate(data.issue_date) });
  if (data.due_date) metas.push({ label: "Due Date", value: formatDate(data.due_date) });
  // Structured payment term — printed as its own meta row, never merged
  // into the Terms & Conditions prose block below.
  if (data.payment_term?.name) {
    metas.push({ label: "Payment Terms", value: String(data.payment_term.name) });
  }
  if (data.expiry_date && !data.due_date) {
    metas.push({ label: "Valid Until", value: formatDate(data.expiry_date) });
  }
  if (data.status) metas.push({ label: "Status", value: data.status.toUpperCase() });

  // Payment-receipt specifics — surface what was paid and how.
  if (data.document_type === "receipt") {
    if (data.payment_method) metas.push({ label: "Payment Method", value: String(data.payment_method) });
    if ((data as any).payment_reference) metas.push({ label: "Reference", value: String((data as any).payment_reference) });
  }

  // Header custom fields
  for (const cf of customFields.filter((cf) => cf.document_section === "header" && cf.field_value)) {
    metas.push({ label: cf.field_label, value: String(cf.field_value) });
  }

  // On narrow (thermal) paper there is no room for a right-aligned meta
  // column beside a left-aligned recipient — the two blocks collide (the
  // "Customer:" overlap defect). Stack the meta as full-width label/value
  // rows and let the recipient block flow beneath it in document order.
  const isNarrow = state.density === "narrow";
  if (isNarrow) {
    const leftX = margin;
    const rightX = pageWidth - margin;
    const rowH = 11;
    for (const m of metas) {
      builder.ensureSpace(rowH);
      page.drawText(m.label, {
        x: leftX, y: builder.y,
        size: labelSize, font: fontRegular, color: theme.color.medGray,
      });
      const vw = fontBold.widthOfTextAtSize(m.value, valueSize);
      page.drawText(m.value, {
        x: rightX - vw, y: builder.y,
        size: valueSize, font: fontBold, color: theme.color.text,
      });
      builder.y -= rowH;
    }
    builder.y -= 4;
    return;
  }

  let y = startY;
  for (const m of metas) {
    const labelW = fontRegular.widthOfTextAtSize(m.label, labelSize);
    const valueW = fontBold.widthOfTextAtSize(m.value, valueSize);
    // Two-column right-aligned: label on left, value on right
    page.drawText(m.label, {
      x: rightX - 180, y,
      size: labelSize, font: fontRegular, color: theme.color.medGray,
    });
    page.drawText(m.value, {
      x: rightX - valueW, y,
      size: valueSize, font: fontBold, color: theme.color.text,
    });
    y -= 13;
    void labelW;
  }
  // Drop builder.y to wherever the meta block ends, only if it pushed lower
  if (y < builder.y) builder.y = y;
}

// ── generateDocumentPdf ────────────────────────────────────────────────────

export async function generateDocumentPdf(
  data: DocumentData,
  template: Partial<TemplateSettings> = {},
  options: DocumentRenderOptions = {},
): Promise<Uint8Array> {
  // Wave 13 architecture guard (self-defending renderer). The A4
  // coordinate renderer must NEVER be reached for a document whose
  // RESOLVED geometry is thermal.
  //
  // The guard interrogates geometry, not document kind: an explicit
  // `options.paperFormat` is the operator's/policy's decision and always
  // wins, and only in its absence do the document's own defaults
  // (`pos_receipt_settings.paper_size`, receipt kinds) imply thermal.
  // That is what allows a payment receipt to be previewed or archived on
  // A4 while the same document still prints at 80 mm on the counter.
  const gpg_paper = String(options.paperFormat ?? "").toLowerCase();
  const gpg_docType = String((data as any)?.document_type ?? "").toLowerCase();
  const gpg_rsPaper = String(
    (data as any)?.pos_receipt_settings?.paper_size ?? "",
  ).toLowerCase();
  // Geometry is a property of the MEDIUM, never of the document kind.
  // Only stored POS receipt settings may imply thermal in the absence of
  // an explicit resolved paper; `document_type === "receipt"` must not,
  // or a payment receipt could never be read/archived on A4.
  const thermalTokens = new Set(["40mm", "58mm", "80mm"]);
  const gpg_impliesThermal = thermalTokens.has(gpg_rsPaper);
  const gpg_isThermal = gpg_paper
    ? thermalTokens.has(gpg_paper)
    : gpg_impliesThermal;
  if (gpg_isThermal) {
    throw new Error(
      `generateDocumentPdf refused: document is thermal ` +
        `(paperFormat="${gpg_paper}", docType="${gpg_docType}", ` +
        `rs.paper_size="${gpg_rsPaper}"). ` +
        `Route through renderThermalPdf via generate-document's thermal ` +
        `gate (Wave 10/13). Direct callers must not bypass it.`,
    );
  }
  const t: TemplateSettings = { ...DEFAULT_TEMPLATE_SETTINGS, ...template };
  const customFields = data.custom_fields || [];
  const currency = data.currency || "USD";


  // Resolve title (template override > document_type_label > default)
  const docLabel =
    (data as any).document_type_label
    || (t.document_title_format !== "INVOICE" ? t.document_title_format : null)
    || DOC_LABELS[data.document_type]
    || "DOCUMENT";

  const isCreditPOSInvoice = data.document_type === "pos_receipt" && docLabel === "INVOICE";
  const billToLabel = isCreditPOSInvoice
    ? "Bill To:"
    : (BILL_TO_LABELS[data.document_type] || "Bill To:");

  // Build PDF — A4 portrait by default; callers may override with thermal
  // widths (Stage P3, ADR-0008). The builder picks density automatically
  // from page width (≤ 90 mm → narrow), and components react to it.
  const builder = await PdfBuilder.create({
    orientation: "portrait",
    paperFormat: options.paperFormat ?? "a4",
  });

  // Embed logo once
  const logoBytes = data.organization?.logo_url
    ? await fetchLogoBytesCached(data.organization.logo_url)
    : null;
  const logo = await embedLogo(builder, logoBytes);

  // Branded masthead on every page
  const branding = mapJoinedOrgRow(data.organization);
  builder.onNewPage = (page) => {
    drawPageNumber(builder, page);
    const drawn = drawBrandedHeader(builder, page, {
      title: docLabel,
      organization: branding,
      companyName: data.organization?.name,
      logo,
    });
    return drawn.bodyY;
  };

  builder.newPage();

  // Document meta. On wide paper (A4/Letter) the meta is right-aligned and
  // the recipient renders alongside it on the left. On narrow thermal paper
  // there is no horizontal room for two columns, so the meta stacks
  // full-width and the recipient flows beneath it.
  const narrowLayout = builder.state.density === "narrow";
  const metaTopY = builder.y;
  drawDocumentMeta(builder, data, customFields);
  if (!narrowLayout) {
    // Reset y to meta top so the bill-to renders at the same vertical position
    // on the LEFT (the meta only consumed the right column).
    builder.y = metaTopY;
  }

  // Recipient (bill-to). Skipped on narrow paper when the contact is empty
  // (walk-in POS sales) — printing "Customer:" with no body wastes rows.
  const hasRecipient = !!(data.contact && (data.contact.name || data.contact.company || data.contact.email || data.contact.phone || data.contact.address_line1));
  if (!narrowLayout || hasRecipient) {
    drawSalesRecipient(builder, billToLabel, data.contact, customFields);
  }

  // Line items — for customer-payment receipts with allocation rows we
  // render a dedicated "Applied To Invoices" table instead of the generic
  // line-items grid so the document properly explains which invoices
  // were settled and what balance remains on each.
  const allocs = (data as any).payment_allocations as Array<any> | undefined;
  // A payment receipt NEVER renders a product grid — even a pure on-account
  // payment (no allocations) is a cash-application document. Its body is the
  // ledger; the sale's lines belong to the invoice.
  const isPaymentReceipt = data.document_type === "receipt";

  if (isPaymentReceipt) {
    const list = Array.isArray(allocs) ? allocs : [];
    const unapplied = Number((data as any).unapplied_amount || 0);
    const totalApplied = (data as any).total_applied != null
      ? Number((data as any).total_applied)
      : list.reduce((s, a) => s + (Number(a.amount_applied) || 0), 0);
    const received = (data as any).amount_received != null
      ? Number((data as any).amount_received)
      : Number(data.total || 0);
    const rows: any[] = list.map((a) => ({
      invoice: a.invoice_number,
      date: a.invoice_date ? formatDate(a.invoice_date) : "—",
      invoice_total: Number(a.invoice_total) || 0,
      amount_applied: Number(a.amount_applied) || 0,
      balance: Number(a.balance_after) || 0,
    }));
    if (list.length > 0) {
      rows.push({
        invoice: "Total applied",
        date: "",
        invoice_total: "",
        amount_applied: totalApplied,
        balance: "",
        _isSubtotal: true,
      });
    }
    if (unapplied > 0) {
      rows.push({
        invoice: "On account (unapplied)",
        date: "",
        invoice_total: "",
        amount_applied: unapplied,
        balance: "",
        _isSubtotal: true,
      });
    }
    rows.push({
      invoice: "Amount received",
      date: "",
      invoice_total: "",
      amount_applied: received,
      balance: "",
      _isGrandTotal: true,
    });
    drawDataTable(builder, {
      currency,
      columns: [
        { key: "invoice", header: "Document", align: "left" },
        { key: "date", header: "Date", align: "left" },
        { key: "invoice_total", header: "Invoice Total", align: "right", format: "currency" },
        { key: "amount_applied", header: "Applied", align: "right", format: "currency" },
        { key: "balance", header: "Balance", align: "right", format: "currency" },
      ],
      rows,
    });
  } else {
    drawLineItemsTable(builder, {
      items: (data.items || []) as LineItem[],
      currency,
      show_line_numbers: t.show_line_numbers,
      show_item_sku: t.show_item_sku,
      show_quantity: t.show_quantity,
      show_unit_price: t.show_unit_price,
      show_tax_column: t.show_tax_column,
      show_discount_column: t.show_discount_column,
      hide_amounts: data.hide_amounts,
    });
  }

  // After-items custom fields
  const afterItems = customFields.filter((cf) => cf.document_section === "after_items" && cf.field_value);
  for (const cf of afterItems) {
    builder.ensureSpace(12);
    builder.page.drawText(`${cf.field_label}: ${cf.field_value}`, {
      x: builder.state.margin, y: builder.y,
      size: theme.size.orgDetail, font: builder.fontRegular, color: theme.color.medGray,
    });
    builder.y -= 12;
  }

  // Stage V2 — Delivery-note logistics block. Renders only when the document
  // is a delivery note AND at least one logistics field is populated. Each
  // line is rendered conditionally so empty tenants see nothing.
  if (data.document_type === "delivery_note") {
    const fmtDt = (v?: string | null) => v ? formatDate(v) : null;
    const lines: string[] = [];
    if (data.shipping_method) lines.push(`Shipping method: ${data.shipping_method}`);
    if (data.carrier_name) {
      lines.push(
        `Carrier: ${data.carrier_name}` +
        (data.tracking_number ? `  —  Tracking #: ${data.tracking_number}` : ""),
      );
    } else if (data.tracking_number) {
      lines.push(`Tracking #: ${data.tracking_number}`);
    }
    if (data.carrier_tracking_url) lines.push(`Track: ${data.carrier_tracking_url}`);
    if (data.driver_name) lines.push(`Driver: ${data.driver_name}`);
    if (data.vehicle_number) lines.push(`Vehicle: ${data.vehicle_number}`);
    if (data.dispatch_route) lines.push(`Route: ${data.dispatch_route}`);
    if (data.dispatch_officer_name) lines.push(`Dispatch officer: ${data.dispatch_officer_name}`);
    if (data.ready_at) lines.push(`Ready: ${fmtDt(data.ready_at)}`);
    if (data.dispatched_at) lines.push(`Dispatched: ${fmtDt(data.dispatched_at)}`);
    if (data.delivered_at) lines.push(`Delivered: ${fmtDt(data.delivered_at)}`);
    if (data.received_by_name && !/^[0-9a-fA-F-]{36}$/.test(String(data.received_by_name).trim())) {
      lines.push(`Received by: ${data.received_by_name}`);
    }
    if (data.freight_cost != null && Number(data.freight_cost) > 0) {
      const cur = data.freight_currency || data.currency || "USD";
      lines.push(`Freight cost: ${cur} ${Number(data.freight_cost).toFixed(2)}`);
    }
    if (data.is_backorder && data.backorder_of_number) {
      lines.unshift(`Backorder of #${data.backorder_of_number}`);
    }
    if (lines.length > 0) {
      drawNotesBlock(builder, builder.page, {
        title: "Logistics",
        body: lines.join("\n"),
      });
    }
  }

  // Amount in words — an official receipt states the sum received in words.
  if (data.document_type === "receipt" && (data as any).amount_in_words) {
    drawNotesBlock(builder, builder.page, {
      title: "Amount in words",
      body: String((data as any).amount_in_words),
    });
  }

  // Totals (skip for delivery notes that hide amounts, and for payment
  // receipts whose ledger already grand-totals the money received —
  // a second Subtotal/Total block would double-state it).
  if (!data.hide_amounts && data.document_type !== "receipt") {
    const isPOS = data.document_type === "pos_receipt";
    const amountPaid = data.amount_paid && data.amount_paid > 0 ? data.amount_paid : undefined;
    const balanceDue = amountPaid !== undefined
      ? data.total - amountPaid
      : (isPOS ? data.total - (data.amount_paid || 0) : undefined);

    drawTotalsBlock(builder, builder.page, {
      currency,
      subtotal: t.show_subtotal ? data.subtotal : undefined,
      discount: t.show_discount_total ? data.discount_amount : undefined,
      tax: t.show_tax_breakdown ? data.tax_amount : undefined,
      total: data.total,
      amountPaid,
      balanceDue,
    });
  }

  // Bank details / payment methods
  if (t.show_payment_methods && data.payment_methods && data.payment_methods.length > 0) {
    const lines: string[] = [];
    for (const m of data.payment_methods) {
      lines.push(`${m.label}`);
      const d = m.details || {};
      switch (m.type) {
        case "bank":
          if (d.bank_name) lines.push(`  Bank: ${d.bank_name}`);
          if (d.account_name) lines.push(`  Account Name: ${d.account_name}`);
          if (d.account_number) lines.push(`  Account No: ${d.account_number}`);
          if (d.branch) lines.push(`  Branch: ${d.branch}`);
          if (d.swift_code) lines.push(`  SWIFT: ${d.swift_code}`);
          if (d.iban) lines.push(`  IBAN: ${d.iban}`);
          break;
        case "mobile_money":
          if (d.paybill_number) lines.push(`  Paybill: ${d.paybill_number}`);
          if (d.till_number) lines.push(`  Till No: ${d.till_number}`);
          if (d.account_number) lines.push(`  Account: ${d.account_number}`);
          if (d.phone_number) lines.push(`  Phone: ${d.phone_number}`);
          break;
        case "online":
          if (d.email) lines.push(`  Email: ${d.email}`);
          if (d.username) lines.push(`  Username: ${d.username}`);
          if (d.payment_link) lines.push(`  Link: ${d.payment_link}`);
          break;
        case "crypto":
          if (d.network) lines.push(`  Network: ${d.network}`);
          if (d.wallet_address) lines.push(`  Address: ${d.wallet_address}`);
          break;
        case "cash":
          if (d.instructions) lines.push(`  ${d.instructions}`);
          break;
      }
      lines.push("");
    }
    drawNotesBlock(builder, builder.page, {
      title: "Payment Methods",
      body: lines.join("\n").trim(),
    });
  } else if (t.show_bank_details && t.bank_details && Object.keys(t.bank_details).length > 0) {
    const bd = t.bank_details;
    const lines = [
      bd.bank_name ? `Bank: ${bd.bank_name}` : null,
      bd.account_name ? `Account Name: ${bd.account_name}` : null,
      bd.account_number ? `Account No: ${bd.account_number}` : null,
      bd.branch ? `Branch: ${bd.branch}` : null,
      bd.swift_code ? `SWIFT: ${bd.swift_code}` : null,
    ].filter(Boolean) as string[];
    if (lines.length > 0) {
      drawNotesBlock(builder, builder.page, {
        title: "Bank Details",
        body: lines.join("\n"),
      });
    }
  }

  // Payment instructions
  if (t.show_payment_instructions && t.payment_instructions) {
    drawNotesBlock(builder, builder.page, {
      title: "Payment Instructions",
      body: t.payment_instructions,
    });
  }

  // Notes
  if (data.notes) {
    drawNotesBlock(builder, builder.page, { title: "Notes", body: data.notes });
  }

  // Terms
  if (t.show_terms && (data.terms || t.terms_text)) {
    drawNotesBlock(builder, builder.page, {
      title: "Terms & Conditions",
      body: data.terms || t.terms_text || "",
    });
  }

  // Notes-section custom fields
  const notesFields = customFields.filter((cf) => cf.document_section === "notes" && cf.field_value);
  for (const cf of notesFields) {
    drawNotesBlock(builder, builder.page, {
      title: cf.field_label,
      body: String(cf.field_value),
    });
  }

  // Additional custom fields
  const addFields = customFields.filter((cf) => cf.document_section === "additional" && cf.field_value);
  if (addFields.length > 0) {
    const body = addFields.map((cf) => `${cf.field_label}: ${cf.field_value}`).join("\n");
    drawNotesBlock(builder, builder.page, { title: "Additional Information", body });
  }

  // Final footer
  drawFinalFooter(builder, builder.page, {
    footerNote: t.footer_text || "Thank you for your business!",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}

// ── generateStatementPdf ───────────────────────────────────────────────────
//
// Customer/vendor statements: header + recipient + transaction table
// (Date, Type, Reference, Description, Charges, Credits, Balance) +
// optional aging summary + closing balance.

export async function generateStatementPdf(
  data: DocumentData,
  template: Partial<TemplateSettings> = {},
  options: DocumentRenderOptions = {},
): Promise<Uint8Array> {
  // Wave 12 architecture guard — statements are structurally A4-only
  // (multi-column ledger with charges/credits/balance). If a caller
  // resolves a thermal paper format for a statement request, the
  // routing/policy layer is wrong, not this renderer.
  const gsp_paper = String(options.paperFormat ?? "").toLowerCase();
  if (gsp_paper === "40mm" || gsp_paper === "58mm" || gsp_paper === "80mm") {
    throw new Error(
      `generateStatementPdf invoked with thermal paper "${gsp_paper}". ` +
        `Statements are A4/Letter-only (Wave 12).`,
    );
  }
  const t: TemplateSettings = { ...DEFAULT_TEMPLATE_SETTINGS, ...template };
  const currency = data.currency || "USD";

  const transactions = data.statement_transactions || [];
  const aging = data.statement_aging || [];
  const openingBalance = data.statement_opening_balance ?? 0;
  const closingBalance = data.statement_closing_balance ?? 0;
  const periodStart = data.statement_period_start;
  const periodEnd = data.statement_period_end;

  const title = (data as any).document_type_label || "CUSTOMER STATEMENT";
  const periodLabel = periodStart && periodEnd
    ? `${formatDate(periodStart)} — ${formatDate(periodEnd)}`
    : (data.issue_date ? `Statement Date: ${formatDate(data.issue_date)}` : undefined);

  // Presentation (2026-08-10): a statement is a multi-column ledger, not a
  // transactional document. It resolves the `ledger` profile (8.5pt body,
  // 40pt gutter) on a LANDSCAPE canvas so Date / Type / Reference /
  // Description / Charges / Credits / Balance each get real width instead
  // of wrapping at 7.5pt inside a portrait 451pt content box.
  const stmtTypography = resolveTypography("ledger");
  const builder = await PdfBuilder.create({
    orientation: options.orientation ?? "landscape",
    paperFormat: options.paperFormat ?? "a4",
    margin: stmtTypography.pageMargin,
    bottomMargin: stmtTypography.pageMargin,
  });

  const logoBytes = data.organization?.logo_url
    ? await fetchLogoBytesCached(data.organization.logo_url)
    : null;
  const logo = await embedLogo(builder, logoBytes);

  const stmtBranding = mapJoinedOrgRow(data.organization);
  builder.onNewPage = (page) => {
    drawPageNumber(builder, page, stmtTypography);
    const drawn = drawBrandedHeader(builder, page, {
      title,
      dateRange: periodLabel,
      organization: stmtBranding,
      companyName: data.organization?.name,
      logo,
      typography: stmtTypography,
    });
    return drawn.bodyY;
  };

  builder.newPage();

  // Recipient (no amount-due in header; we surface it at the bottom instead)
  drawSalesRecipient(builder, "Statement For:", data.contact, []);

  // Opening-balance pseudo-row + transactions
  const rows: any[] = [];
  rows.push({
    date: "",
    type: "",
    reference: "",
    description: "Opening Balance",
    charges: "",
    credits: "",
    balance: openingBalance,
    _isHeader: true,
  });
  for (const txn of transactions) {
    rows.push({
      date: formatDate(txn.date),
      type: txn.type,
      reference: txn.reference || "",
      description: txn.description || "",
      charges: txn.charges > 0 ? txn.charges : "",
      credits: txn.credits > 0 ? txn.credits : "",
      balance: txn.balance,
    });
  }
  rows.push({
    date: "",
    type: "",
    reference: "",
    description: "Closing Balance",
    charges: "",
    credits: "",
    balance: closingBalance,
    _isGrandTotal: true,
  });

  drawDataTable(builder, {
    columns: [
      { key: "date", header: "Date", width: 10, align: "left" },
      { key: "type", header: "Type", width: 11, align: "left" },
      { key: "reference", header: "Reference", width: 14, align: "left" },
      { key: "description", header: "Description", width: 29, align: "left" },
      { key: "charges", header: "Charges", width: 12, format: "currency", align: "right" },
      { key: "credits", header: "Credits", width: 12, format: "currency", align: "right" },
      { key: "balance", header: "Balance", width: 12, format: "currency", align: "right" },
    ],
    rows,
    currency,
    typography: stmtTypography,
  });

  // Aging summary
  if (aging.length > 0) {
    const summaryItems = aging.map((b) => ({
      label: b.label,
      value: formatCurrency(b.amount, currency),
    }));
    drawSummaryBlock(builder, builder.page, summaryItems, stmtTypography);
  }

  // Amount Due (closing balance, if positive)
  if (closingBalance > 0) {
    drawTotalsBlock(builder, builder.page, {
      currency,
      total: closingBalance,
    });
  }

  drawFinalFooter(builder, builder.page, {
    footerNote: t.footer_text || "Computer-generated statement — no signature required",
    includeGeneratedStamp: true,
    typography: stmtTypography,
  });

  return await builder.save();
}
