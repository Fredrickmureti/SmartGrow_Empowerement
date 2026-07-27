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
import { execForIntent } from '@/services/hardware/execForIntent';
import type { DriverResult } from '@/services/hardware/drivers/DriverInterface';
import { compileLabelDoc, isLabelDoc, type LabelDoc } from './labelCompiler';

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
   * resolved from the workflow-bound device
   * (`device_assignments.supported_media_ids[0]`).
   *
   * Phase 2b: `printer_profiles` was consolidated into
   * `device_assignments`; the "printer" columns (dpi, supported_media_ids,
   * paper_size, command_language …) now live directly on the assignment
   * row selected by `resolve_device_for_workflow`.
   */
  mediaProfileId?: string | null;
}

export interface LabelDispatchResult extends DriverResult {
  templateResolved?: { engine: LabelEngine; version: number; scope: string };
  /** `profileId` == `device_assignments.id` of the resolved printer. */
  printerResolved?: { profileId: string; scope: string };
  mediaResolved?: { profileId: string; widthMm: number; heightMm: number | null; dpi: number };
}

/**
 * Substitute `{{token}}` (whitespace tolerated) with `vars[token]`.
 *
 * Phase 15 (ADR-0088) — media-relative geometry tokens. When `dpi` is
 * provided, an mm-prefixed token pack resolves to device dots BEFORE the
 * body reaches the driver, so label bodies express geometry in physical
 * millimetres and print at the same physical size on 152/203/300/600 dpi
 * hardware. Supported prefixes:
 *
 *   {{mm:<n>}}     → round(n * dpi / 25.4)               // coordinate / length
 *   {{cf:<n>mm}}   → same                                 // ^CF font height
 *   {{bh:<n>mm}}   → same                                 // barcode height
 *   {{by:<n>mm}}   → clamped ^BY module width in dots (min 1, max 10)
 *   {{hri_flag}}   → resolves from `vars.hri_flag` (default 'N')
 *
 * mm-tokens are resolved first so `vars` may still supply plain string
 * substitutions (name, sku, barcode, sku_display, …) unchanged. Legacy
 * dot-based bodies contain no mm-tokens and pass through untouched.
 */
/**
 * ASCII-safe substitution value. ZPL / EPL / ESC-POS wires are byte
 * streams interpreted against a device code page (typically CP437 or
 * PC850). A raw UTF-8 byte inside a `^FD…^FS` field renders as whatever
 * glyph that byte maps to on the printer — e.g. `Intl.NumberFormat`
 * inserts U+00A0 (NBSP) between currency code and amount, which prints
 * as `á` on CP437. Mirror the edge builder's sanitiser byte-for-byte
 * (see `supabase/functions/_shared/printing/zpl/builder.ts::asciiSafe`)
 * and additionally fold known Unicode spaces to a regular space so
 * "KES\u00A070.00" prints as "KES 70.00", not "KES70.00".
 */
export function asciiSafeLabelVar(v: unknown, max = 64): string {
  if (v === null || v === undefined) return '';
  return String(v)
    // Fold NBSP, narrow-NBSP, thin/hair spaces, en/em spaces, figure space,
    // zero-width joiners etc. to a plain ASCII space before stripping.
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, max);
}

export function renderTemplateBody(
  body: string,
  vars: Record<string, unknown>,
  opts: { dpi?: number } = {},
): string {
  const dpi = Number.isFinite(opts.dpi) && (opts.dpi as number) > 0 ? (opts.dpi as number) : 203;
  const dpmm = dpi / 25.4;
  const toDots = (mm: number) => Math.max(1, Math.round(mm * dpmm));
  const geomResolved = body
    .replace(/\{\{\s*mm\s*:\s*(-?\d+(?:\.\d+)?)\s*\}\}/g, (_m, n) => String(toDots(Number(n))))
    .replace(/\{\{\s*cf\s*:\s*(-?\d+(?:\.\d+)?)\s*mm\s*\}\}/gi, (_m, n) => String(toDots(Number(n))))
    .replace(/\{\{\s*bh\s*:\s*(-?\d+(?:\.\d+)?)\s*mm\s*\}\}/gi, (_m, n) => String(toDots(Number(n))))
    .replace(/\{\{\s*by\s*:\s*(-?\d+(?:\.\d+)?)\s*mm\s*\}\}/gi, (_m, n) =>
      String(Math.max(1, Math.min(10, Math.round(Number(n) * dpmm)))),
    );
  return geomResolved.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    return asciiSafeLabelVar(vars[key]);
  });
}

