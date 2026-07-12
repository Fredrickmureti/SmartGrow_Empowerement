/**
 * Certificate Engine v3 — typed AST (browser mirror of
 * supabase/functions/_shared/certificate-engine/types.ts). Keep in sync.
 *
 * Country-agnostic paged-media semantics. Localization packs author
 * documents in terms of these nodes; the engine compiles them to
 * deterministic HTML + CSS Paged Media which is rendered client-side
 * (paged.js) for both the editor preview and the filed PDF.
 */

// ── Paper format & page master ────────────────────────────────────────

export type PaperSize = "A4" | "A3" | "Letter" | "Legal";
export type Orientation = "portrait" | "landscape";

export interface PaperFormat {
  size: PaperSize;
  orientation: Orientation;
  /** All margins in mm. */
  margin_top: number;
  margin_right: number;
  margin_bottom: number;
  margin_left: number;
  /** Height reserved for the page-master header band, in mm. */
  header_height: number;
  /** Height reserved for the page-master footer band, in mm. */
  footer_height: number;
}

/** Page master = header/footer bands rendered on every page. */
export interface PageMaster {
  code: string;
  header?: Node[];
  footer?: Node[];
}

// ── Bindings ──────────────────────────────────────────────────────────

export type Value = LiteralValue | Binding;

export interface LiteralValue {
  kind: "literal";
  value: string | number | boolean | null;
}

export interface Binding {
  kind: "binding";
  /** Dotted path into the resolved payload, e.g. "employer.tax_pin". */
  path: string;
  format?: ValueFormat;
  fallback?: string;
}

export type ValueFormat =
  | "text"
  | "number"
  | "currency"
  | "percent"
  | "date"
  | "month_short";

// ── Nodes ─────────────────────────────────────────────────────────────

export type Node =
  | HeadingNode
  | RichTextNode
  | KeyValueNode
  | IdentityStripNode
  | SectionNode
  | MatrixNode
  | LegalNoticeNode
  | SignatureStripNode
  | SpacerNode
  | ImageNode;

export interface HeadingNode {
  type: "heading";
  level: 1 | 2 | 3;
  text: Value;
  align?: "left" | "center" | "right";
}

export interface RichTextNode {
  type: "rich_text";
  paragraphs: Array<Array<{ text: Value; emphasis?: "bold" | "italic" | "muted" }>>;
  align?: "left" | "center" | "right";
}

export interface KeyValueNode {
  type: "key_value";
  label: Value;
  value: Value;
  emphasis?: "primary" | "regular";
}

export interface IdentityStripNode {
  type: "identity_strip";
  left_title?: Value;
  right_title?: Value;
  left: KeyValueNode[];
  right: KeyValueNode[];
}

export interface SectionNode {
  type: "section";
  title?: Value;
  children: Node[];
  keep_together?: boolean;
}

export interface MatrixColumn {
  key: string;
  header: Value;
  /**
   * Optional secondary caption rendered on its own header row beneath
   * `header` — e.g. the KRA column letters A..O. Generic: any pack can
   * use it for a two-line column identity.
   */
  sub_header?: Value;
  /**
   * Optional unit caption rendered on its own header row (e.g. "Kshs.").
   * Country-agnostic; the pack authors the literal text.
   */
  unit?: Value;
  align?: "left" | "right" | "center";
  format?: ValueFormat;
  /** Width hint: fixed mm, "auto", or a fraction weight like "1fr". */
  width?: number | "auto" | string;
  /** Optional column-group label rendered above this column. */
  group?: string;
}

export interface MatrixFooter {
  label: Value;
  sum_columns: string[];
}

export interface MatrixNode {
  type: "matrix";
  title?: Value;
  rows_binding: string;
  columns: MatrixColumn[];
  repeat_header?: boolean;
  footer?: MatrixFooter;
  /** Optional group headers above the columns. */
  column_groups?: Array<{ label: Value; span: number }>;
}

export interface LegalNoticeNode {
  type: "legal_notice";
  title?: Value;
  paragraphs: Value[];
  border?: boolean;
}

export interface SignatureSlot {
  caption: Value;
  sub_caption?: Value;
}

export interface SignatureStripNode {
  type: "signature_strip";
  slots: SignatureSlot[];
}

export interface SpacerNode {
  type: "spacer";
  size_mm: number;
}

export interface ImageNode {
  type: "image";
  data_url: string;
  width_mm?: number;
  height_mm?: number;
  align?: "left" | "center" | "right";
}

// ── Template envelope ────────────────────────────────────────────────

export interface CertificateTemplateV3 {
  schema_version: 3;
  code: string;
  display_name: string;
  paper_format: PaperFormat;
  page_master?: PageMaster;
  document: Node[];
}

export type CertificatePayload = Record<string, unknown>;
