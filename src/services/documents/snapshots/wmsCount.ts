/**
 * Cycle count snapshot builders (ADR 0106).
 *
 * Four warehouse artifacts share one source aggregate — a
 * `wms_count_sessions` row plus its lines, read through `get_count_lines`,
 * the ONLY sanctioned read path (it masks expected quantities while a blind
 * session is still being counted). They differ in the lens they put on it:
 *
 *   - `wms.count_sheet`            — the walk-the-aisle worksheet, expected
 *                                    quantity shown, blank column to write in.
 *   - `wms.count_sheet_blind`      — the same walk, with NO expectation. Built
 *                                    by a separate function that never reads
 *                                    `system_qty` / `counted_qty` /
 *                                    `variance_qty`, so a blind sheet is
 *                                    structurally incapable of leaking one.
 *   - `wms.count_variance_report`  — differences on the latest round, with
 *                                    reason codes and why approval is needed.
 *   - `wms.count_audit_report`     — every attempt, every recount round.
 *
 * Warehouse paper is QUANTITY-ONLY. There is no party, no currency, no price
 * and no totals ladder anywhere in these snapshots — that is what keeps the
 * commercial (invoice) renderer from ever being able to draw them.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type CountDocumentKind =
  | "wms.count_sheet"
  | "wms.count_sheet_blind"
  | "wms.count_variance_report"
  | "wms.count_audit_report";

/** Legacy `(documentType, documentId)` pair names, kept stable for callers. */
export const COUNT_DOCUMENT_TYPE: Record<CountDocumentKind, string> = {
  "wms.count_sheet": "count_sheet",
  "wms.count_sheet_blind": "count_sheet_blind",
  "wms.count_variance_report": "count_variance_report",
  "wms.count_audit_report": "count_audit_report",
};

export const COUNT_DOCUMENT_LABEL: Record<CountDocumentKind, string> = {
  "wms.count_sheet": "COUNT SHEET",
  "wms.count_sheet_blind": "BLIND COUNT SHEET",
  "wms.count_variance_report": "COUNT DIFFERENCE REPORT",
  "wms.count_audit_report": "COUNT AUDIT REPORT",
};

export const COUNT_KIND_BY_DOCUMENT_TYPE: Record<string, CountDocumentKind> = {
  count_sheet: "wms.count_sheet",
  count_sheet_blind: "wms.count_sheet_blind",
  count_variance_report: "wms.count_variance_report",
  count_audit_report: "wms.count_audit_report",
};

export interface CountSessionHeaderRow {
  id: string;
  code: string;
  state: string;
  strategy: string;
  is_blind: boolean;
  notes: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  warehouse_id: string;
  physical_count_id: string | null;
  requires_approval: boolean | null;
  created_at: string;
  posted_at: string | null;
  warehouse_name?: string | null;
  warehouse_code?: string | null;
  linked_count_number?: string | null;
}

/** The subset of `get_count_lines` a document is allowed to see. */
export interface CountSnapshotLineRow {
  id: string;
  location_code: string | null;
  location_name: string | null;
  product_name: string | null;
  product_sku: string | null;
  lot_number: string | null;
  expiry_date: string | null;
  serial_numbers: string[] | null;
  system_qty: number | null;
  counted_qty: number | null;
  variance_qty: number | null;
  entered_qty: number | null;
  packaging_name: string | null;
  counted_at: string | null;
  recount_round: number | null;
  recount_of_line_id: string | null;
  tolerance_outcome: string | null;
  variance_reason: string | null;
}

