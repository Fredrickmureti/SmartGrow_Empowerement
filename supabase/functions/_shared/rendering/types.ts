/**
 * Rendering Engine — canonical types (Wave 3, ADR-0084).
 *
 * The Rendering Engine is the single boundary that turns
 *   (Document instance) × (Template AST) × (Medium)
 * into a byte artifact. Every server-side print/email/download path
 * now converges here; legacy per-format entry points remain only until
 * Wave 9 purges them.
 *
 * The AST is medium-neutral: the same block list must produce a PDF,
 * an ESC/POS byte stream, or a ZPL label depending on the concrete
 * renderer selected by policy. Blocks describe *intent* (header,
 * line-item table, totals) — not pixel/dot-column geometry. Geometry
 * is the renderer's responsibility.
 */

export type MediaClass = "a4" | "letter" | "thermal" | "label" | "email_html" | "data";
/**
 * `csv` / `xlsx` are *dispositions of the same document*, not a separate
 * pipeline: they render the identical frozen snapshot through the same
 * engine so an extract can never disagree with the printed copy.
 */
export type RenderMedium = "pdf" | "escpos" | "zpl" | "html" | "csv" | "xlsx";

/** Every AST block extends this base. */
interface BlockBase {
  type: string;
  id?: string;
  /** If set, block only renders when the named medium matches. */
  only?: RenderMedium[];
  /** If set, block is skipped when medium matches. */
  hide?: RenderMedium[];
}

export interface HeaderBlock extends BlockBase {
  type: "header";
  variant?: "branded" | "minimal" | "none";
}

export interface PartyBlock extends BlockBase {
  type: "party";
  role: "customer" | "vendor" | "employee" | "recipient" | "shipTo" | "billTo" | "invited_supplier";
}

export interface MetaBlock extends BlockBase {
  type: "meta";
  fields: string[]; // e.g. ["number","date","due_date","currency"]
}

export interface TableBlock extends BlockBase {
  type: "table";
  preset:
    | "line_items"
    | "requirements"
    | "demand_lines"
    | "approval_trail"
    | "payment_schedule"
    | "statement_transactions"
    | "aging_buckets"
    | "payslip_earnings"
    | "payslip_deductions";
}

export interface TotalsBlock extends BlockBase {
  type: "totals";
  preset?: "standard" | "with_tax_breakdown" | "with_discount" | "receipt";
}

export interface NotesBlock extends BlockBase {
  type: "notes";
  source?: "terms" | "footer_note" | "internal_note" | "custom";
  text?: string; // used when source==="custom"
}

export interface FooterBlock extends BlockBase {
  type: "footer";
  variant?: "branded" | "minimal" | "compliance" | "none";
}

export interface BarcodeBlock extends BlockBase {
  type: "barcode";
  symbology: "code128" | "code39" | "ean13" | "upca" | "qr";
  data: string; // may include `{{token}}` placeholders
  size?: "s" | "m" | "l";
}

export interface FiscalBlock extends BlockBase {
  type: "fiscal";
  provider?: string; // "etims","zra","cra",…; when null → resolved from country
}

export interface DividerBlock extends BlockBase {
  type: "divider";
}
export interface SpacerBlock extends BlockBase {
  type: "spacer";
  size?: "s" | "m" | "l";
}
export interface PageBreakBlock extends BlockBase {
  type: "page_break";
}
export interface TextBlock extends BlockBase {
  type: "text";
  text: string;
  style?: "body" | "muted" | "strong" | "heading";
  align?: "left" | "center" | "right";
}

export type AstBlock =
  | HeaderBlock
  | PartyBlock
  | MetaBlock
  | TableBlock
  | TotalsBlock
  | NotesBlock
  | FooterBlock
  | BarcodeBlock
  | FiscalBlock
  | DividerBlock
  | SpacerBlock
  | PageBreakBlock
  | TextBlock;

export interface DocumentTemplateAst {
  version: number;
  kind: string;
  media_class: MediaClass;
  blocks: AstBlock[];
}

export interface ResolvedTemplate {
  id: string;
  kind_code: string;
  scope: "system" | "tenant" | "organization" | "branch";
  version: number;
  label: string;
  ast: DocumentTemplateAst;
  theme_id: string | null;
  header_id: string | null;
  footer_id: string | null;
  media_class: MediaClass;
}

export interface RenderTheme {
  id: string;
  tokens: Record<string, string | number>;
}

/**
 * Runtime context handed to a medium renderer. It is intentionally
 * medium-agnostic; renderers cherry-pick what they need.
 */
export interface RenderContext {
  document: {
    id: string;
    kind_code: string;
    organization_id: string;
    business_id: string;
    branch_id: string | null;
    number: string | null;
    date: string | null;
    currency: string | null;
    snapshot: Record<string, unknown>;
  };
  business: Record<string, unknown> | null;
  theme: RenderTheme | null;
  header: { ast: AstBlock[] } | null;
  footer: { ast: AstBlock[] } | null;
  locale: string;
  /** Free-form renderer options (paper width, copies, capabilities…). */
  options: Record<string, unknown>;
}

export interface RenderRequest {
  medium: RenderMedium;
  /** Either an already-persisted document or an inline preview payload. */
  document_id?: string;
  preview?: {
    kind_code: string;
    business_id: string;
    organization_id: string;
    branch_id?: string | null;
    snapshot: Record<string, unknown>;
  };
  /** Optional template override (else scope-resolved default is used). */
  template_id?: string;
  /** Renderer-specific options passed through to the medium adapter. */
  options?: Record<string, unknown>;
  /** Skip artifact persistence (previews). */
  persist?: boolean;
}

export interface RenderResult {
  bytes: Uint8Array;
  mime_type: string;
  extension: string;
  medium: RenderMedium;
  template_id: string;
  template_version: number;
  content_sha256: string;
  metadata: Record<string, unknown>;
  artifact_id?: string;
}
