/**
 * HR Letter PDF Generator (Phase 6.1 — ADR-0084).
 *
 * Composes the SAME shared PDF primitives every other document uses:
 *   - PdfBuilder (page lifecycle)
 *   - BrandedHeader / drawPageNumber / drawFinalFooter (chrome)
 *   - NotesBlock (recipient meta + prose body)
 *   - SignatureBlock (signatories)
 *
 * HR letters are prose documents, NOT tabular documents. They carry
 * a rich `letter_body` (paragraphs), an issuance date, one or more
 * signatories, and no line-items / totals block. Every HR letter
 * type (`offer_letter`, `promotion_letter`, `warning_letter`,
 * `contract_letter`) runs through this single renderer.
 */

import {
  PdfBuilder,
  drawBrandedHeader,
  embedLogo,
  drawPageNumber,
  drawFinalFooter,
  drawNotesBlock,
  drawSignatureBlock,
  theme,
  type PaperPreset,
  type PaperSpec,
  type Signatory,
} from "./pdf/index.ts";
import { fetchLogoBytes as fetchLogoBytesCached, getOrganizationBranding } from "./branding/index.ts";
import type { OrganizationBranding } from "./branding/index.ts";
import { formatDate } from "./format/index.ts";

// ── HR letter data shape ────────────────────────────────────────────────

export type HrLetterType =
  | "offer_letter"
  | "promotion_letter"
  | "warning_letter"
  | "contract_letter";