interface ResolvedTemplate {
  id: string;
  engine: LabelEngine;
  body: string;
  body_json?: unknown;
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

/** Post Phase 2b: the resolved id IS the device_assignments.id. */
interface ResolvedPrinter { device_assignment_id: string; binding_id: string; scope: string }

interface ResolvedMedia {
  id: string;
  widthMm: number;
  heightMm: number | null;
  dpi: number;
}

/**
 * Resolve media geometry for a print job.
 *
 * Phase 2b — `dpi` and `supported_media_ids` now come from the
 * `device_assignments` row selected by the workflow resolver (they used
 * to live on the standalone `printer_profiles` table, which the Phase 2a
 * migration consolidated into `device_assignments`). The fallback chain
 * is unchanged so orgs with a default `media_profiles` row keep
 * printing even when a device has no pinned media list.
 *
 * Fallback chain:
 *   1. Explicit override (`overrideMediaId`).
 *   2. Device's `supported_media_ids[0]` — operator-pinned on the device.
 *   3. Org-scoped default media (`is_default = true`).
 *   4. Any active media row for the org (oldest first).
 */
async function resolvePrinterMedia(
  deviceAssignmentId: string | null,
  orgId: string,
  overrideMediaId?: string | null,
): Promise<ResolvedMedia | null> {
  let dpi = 203;
  let candidateMediaId: string | null = overrideMediaId ?? null;

  if (deviceAssignmentId) {
    const { data: device } = await supabase
      .from('device_assignments')
      .select('id, dpi, supported_media_ids')
      .eq('id', deviceAssignmentId)
      .maybeSingle();
    const p = device as { dpi?: number | null; supported_media_ids?: string[] | null } | null;
    dpi = Number(p?.dpi) || 203;
    if (!candidateMediaId && Array.isArray(p?.supported_media_ids) && p!.supported_media_ids!.length > 0) {
      candidateMediaId = p!.supported_media_ids![0];
    }
  }

  const loadById = async (id: string): Promise<ResolvedMedia | null> => {
    const { data } = await supabase
      .from('media_profiles')
      .select('id, width_mm, height_mm')
      .eq('id', id)
      .maybeSingle();
    const m = data as { id?: string; width_mm?: number; height_mm?: number | null } | null;
    if (!m?.id || typeof m.width_mm !== 'number') return null;
    return { id: m.id, widthMm: Number(m.width_mm), heightMm: m.height_mm == null ? null : Number(m.height_mm), dpi };
  };

  if (candidateMediaId) {
    const hit = await loadById(candidateMediaId);
    if (hit) return hit;
  }

  for (const flag of [true, false]) {
    let q = supabase
      .from('media_profiles')
      .select('id, width_mm, height_mm')
      .eq('org_id', orgId)
      .eq('active', true)
      .order('created_at', { ascending: true })
      .limit(1);
    if (flag) q = q.eq('is_default', true);
    const { data } = await q.maybeSingle();
    const m = data as { id?: string; width_mm?: number; height_mm?: number | null } | null;
    if (m?.id && typeof m.width_mm === 'number') {
      return { id: m.id, widthMm: Number(m.width_mm), heightMm: m.height_mm == null ? null : Number(m.height_mm), dpi };
    }
  }

  return null;
}

async function resolvePrinter(orgId: string, workflow: PrinterWorkflow, branchId?: string | null, warehouseId?: string | null): Promise<ResolvedPrinter | null> {
  // Phase 2b — canonical resolver returns a device_assignments.id.
  const { data, error } = await supabase.rpc('resolve_device_for_workflow', {
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

  // ADR-0087 — media resolution now runs even without a workflow-bound
  // printer, so an org with a default media_profile always gets a valid
  // envelope. The `printer` arg is optional; when null we skip straight
  // to the org-default fallback chain.
  let media: ResolvedMedia | null = await resolvePrinterMedia(
    printer?.device_assignment_id ?? null,
    input.orgId,
    input.mediaProfileId ?? null,
  );

  const tpl = await resolveTemplate(
    input.orgId,
    input.templateKey,
    input.branchId,
    media?.id ?? input.mediaProfileId ?? null,
  );
  if (!tpl) {
    // Distinguish "no row at all" from "rows exist but ranking dropped them".
    // The latter is almost always a mis-seeded template with a non-NULL
    // media_profile_id when the caller has no printer/workflow binding yet.
    const { count } = await supabase
      .from('label_templates')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', input.orgId)
      .eq('template_key', input.templateKey)
      .eq('active', true);
    if ((count ?? 0) > 0) {
      return {
        success: false,
        error:
          `Label template '${input.templateKey}' exists for this organization but could not be resolved for the requested scope ` +
          `(branch=${input.branchId ?? 'none'}, media=${media?.id ?? input.mediaProfileId ?? 'none'}). ` +
          `Bind a label printer to workflow '${input.workflow ?? 'product_tag'}' in Platform → Hardware, ` +
          `or pass mediaProfileId explicitly.`,
      };
    }
    return {
      success: false,
      error: `no label template registered for key '${input.templateKey}' in this organization`,
    };
  }

  // ADR-0087 — envelope-emitting engines (ZPL, EPL) require a resolved
  // media profile. Failing loud here prevents silent unscaled prints when
  // a printer_profile.supported_media_ids array is empty and no override
  // was passed.
  if ((tpl.engine === 'zpl' || tpl.engine === 'epl') && !media) {
    return {
      success: false,
      error: `NO_MEDIA_RESOLVED: label template '${input.templateKey}' (engine=${tpl.engine}) requires a media profile, but this organization has no active media_profiles rows. Create one in Platform → Hardware → Media (or mark an existing profile as default), or pass mediaProfileId explicitly.`,
    };
  }

  // Merge lot-aware fields into vars under the standard token names.
  // Callers can still override by passing keys explicitly in `vars`.
  const mergedVars: Record<string, unknown> = {
    lot_number: input.lotNumber ?? null,
    expiry_date: input.expiryDate ?? null,
    manufacture_date: input.manufactureDate ?? null,
    hri_flag: 'N',
    ...input.vars,
  };
  // ADR-0090 — prefer the structured body_json authored in the visual
  // designer. Falls back to the legacy raw `body` string when the
  // template has not been migrated. The compiler emits {{token}}
  // placeholders so renderTemplateBody's mustache pass still runs.
  const dpi = media?.dpi ?? 203;
  const compiledSource = isLabelDoc(tpl.body_json)
    ? compileLabelDoc(tpl.body_json as LabelDoc, tpl.engine, dpi)
    : tpl.body;
  const rendered = renderTemplateBody(compiledSource, mergedVars, { dpi });

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
    // Phase 6 — the payload carries the canonical `device_assignments.id`.
    payload.deviceAssignmentId = printer.device_assignment_id;
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

  // Phase 5 Step B — dispatch through the assignment, never the bare role.
  // The workflow binding already named a `device_assignments` row; load its
  // transport so `TransportRouter` decides the IO path. Without a workflow
  // binding we fall back to the intent resolver (`resolve_device`), which
  // applies the same scope → business → default → last-seen tie-break.
  let res: DriverResult;
  if (printer) {
    const { data: row } = await supabase
      .from('device_assignments')
      .select('id, role, transport, enabled')
      .eq('id', printer.device_assignment_id)
      .maybeSingle();
    if (!row) {
      return { success: false, error: `bound printer ${printer.device_assignment_id} no longer exists` };
    }
    res = await hardwareClient.execAssignment({
      assignment: {
        id: row.id,
        role: row.role as never,
        transport: row.transport,
        enabled: row.enabled,
      },
      op: 'print_label',
      payload,
      idempotencyKey: idem,
      sourceDocType: input.sourceDocType ?? null,
      sourceDocId: input.sourceDocId ?? null,
      businessEventId: input.businessEventId ?? null,
    });
  } else {
    res = await execForIntent({
      intentOrRole: role,
      op: 'print_label',
      payload,
      organizationId: input.orgId,
      idempotencyKey: idem,
      sourceDocType: input.sourceDocType ?? null,
      sourceDocId: input.sourceDocId ?? null,
      businessEventId: input.businessEventId ?? null,
    });
  }

  return {
    ...res,
    templateResolved: { engine: tpl.engine, version: tpl.version, scope: tpl.scope },
    printerResolved: printer ? { deviceAssignmentId: printer.device_assignment_id, scope: printer.scope } : undefined,
    mediaResolved: media ? { profileId: media.id, widthMm: media.widthMm, heightMm: media.heightMm, dpi: media.dpi } : undefined,
  };
}
