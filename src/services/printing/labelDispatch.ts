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
  /**
   * ADR-0087 — explicit media profile override. When absent, media is
   * resolved from the workflow-bound printer profile
   * (`printer_profiles.supported_media_ids[0]`).
   */
  mediaProfileId?: string | null;
}

export interface LabelDispatchResult extends DriverResult {
  templateResolved?: { engine: LabelEngine; version: number; scope: string };
  printerResolved?: { profileId: string; scope: string };
  mediaResolved?: { profileId: string; widthMm: number; heightMm: number | null; dpi: number };
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

async function resolveTemplate(
  orgId: string,
  templateKey: string,
  branchId?: string | null,
  mediaProfileId?: string | null,
): Promise<ResolvedTemplate | null> {
  const { data, error } = await supabase.rpc('resolve_label_template', {
    p_org_id: orgId,
    p_template_key: templateKey,
    p_branch_id: branchId ?? null,
    p_media_profile_id: mediaProfileId ?? null,
  });
  if (error || !data || (Array.isArray(data) && data.length === 0)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row as ResolvedTemplate;
}

interface ResolvedPrinter { printer_profile_id: string; binding_id: string; scope: string }

interface ResolvedMedia {
  id: string;
  widthMm: number;
  heightMm: number | null;
  dpi: number;
}

async function resolvePrinterMedia(
  printerProfileId: string,
  overrideMediaId?: string | null,
): Promise<ResolvedMedia | null> {
  const { data: printer } = await supabase
    .from('printer_profiles')
    .select('id, dpi, supported_media_ids')
    .eq('id', printerProfileId)
    .maybeSingle();
  const p = printer as { dpi?: number | null; supported_media_ids?: string[] | null } | null;
  const dpi = Number(p?.dpi) || 203;
  const mediaId =
    overrideMediaId
    ?? (Array.isArray(p?.supported_media_ids) && p!.supported_media_ids!.length > 0
          ? p!.supported_media_ids![0]
          : null);
  if (!mediaId) return null;
  const { data: media } = await supabase
    .from('media_profiles')
    .select('id, width_mm, height_mm')
    .eq('id', mediaId)
    .maybeSingle();
  const m = media as { id?: string; width_mm?: number; height_mm?: number | null } | null;
  if (!m?.id || typeof m.width_mm !== 'number') return null;
  return {
    id: m.id,
    widthMm: Number(m.width_mm),
    heightMm: m.height_mm == null ? null : Number(m.height_mm),
    dpi,
  };
}

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
  // Resolve the physical printer first so the template resolver can pick
  // the media-specific variant when one exists.
  let printer: ResolvedPrinter | null = null;
  if (input.workflow) {
    printer = await resolvePrinter(input.orgId, input.workflow, input.branchId, input.warehouseId);
  }

  let media: ResolvedMedia | null = null;
  if (printer) {
    media = await resolvePrinterMedia(printer.printer_profile_id, input.mediaProfileId ?? null);
  }

  const tpl = await resolveTemplate(
    input.orgId,
    input.templateKey,
    input.branchId,
    media?.id ?? input.mediaProfileId ?? null,
  );
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

  // Map engine → driver payload shape.
  // All label drivers accept `print_raw` with either `{ zpl }` (ZPL), `{ bytes }` (EPL/ESC-POS), or `{ pdfUrl }` (PDF, A4 driver).
  let payload: Record<string, unknown>;
  switch (tpl.engine) {
    case 'zpl':
      payload = { zpl: rendered };
      break;
    case 'epl':
      payload = { epl: rendered };
      break;
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

  // ADR-0087 — carry media geometry + dpi so the label driver emits the
  // paper envelope (`^PW`/`^LL` for ZPL, `q`/`Q` for EPL). Template body
  // owns content only.
  if (media) {
    payload.mediaProfileId = media.id;
    payload.mediaWidthMm = media.widthMm;
    if (media.heightMm != null) payload.mediaHeightMm = media.heightMm;
    payload.dpi = media.dpi;
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
    mediaResolved: media ? { profileId: media.id, widthMm: media.widthMm, heightMm: media.heightMm, dpi: media.dpi } : undefined,
  };
}