export interface HrLetterRecipient {
  name: string;
  employee_number?: string | null;
  job_title?: string | null;
  department?: string | null;
  email?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

export interface HrLetterSignatory {
  name: string;
  role?: string | null;
  signed_on?: string | null;
  caption?: string | null;
}

export interface HrLetterFactRow {
  label: string;
  value: string;
}

export interface HrLetterData {
  document_type: HrLetterType;
  document_number: string;
  document_type_label?: string;
  issue_date?: string | null;
  effective_date?: string | null;
  subject?: string | null;
  salutation?: string | null;
  body: string; // multi-paragraph prose (newlines preserved)
  closing?: string | null;
  facts?: HrLetterFactRow[]; // key/value grid rendered above body (e.g. salary, role)
  recipient: HrLetterRecipient;
  signatories: HrLetterSignatory[];
  organization?: {
    id?: string | null;
    name?: string | null;
    logo_url?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
    phone?: string | null;
    email?: string | null;
    tax_id?: string | null;
  } | null;
  business_id?: string | null;
  organization_id?: string | null;
  notes?: string | null;
  footer_text?: string | null;
}

export interface HrLetterRenderOptions {
  paperFormat?: PaperPreset | PaperSpec;
}

const HR_LETTER_LABELS: Record<HrLetterType, string> = {
  offer_letter: "OFFER OF EMPLOYMENT",
  promotion_letter: "PROMOTION LETTER",
  warning_letter: "WARNING LETTER",
  contract_letter: "EMPLOYMENT CONTRACT",
};

// ── Branding resolution (mirrors pdfGenerator.ts) ────────────────────────

function mapJoinedOrgRow(org: HrLetterData["organization"]): OrganizationBranding | undefined {
  if (!org) return undefined;
  return {
    id: (org as any).id ?? "",
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
    base_currency: null,
  };
}

async function resolveBranding(
  data: HrLetterData,
  // deno-lint-ignore no-explicit-any
  supabase?: any,
): Promise<OrganizationBranding | undefined> {
  const businessId = data.business_id ?? null;
  const orgId = data.organization_id ?? data.organization?.id ?? null;
  if (supabase && (businessId || orgId)) {
    const central = await getOrganizationBranding(supabase, orgId ?? "", businessId);
    if (central) return central;
  }
  return mapJoinedOrgRow(data.organization ?? null);
}

// ── Recipient block (left-aligned, letter-style) ─────────────────────────

function drawLetterRecipient(builder: PdfBuilder, r: HrLetterRecipient): void {
  const { state, fontRegular, fontBold } = builder;
  const { margin } = state;
  const page = builder.page;

  page.drawText("TO:", {
    x: margin, y: builder.y,
    size: theme.size.sectionLabel, font: fontBold, color: theme.color.medGray,
  });
  builder.y -= 13;

  page.drawText(r.name, {
    x: margin, y: builder.y,
    size: theme.size.recipientName, font: fontBold, color: theme.color.text,
  });
  builder.y -= 14;

  const meta = [
    r.job_title,
    r.department,
    r.employee_number ? `Employee #: ${r.employee_number}` : null,
    r.email,
  ].filter(Boolean) as string[];
  for (const line of meta) {
    page.drawText(line, {
      x: margin, y: builder.y,
      size: theme.size.orgDetail, font: fontRegular, color: theme.color.medGray,
    });
    builder.y -= 11;
  }

  const addrParts = [r.address_line1, r.city, r.state, r.postal_code, r.country].filter(Boolean) as string[];
  if (addrParts.length) {
    page.drawText(addrParts.join(", "), {
      x: margin, y: builder.y,
      size: theme.size.orgDetail, font: fontRegular, color: theme.color.medGray,
    });
    builder.y -= 11;
  }

  builder.y -= 8;
}

// ── Facts grid (label/value rows above body) ─────────────────────────────

function drawFactsGrid(builder: PdfBuilder, facts: HrLetterFactRow[]): void {
  if (!facts.length) return;
  const { state, fontRegular, fontBold } = builder;
  const { margin, contentWidth } = state;
  const rowH = 14;
  builder.ensureSpace(rowH * facts.length + 10);
  const labelW = Math.min(180, contentWidth * 0.35);
  for (const f of facts) {
    const page = builder.page;
    page.drawText(f.label, {
      x: margin, y: builder.y,
      size: theme.size.orgDetail, font: fontRegular, color: theme.color.medGray,
    });
    page.drawText(f.value, {
      x: margin + labelW, y: builder.y,
      size: theme.size.summaryValue, font: fontBold, color: theme.color.text,
    });
    builder.y -= rowH;
  }
  builder.y -= 6;
}

// ── Public entry point ───────────────────────────────────────────────────

export async function generateHrLetterPdf(
  data: HrLetterData,
  options: HrLetterRenderOptions = {},
  // deno-lint-ignore no-explicit-any
  supabase?: any,
): Promise<Uint8Array> {
  const title =
    data.document_type_label
    || HR_LETTER_LABELS[data.document_type]
    || "HR LETTER";

  const builder = await PdfBuilder.create({
    orientation: "portrait",
    paperFormat: options.paperFormat ?? "a4",
  });

  const branding = await resolveBranding(data, supabase);
  const logoBytes = branding?.logo_url
    ? await fetchLogoBytesCached(branding.logo_url)
    : (data.organization?.logo_url
      ? await fetchLogoBytesCached(data.organization.logo_url)
      : null);
  const logo = await embedLogo(builder, logoBytes);

  builder.onNewPage = (page) => {
    drawPageNumber(builder, page);
    const drawn = drawBrandedHeader(builder, page, {
      title,
      organization: branding,
      companyName: branding?.name ?? data.organization?.name ?? undefined,
      logo,
    });
    return drawn.bodyY;
  };

  builder.newPage();

  // Reference # + issue/effective dates, right-aligned meta row.
  const rightMargin = builder.state.pageWidth - builder.state.margin;
  const metas: Array<{ label: string; value: string }> = [];
  metas.push({ label: "Reference #", value: data.document_number });
  if (data.issue_date) metas.push({ label: "Issue Date", value: formatDate(data.issue_date) });
  if (data.effective_date) metas.push({ label: "Effective Date", value: formatDate(data.effective_date) });

  const metaTopY = builder.y;
  let mY = metaTopY;
  for (const m of metas) {
    const valueW = builder.fontBold.widthOfTextAtSize(m.value, theme.size.summaryValue);
    builder.page.drawText(m.label, {
      x: rightMargin - 180, y: mY,
      size: theme.size.orgDetail, font: builder.fontRegular, color: theme.color.medGray,
    });
    builder.page.drawText(m.value, {
      x: rightMargin - valueW, y: mY,
      size: theme.size.summaryValue, font: builder.fontBold, color: theme.color.text,
    });
    mY -= 13;
  }
  builder.y = metaTopY;

  // Recipient on the left column.
  drawLetterRecipient(builder, data.recipient);
  if (mY < builder.y) builder.y = mY - 4;

  // Subject line.
  if (data.subject) {
    builder.ensureSpace(20);
    builder.page.drawText(`Subject: ${data.subject}`, {
      x: builder.state.margin, y: builder.y,
      size: theme.size.amountDueLabel, font: builder.fontBold, color: theme.color.text,
    });
    builder.y -= 18;
  }

  // Facts grid — role, salary, effective date, etc.
  if (data.facts && data.facts.length > 0) {
    drawFactsGrid(builder, data.facts);
  }

  // Salutation.
  if (data.salutation) {
    drawNotesBlock(builder, builder.page, { title: "", body: data.salutation });
  }

  // Body (multi-paragraph prose — NotesBlock preserves paragraph breaks).
  drawNotesBlock(builder, builder.page, {
    title: "",
    body: data.body || "",
  });

  if (data.closing) {
    drawNotesBlock(builder, builder.page, { title: "", body: data.closing });
  }

  if (data.notes) {
    drawNotesBlock(builder, builder.page, { title: "Notes", body: data.notes });
  }

  // Signature block — always render at least an employer signatory.
  const signatories: Signatory[] = (data.signatories || [])
    .filter((s) => s && s.name)
    .map((s) => ({
      name: s.name,
      role: s.role ?? undefined,
      signedOn: s.signed_on ? formatDate(s.signed_on) : undefined,
      caption: s.caption ?? undefined,
    }));
  if (signatories.length > 0) {
    drawSignatureBlock(builder, builder.page, {
      title: "Signatures",
      signatories,
    });
  }

  drawFinalFooter(builder, builder.page, {
    footerNote:
      data.footer_text
      || "This letter forms part of the employee's official HR record.",
    includeGeneratedStamp: true,
  });

  return await builder.save();
}