export interface BuildCountSnapshotResult {
  snapshot: Record<string, unknown>;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: null;
  partyKind: null;
  partyId: null;
  sourceDocId: string;
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function humanize(value: string | null | undefined): string {
  return value ? value.replace(/_/g, " ") : "";
}

function binLabel(line: { location_code: string | null; location_name: string | null }): string {
  return line.location_code?.trim() || line.location_name?.trim() || "Unassigned bin";
}

function productLabel(line: { product_name: string | null; product_sku: string | null }): string {
  return line.product_name?.trim() || line.product_sku?.trim() || "Product no longer in catalogue";
}

/** Plain-English reason a supervisor is being asked to approve a line. */
export function toleranceExplanation(outcome: string | null | undefined): string {
  switch (outcome) {
    case "within_tolerance":
      return "Within the allowed tolerance";
    case "approval_required":
      return "Difference is outside tolerance — a supervisor must approve it";
    case "recount_required":
      return "Difference is large enough that the bin must be counted again";
    case "rejected":
      return "Rejected on review";
    default:
      return outcome ? humanize(outcome) : "";
  }
}

function detailBits(line: CountSnapshotLineRow): string {
  const bits: string[] = [];
  if (line.lot_number) bits.push(`Lot ${line.lot_number}`);
  if (line.expiry_date) bits.push(`Exp ${line.expiry_date.slice(0, 10)}`);
  if (line.serial_numbers?.length) bits.push(`${line.serial_numbers.length} serial(s)`);
  return bits.join(" · ");
}

/** Rows superseded by a later recount round are not the current truth. */
function latestOnly(lines: CountSnapshotLineRow[]): CountSnapshotLineRow[] {
  const superseded = new Set(
    lines.map((l) => l.recount_of_line_id).filter((id): id is string => Boolean(id)),
  );
  return lines.filter((l) => !superseded.has(l.id));
}

function headerFacts(session: CountSessionHeaderRow) {
  return {
    document_number: session.code,
    status: session.state,
    warehouse_name: session.warehouse_name ?? null,
    warehouse_code: session.warehouse_code ?? null,
    strategy_label: humanize(session.strategy),
    is_blind: session.is_blind,
    linked_count_number: session.linked_count_number ?? null,
    issue_date: session.posted_at ?? session.created_at,
    counted_on: session.created_at,
    posted_at: session.posted_at,
    notes: session.notes ?? null,
    organization_id: session.organization_id,
    business_id: session.business_id,
    branch_id: session.branch_id,
  };
}

function result(
  session: CountSessionHeaderRow,
  snapshot: Record<string, unknown>,
): BuildCountSnapshotResult {
  return {
    snapshot,
    documentNumber: session.code,
    documentDate: (session.posted_at ?? session.created_at).slice(0, 10),
    organizationId: session.organization_id,
    businessId: session.business_id,
    branchId: session.branch_id,
    currency: null,
    partyKind: null,
    partyId: null,
    sourceDocId: session.id,
  };
}

/**
 * BLIND SHEET — its own builder on purpose.
 *
 * It receives only bin / product / lot identity. There is no code path here
 * through which an expected, counted or variance quantity could reach the
 * page, so misconfiguration cannot leak one.
 */
export function buildBlindCountSheetSnapshot(
  session: CountSessionHeaderRow,
  lines: Array<
    Pick<
      CountSnapshotLineRow,
      "id" | "location_code" | "location_name" | "product_name" | "product_sku" | "lot_number" | "expiry_date"
    >
  >,
): BuildCountSnapshotResult {
  const rows = lines.map((line, index) => ({
    line_no: index + 1,
    bin: binLabel(line),
    product: productLabel(line),
    sku: line.product_sku ?? "",
    lot: line.lot_number ?? "",
    expiry: line.expiry_date ? line.expiry_date.slice(0, 10) : "",
    counted: "",
  }));

  return result(session, {
    ...headerFacts(session),
    document_type: COUNT_DOCUMENT_TYPE["wms.count_sheet_blind"],
    document_type_label: COUNT_DOCUMENT_LABEL["wms.count_sheet_blind"],
    layout: "count_sheet",
    blind: true,
    instructions:
      "Count every bin below and write the quantity you find in the Counted column. " +
      "No expected quantity is shown — record exactly what is on the shelf.",
    count_lines: rows,
    line_count: rows.length,
  });
}

/** Standard worksheet — expected quantity shown, blank column to write in. */
export function buildCountSheetSnapshot(
  session: CountSessionHeaderRow,
  lines: CountSnapshotLineRow[],
): BuildCountSnapshotResult {
  const rows = latestOnly(lines).map((line, index) => ({
    line_no: index + 1,
    bin: binLabel(line),
    product: productLabel(line),
    sku: line.product_sku ?? "",
    lot: line.lot_number ?? "",
    detail: detailBits(line),
    expected: num(line.system_qty),
    counted: "",
  }));

  return result(session, {
    ...headerFacts(session),
    document_type: COUNT_DOCUMENT_TYPE["wms.count_sheet"],
    document_type_label: COUNT_DOCUMENT_LABEL["wms.count_sheet"],
    layout: "count_sheet",
    blind: false,
    instructions:
      "Count every bin below and write the quantity you find in the Counted column. " +
      "Do not adjust stock on this sheet — differences are reviewed and approved in the system.",
    count_lines: rows,
    line_count: rows.length,
  });
}

/** Difference report — what disagreed, by how much, why, and what happens next. */
export function buildCountVarianceSnapshot(
  session: CountSessionHeaderRow,
  lines: CountSnapshotLineRow[],
): BuildCountSnapshotResult {
  const latest = latestOnly(lines);
  const variances = latest.filter(
    (l) => l.counted_qty != null && num(l.variance_qty) !== 0,
  );

  const rows = variances.map((line, index) => ({
    line_no: index + 1,
    bin: binLabel(line),
    product: productLabel(line),
    sku: line.product_sku ?? "",
    lot: line.lot_number ?? "",
    expected: num(line.system_qty),
    counted: num(line.counted_qty),
    difference: num(line.variance_qty),
    reason: humanize(line.variance_reason),
    outcome: toleranceExplanation(line.tolerance_outcome),
  }));

  return result(session, {
    ...headerFacts(session),
    document_type: COUNT_DOCUMENT_TYPE["wms.count_variance_report"],
    document_type_label: COUNT_DOCUMENT_LABEL["wms.count_variance_report"],
    layout: "count_report",
    count_lines: rows,
    line_count: rows.length,
    summary: {
      lines_in_scope: latest.length,
      lines_counted: latest.filter((l) => l.counted_qty != null).length,
      lines_not_counted: latest.filter((l) => l.counted_qty == null).length,
      differences: variances.length,
      awaiting_approval: latest.filter((l) => l.tolerance_outcome === "approval_required").length,
      recounts_open: latest.filter((l) => l.tolerance_outcome === "recount_required").length,
      units_over: variances.reduce((s, l) => s + Math.max(0, num(l.variance_qty)), 0),
      units_short: variances.reduce((s, l) => s + Math.min(0, num(l.variance_qty)), 0),
    },
  });
}

/** Audit report — the full attempt history, including superseded rounds. */
export function buildCountAuditSnapshot(
  session: CountSessionHeaderRow,
  lines: CountSnapshotLineRow[],
): BuildCountSnapshotResult {
  const ordered = [...lines].sort((a, b) => {
    const bin = binLabel(a).localeCompare(binLabel(b));
    if (bin !== 0) return bin;
    return (a.recount_round ?? 0) - (b.recount_round ?? 0);
  });

  const rows = ordered.map((line, index) => ({
    line_no: index + 1,
    bin: binLabel(line),
    product: productLabel(line),
    lot: line.lot_number ?? "",
    round: (line.recount_round ?? 0) + 1,
    expected: num(line.system_qty),
    counted: line.counted_qty == null ? "" : num(line.counted_qty),
    difference: line.counted_qty == null ? "" : num(line.variance_qty),
    entered: line.packaging_name && line.entered_qty != null
      ? `${num(line.entered_qty)} × ${line.packaging_name}`
      : "",
    counted_at: line.counted_at ? line.counted_at.slice(0, 16).replace("T", " ") : "",
    outcome: toleranceExplanation(line.tolerance_outcome),
    superseded: line.recount_of_line_id ? "recount of an earlier attempt" : "",
  }));

  return result(session, {
    ...headerFacts(session),
    document_type: COUNT_DOCUMENT_TYPE["wms.count_audit_report"],
    document_type_label: COUNT_DOCUMENT_LABEL["wms.count_audit_report"],
    layout: "count_report",
    count_lines: rows,
    line_count: rows.length,
    attempts: rows.length,
  });
}

/**
 * Read the session and its lines, then build the requested artifact.
 *
 * Lines always come from `get_count_lines`; `wms_count_lines` is never read
 * directly, so blind masking is applied by the server and not by this file.
 */
export async function fetchAndBuildCountDocumentSnapshot(
  client: SupabaseClient,
  sessionId: string,
  kind: CountDocumentKind,
): Promise<BuildCountSnapshotResult> {
  const { data: sessionRow, error: sessionError } = await client
    .from("wms_count_sessions" as never)
    .select(
      `id, code, state, strategy, is_blind, notes, organization_id, business_id,
       branch_id, warehouse_id, physical_count_id, requires_approval,
       created_at, posted_at,
       warehouses(name, code)`,
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError || !sessionRow) {
    throw new Error(
      `fetchAndBuildCountDocumentSnapshot: count ${sessionId} not found: ${
        sessionError?.message ?? "no row"
      }`,
    );
  }

  const raw = sessionRow as unknown as CountSessionHeaderRow & {
    warehouses?: { name: string | null; code: string | null } | null;
  };

  const session: CountSessionHeaderRow = {
    ...raw,
    warehouse_name: raw.warehouses?.name ?? null,
    warehouse_code: raw.warehouses?.code ?? null,
  };

  if (session.physical_count_id) {
    const { data: pc } = await client
      .from("physical_counts")
      .select("count_number")
      .eq("id", session.physical_count_id)
      .maybeSingle();
    session.linked_count_number =
      ((pc as { count_number?: string | null } | null)?.count_number) ?? null;
  }

  const { data: lineData, error: lineError } = await client.rpc("get_count_lines", {
    p_session_id: sessionId,
  });
  if (lineError) throw lineError;
  const lines = (lineData ?? []) as unknown as CountSnapshotLineRow[];

  switch (kind) {
    case "wms.count_sheet_blind":
      // Project to identity-only BEFORE the builder sees the rows.
      return buildBlindCountSheetSnapshot(
        session,
        lines.map((l) => ({
          id: l.id,
          location_code: l.location_code,
          location_name: l.location_name,
          product_name: l.product_name,
          product_sku: l.product_sku,
          lot_number: l.lot_number,
          expiry_date: l.expiry_date,
        })),
      );
    case "wms.count_variance_report":
      return buildCountVarianceSnapshot(session, lines);
    case "wms.count_audit_report":
      return buildCountAuditSnapshot(session, lines);
    case "wms.count_sheet":
    default:
      return buildCountSheetSnapshot(session, lines);
  }
}