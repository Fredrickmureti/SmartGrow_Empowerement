// @ts-nocheck — Deno runtime
/**
 * Certificate Engine v3 — typed AST for statutory certificates.
 *
 * Country-agnostic paged-media semantics. Localization packs author
 * documents in terms of these nodes; the engine compiles them to
 * deterministic HTML + CSS Paged Media, then hands the result to a
 * pluggable PDF producer.
 *
 * Design rules (see docs/adr/0060-* redesign):
 *   1. No node encodes a country, statute, or form name.
 *   2. Every user-visible string is pack-authored and lives on the node.
 *   3. Every data value is a `Binding` resolved from the payload; the
 *      renderer never guesses.
 *   4. Layout is expressed in paged-media terms (page, header/footer
 *      band, section, matrix with repeat-header) — not in visual
 *      primitives like "y-cursor" or "spacer".
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
  code: string;                 // stable pack-scoped id
  header?: Node[];
  footer?: Node[];
}

// ── Bindings ──────────────────────────────────────────────────────────

/** A value in a node is either a literal or a binding into the payload. */
export type Value = LiteralValue | Binding;

export interface LiteralValue {
  kind: "literal";
  value: string | number | boolean | null;
}

export interface Binding {
  kind: "binding";
  /** Dotted path into the resolved payload, e.g. "employer.tax_pin". */
  path: string;
  /** Optional formatter applied by the resolver. */
  format?: ValueFormat;
  /** Rendered when the resolved value is null/undefined/empty. */
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
  /** Paragraphs; each paragraph is a list of inline runs. */
  paragraphs: Array<Array<{ text: Value; emphasis?: "bold" | "italic" | "muted" }>>;
  align?: "left" | "center" | "right";
}

export interface KeyValueNode {
  type: "key_value";
  label: Value;
  value: Value;
  emphasis?: "primary" | "regular";
}

/** Two-column identity strip: employer on the left, employee on the right. */
export interface IdentityStripNode {
  type: "identity_strip";
  left_title?: Value;
  right_title?: Value;
  left: KeyValueNode[];
  right: KeyValueNode[];
}

/** Semantic grouping. May carry a title, does not force a page break. */
export interface SectionNode {
  type: "section";
  title?: Value;
  children: Node[];
  /** Try to keep the whole section on one page. Engine best-effort. */
  keep_together?: boolean;
}

export interface MatrixColumn {
  key: string;                   // stable column id used by data + footer
  header: Value;
  /** Optional secondary caption on its own header row (e.g. KRA letters A..O). */
  sub_header?: Value;
  /** Optional unit caption on its own header row (e.g. "Kshs."). */
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
  /** Columns that receive a per-column sum. Others are blank. */
  sum_columns: string[];
}

export interface MatrixNode {
  type: "matrix";
  title?: Value;
  /** Path to an array of row objects in the payload. */
  rows_binding: string;
  columns: MatrixColumn[];
  /** Repeat the header row after every page break. */
  repeat_header?: boolean;
  /** Optional footer with per-column totals. */
  footer?: MatrixFooter;
  /** Optional group headers above the columns (declared for engine layout). */
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
  /** Base64 data URL. Pack-supplied; engine has no country knowledge. */
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

/**
 * Fully-resolved payload passed to the engine. The dispatcher assembles
 * this from the existing YTD rollup + employee/employer projections.
 * The engine treats it as opaque JSON — every access goes through a
 * `Binding.path`.
 */
export type CertificatePayload = Record<string, unknown>;
