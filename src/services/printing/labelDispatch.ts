/**
 * labelDispatch — Track 2 entry point for printing a label-template by key.
 *
 * Resolves (1) the workflow-bound printer for the active scope and
 * (2) the org/branch-scoped template body, performs `{{token}}`
 * substitution against `vars`, and dispatches the rendered payload
 * through `hardwareClient.exec` under the `label_printer` role.
 *
 * Fallback chain (printer): exact (branch+warehouse) → branch → org → none.
 * Fallback chain (template): branch override → org default → none.
 *
 * If no template is registered for `templateKey`, the function returns a
 * structured `{ ok: false, error }` rather than throwing — saga handlers
 * can rely on that to keep `business_event_outbox` rows recoverable.
 */

import { supabase } from '@/integrations/supabase/client';
import { hardwareClient } from '@/services/hardware/HardwareClient';
import type { DriverResult } from '@/services/hardware/drivers/DriverInterface';

export type LabelEngine = 'zpl' | 'epl' | 'escpos' | 'pdf';
export type PrinterWorkflow =
  | 'receiving' | 'shipping' | 'shelf_edge' | 'product_tag'
  | 'kitchen_hot' | 'kitchen_bar' | 'bar' | 'payslip'
  | 'asset_tag' | 'generic';

export interface LabelDispatchInput {
  orgId: string;
  templateKey: string;
  vars: Record<string, string | number | null | undefined>;
  workflow?: PrinterWorkflow;
  branchId?: string | null;
  warehouseId?: string | null;
  /** Optional idempotency key; falls back to template+source-doc combo. */
  idempotencyKey?: string;
  /** Source document linkage for audit (Track 1). */
  sourceDocType?: string;
  sourceDocId?: string;
  businessEventId?: string;
  /**
   * Track 3 — lot-aware label fields (pharmacy, food retail, controlled
   * substances). When provided, they are merged into `vars` under the
   * standard token names so label bodies can reference
   * `{{lot_number}}`, `{{expiry_date}}`, `{{manufacture_date}}` without
   * the caller having to wire them in manually. Idempotency key is
   * extended so the same product+lot doesn't print twice.
   */
  lotNumber?: string | null;
  expiryDate?: string | null;
  manufactureDate?: string | null;
}

export interface LabelDispatchResult extends DriverResult {
  templateResolved?: { engine: LabelEngine; version: number; scope: string };
  printerResolved?: { profileId: string; scope: string };
}

/** Substitute `{{token}}` (whitespace tolerated) with `vars[token]`. */
export function renderTemplateBody(body: string, vars: Record<string, unknown>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return '';
    return String(v);
  });
}

interface ResolvedTemplate {
  id: string;
  engine: LabelEngine;
  body: string;
  version: number;
  kind: string;
  scope: string;
}

async function resolveTemplate(orgId: string, templateKey: string, branchId?: string | null): Promise<ResolvedTemplate | null> {
  const { data, error } = await supabase.rpc('resolve_label_template', {
    p_org_id: orgId,
    p_template_key: templateKey,
    p_branch_id: branchId ?? null,
  });
  if (error || !data || (Array.isArray(data) && data.length === 0)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row as ResolvedTemplate;
}

interface ResolvedPrinter { printer_profile_id: string; binding_id: string; scope: string }

async function resolvePrinter(orgId: string, workflow: PrinterWorkflow, branchId?: string | null, warehouseId?: string | null): Promise<ResolvedPrinter | null> {
  const { data, error } = await supabase.rpc('resolve_workflow_printer', {
    p_org_id: orgId,
    p_workflow: workflow,
    p_branch_id: branchId ?? null,
    p_warehouse_id: warehouseId ?? null,
  });
  if (error || !data || (Array.isArray(data) && data.length === 0)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row as ResolvedPrinter;
}

export async function printLabelByTemplate(input: LabelDispatchInput): Promise<LabelDispatchResult> {
  const tpl = await resolveTemplate(input.orgId, input.templateKey, input.branchId);
  if (!tpl) {
    return {
      success: false,
      error: `no label template registered for key '${input.templateKey}' in this organization`,
    };
  }

  // Merge lot-aware fields into vars under the standard token names.
  // Callers can still override by passing keys explicitly in `vars`.
  const mergedVars: Record<string, unknown> = {
    lot_number: input.lotNumber ?? null,
    expiry_date: input.expiryDate ?? null,
    manufacture_date: input.manufactureDate ?? null,
    ...input.vars,
  };
  const rendered = renderTemplateBody(tpl.body, mergedVars);

  let printer: ResolvedPrinter | null = null;
  if (input.workflow) {
    printer = await resolvePrinter(input.orgId, input.workflow, input.branchId, input.warehouseId);
  }

  // Map engine → driver payload shape.
  // All label drivers accept `print_raw` with either `{ zpl }` (ZPL), `{ bytes }` (EPL/ESC-POS), or `{ pdfUrl }` (PDF, A4 driver).
  let payload: Record<string, unknown>;
  switch (tpl.engine) {
    case 'zpl':
      payload = { zpl: rendered };
      break;
    case 'epl':
    case 'escpos': {
      const bytes = new TextEncoder().encode(rendered);
      payload = { bytes: Array.from(bytes) };
      break;
    }
    case 'pdf':
      // PDF body is expected to be a URL or base64 data: URI.
      payload = { pdfUrl: rendered };
      break;
    default:
      return { success: false, error: `unsupported label engine '${tpl.engine}'` };
  }

  // Printer scope hints stay in the payload; audit linkage (Track A) is now
  // promoted to top-level fields so HardwareClient writes them to
  // hardware_exec_log.source_doc_*.
  if (printer) {
    payload.printerProfileId = printer.printer_profile_id;
    payload.printerScope = printer.scope;
  }

  const lotSuffix = input.lotNumber ? `:lot:${input.lotNumber}` : '';
  const idem = input.idempotencyKey ??
    `${input.templateKey}:${input.sourceDocType ?? 'manual'}:${input.sourceDocId ?? Date.now()}${lotSuffix}`;

  const role = tpl.engine === 'pdf' ? 'a4_printer' : 'label_printer';

  const res = await hardwareClient.exec({
    role,
    op: 'print_label',
    payload,
    idempotencyKey: idem,
    sourceDocType: input.sourceDocType ?? null,
    sourceDocId: input.sourceDocId ?? null,
    businessEventId: input.businessEventId ?? null,
  });

  return {
    ...res,
    templateResolved: { engine: tpl.engine, version: tpl.version, scope: tpl.scope },
    printerResolved: printer ? { profileId: printer.printer_profile_id, scope: printer.scope } : undefined,
  };
}
