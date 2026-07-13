// @ts-nocheck — Deno runtime
/**
 * Certificate Engine — typed AST (browser mirror of
 * supabase/functions/_shared/certificate-engine/types.ts). Keep in sync.
 *
 * The engine is completely country-agnostic. Localization packs author
 * documents in terms of the generic node primitives below; the engine
 * compiles them to deterministic HTML + CSS Paged Media which is rendered
 * client-side (paged.js) for both the editor preview and the filed PDF.
 *
 * Schema versions:
 *   - v3: original AST — HeadingNode, RichTextNode, KeyValueNode,
 *         IdentityStripNode, SectionNode, MatrixNode, LegalNoticeNode,
 *         SignatureStripNode, SpacerNode, ImageNode.
 *   - v4: enlarged AST for statutory-form parity. Adds cell-level GridNode
 *         (replaces MatrixNode's fixed 3-row header), nested ListNode,
 *         inline LabelFillNode with dotted-rule value slot, ColumnsNode
 *         container for multi-column body regions, FieldRowNode inline
 *         field group, and pack-owned Theme.
 *
 * Both v3 and v4 nodes may coexist in a document (`schema_version: 4` is
 * a superset). This lets packs migrate progressively without a big-bang.
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

// ── Theme ─────────────────────────────────────────────────────────────

/**
 * Pack-owned presentation tokens. Every visual choice — typography,
 * rule weight, header shading, zebra striping — is expressed here so the
 * engine ships zero aesthetic policy. Missing fields fall back to
 * ENGINE_DEFAULT_THEME.
 */
export interface Theme {
  body_font?: string;
  heading_font?: string;
  base_font_size_pt?: number;
  color?: string;
  muted_color?: string;
  rule_color?: string;
  rule_weight_pt?: number;

  /** Grid header background shading. Use "none" to disable. */
  header_shade?: string | "none";
  header_letter_shade?: string | "none";
  header_unit_shade?: string | "none";
  header_note_shade?: string | "none";

  /** Grid data-row zebra striping. */
  zebra?: "none" | "even" | "odd";
  zebra_color?: string;

  /** Heading treatment. */
  heading_case?: "none" | "upper" | "capitalize";
  heading_underline?: boolean;

  /** Numeric cell density tokens. */
  grid_font_size_pt?: number;
  grid_number_font_size_pt?: number;
  grid_footer_font_size_pt?: number;
  numeric_letter_spacing?: string;

  /** Legal-notice container. */
  legal_border?: boolean;
  legal_border_color?: string;
}

// ── Nodes ─────────────────────────────────────────────────────────────

export type Node =
  // v3 primitives
  | HeadingNode
  | RichTextNode
  | KeyValueNode
  | IdentityStripNode
  | SectionNode
  | MatrixNode
  | LegalNoticeNode
  | SignatureStripNode
  | SpacerNode
  | ImageNode
  // v4 primitives
  | GridNode
  | ListNode
  | LabelFillNode
  | FieldRowNode
  | ColumnsNode
  | PageBreakNode;

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
  sub_header?: Value;
  unit?: Value;
  align?: "left" | "right" | "center";
  format?: ValueFormat;
  width?: number | "auto" | string;
  group?: string;
}

export interface MatrixFooter {
  label: Value;
  sum_columns: string[];
}

/** @deprecated in v4 — prefer GridNode. Kept for backward compatibility. */
export interface MatrixNode {
  type: "matrix";
  title?: Value;
  rows_binding: string;
  columns: MatrixColumn[];
  repeat_header?: boolean;
  footer?: MatrixFooter;
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

// ── v4 primitives ─────────────────────────────────────────────────────

/**
 * A statutory grid with explicit cell-level control over the header
 * stack and footer. Header/footer rows are arrays of cells with
 * colspan/rowspan, so a pack can express label + unit + letter +
 * sub-instruction rows exactly the way a regulator draws the form.
 */
export interface GridColumn {
  id: string;
  /** Width hint: number = mm; string = CSS width like "1fr" or "18mm". */
  width?: number | string;
  align?: "left" | "right" | "center";
  format?: ValueFormat;
  /** Data-row payload key; defaults to `id`. */
  bind_key?: string;
  /** If true, cells in this column never wrap. */
  nowrap?: boolean;
}

export type GridCellVariant = "label" | "unit" | "letter" | "note" | "plain" | "total";

export interface GridHeaderCell {
  span?: number;
  row_span?: number;
  content: Value;
  align?: "left" | "right" | "center";
  variant?: GridCellVariant;
}

export interface GridSumOf {
  kind: "sum_of";
  column_id: string;
  format?: ValueFormat;
}

export interface GridFooterCell {
  span?: number;
  row_span?: number;
  content: Value | GridSumOf;
  align?: "left" | "right" | "center";
  variant?: GridCellVariant;
}

export interface GridNode {
  type: "grid";
  title?: Value;
  columns: GridColumn[];
  /** Header row stack (top → bottom). Any number of rows. */
  header_rows?: GridHeaderCell[][];
  /** Data body bound to a payload array. */
  data_rows: { bind: string };
  /** Footer row stack (top → bottom). Supports `sum_of` cells. */
  footer_rows?: GridFooterCell[][];
  repeat_header?: boolean;
  /** Cell-border scope; defaults to "all". */
  border?: "all" | "outer" | "none";
  /** Per-grid override of the theme's zebra setting. */
  zebra?: "none" | "even" | "odd";
}

export interface ListRun {
  text: Value;
  emphasis?: "bold" | "italic" | "muted";
}

export interface ListItem {
  /** Either a single Value (plain text) or an array of runs (rich text). */
  text?: Value;
  runs?: ListRun[];
  children?: ListNode;
}

export type ListMarker =
  | "decimal"                // 1. 2. 3.
  | "decimal-paren"          // 1) 2) 3)
  | "lower-alpha"            // a. b. c.
  | "lower-alpha-paren"      // (a) (b) (c)
  | "upper-alpha"            // A. B. C.
  | "lower-roman"            // i. ii. iii.
  | "lower-roman-paren"      // (i) (ii) (iii)
  | "upper-roman"
  | "disc"
  | "circle"
  | "square"
  | "none";

export interface ListNode {
  type: "list";
  marker: ListMarker;
  items: ListItem[];
  start?: number;
  /** Compact vertical rhythm — statutory notices typically want this. */
  compact?: boolean;
}

export interface LabelFillNode {
  type: "label_fill";
  label: Value;
  value: Value;
  /** How to draw the "fill-in" line under/after the value. */
  rule?: "dotted" | "solid" | "dashed" | "none";
  /** Width of the value slot. number = mm, string = CSS width. */
  value_width?: number | string;
  label_bold?: boolean;
  emphasis?: "primary" | "regular";
}

export interface FieldRowNode {
  type: "field_row";
  fields: LabelFillNode[];
  gap_mm?: number;
  /** Column layout ratios. Defaults to equal shares. */
  columns?: Array<number | string>;
}

export interface ColumnsNode {
  type: "columns";
  count: number;
  gap_mm?: number;
  /**
   * Per-column children (recommended). When absent, `children` is
   * distributed evenly by CSS columns.
   */
  column_children?: Node[][];
  children?: Node[];
}

export interface PageBreakNode {
  type: "page_break";
}

// ── Template envelope ────────────────────────────────────────────────

export interface CertificateTemplateV3 {
  /** 3 = original AST. 4 = enlarged AST (adds grid, list, label_fill, …). */
  schema_version: 3 | 4;
  code: string;
  display_name: string;
  paper_format: PaperFormat;
  page_master?: PageMaster;
  document: Node[];
  /** Pack-owned presentation tokens. Optional; defaults preserve v3 look. */
  theme?: Theme;
}

export type CertificatePayload = Record<string, unknown>;

/**
 * The engine ships these defaults only so v3 documents authored before
 * the theme existed continue to render the same way. Any v4 template
 * that cares about presentation SHOULD ship its own theme.
 */
export const ENGINE_DEFAULT_THEME: Required<Theme> = {
  body_font: '"Helvetica Neue", "Helvetica", "Arial", sans-serif',
  heading_font: '"Helvetica Neue", "Helvetica", "Arial", sans-serif',
  base_font_size_pt: 9,
  color: "#111",
  muted_color: "#555",
  rule_color: "#555",
  rule_weight_pt: 0.5,
  header_shade: "#e9e9e9",
  header_letter_shade: "#f2f2f2",
  header_unit_shade: "#f2f2f2",
  header_note_shade: "#f7f7f7",
  zebra: "even",
  zebra_color: "#fbfbfb",
  heading_case: "none",
  heading_underline: false,
  grid_font_size_pt: 7,
  grid_number_font_size_pt: 6.5,
  grid_footer_font_size_pt: 5.5,
  numeric_letter_spacing: "-0.1pt",
  legal_border: true,
  legal_border_color: "#333",
};
