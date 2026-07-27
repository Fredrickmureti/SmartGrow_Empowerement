/**
 * Print policy resolver — Stage P4 (ADR-0008).
 *
 * Resolves the effective paper format and render mode for a given
 * (business, branch, document_type) tuple, with safe fallback to A4 PDF
 * when no policy row exists.
 *
 * Resolution order:
 *   1. Explicit override passed by the caller (request body)
 *   2. Branch-specific policy row
 *   3. Business-wide policy row (branch_id IS NULL)
 *   4. System default { paper_format: 'a4', render_mode: 'pdf' }
 *
 * Never throws — any DB error degrades to the system default so a
 * misconfigured policy can never break document generation.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// Re-export pure coercion helpers from coercePolicy.ts so callers continue
// to import everything from this module, and the Vitest architecture
// guard can import the pure file directly without dragging in the Deno
// `https://esm.sh/...` Supabase client import.
export {
  THERMAL_PAPER,
  PRINTABLE_PAPER,
  coercePaperRenderMode,
  type PaperFormat,
  type RenderMode,
  type CoercedPolicy,
} from "./coercePolicy.ts";
import type { PaperFormat, RenderMode } from "./coercePolicy.ts";

export interface ResolvedPolicy {
  paper_format: PaperFormat;
  render_mode: RenderMode;
  /**
   * Canonical device pin. When set, downstream generators dispatch to this
   * `device_assignments.id` directly.
   */
  device_assignment_id: string | null;
  /**
   * Role-only routing hint. When `device_assignment_id` is not set,
   * generators call `resolve_device` with the role derived from this
   * intent (see `intentToRole.ts`).
   */
  intent: string | null;
  auto_print: boolean;
  source: "override" | "branch" | "business" | "default";
}

export interface PolicyOverride {
  paperFormat?: PaperFormat;
  renderMode?: RenderMode;
  deviceAssignmentId?: string | null;
}

const SYSTEM_DEFAULT: Omit<ResolvedPolicy, "source"> = {
  paper_format: "a4",
  render_mode: "pdf",
  device_assignment_id: null,
  intent: null,
  auto_print: false,
};


export async function resolvePrintPolicy(
  supabase: SupabaseClient,
  args: {
    businessId: string | null;
    branchId?: string | null;
    documentType: string;
    override?: PolicyOverride;
  }
): Promise<ResolvedPolicy> {
  const { businessId, branchId, documentType, override } = args;

  // 1. Caller override always wins (preserves Stage P3 behaviour).
  if (override?.paperFormat || override?.renderMode || override?.deviceAssignmentId !== undefined) {
    return {
      paper_format: (override.paperFormat ?? SYSTEM_DEFAULT.paper_format) as PaperFormat,
      render_mode: (override.renderMode ?? SYSTEM_DEFAULT.render_mode) as RenderMode,
      device_assignment_id: override.deviceAssignmentId ?? null,
      intent: null,
      auto_print: false,
      source: "override",
    };
  }

  if (!businessId) {
    return { ...SYSTEM_DEFAULT, source: "default" };
  }

  try {
    const { data, error } = await supabase
      .from("document_print_policies")
      .select(
        "paper_format, render_mode, device_assignment_id, intent, auto_print, branch_id",
      )
      .eq("business_id", businessId)
      .eq("document_type", documentType)
      .or(branchId ? `branch_id.eq.${branchId},branch_id.is.null` : "branch_id.is.null");

    if (error || !data || data.length === 0) {
      return { ...SYSTEM_DEFAULT, source: "default" };
    }

    // Prefer branch-specific row over business-wide row.
    const branchRow = branchId ? data.find((r) => r.branch_id === branchId) : null;
    const row = branchRow ?? data.find((r) => r.branch_id === null) ?? null;

    if (!row) return { ...SYSTEM_DEFAULT, source: "default" };

    return {
      paper_format: (row.paper_format as PaperFormat) ?? SYSTEM_DEFAULT.paper_format,
      render_mode: (row.render_mode as RenderMode) ?? SYSTEM_DEFAULT.render_mode,
      device_assignment_id: (row as { device_assignment_id?: string | null }).device_assignment_id ?? null,
      intent: (row as { intent?: string | null }).intent ?? null,
      auto_print: !!row.auto_print,
      source: branchRow ? "branch" : "business",
    };

  } catch (_err) {
    return { ...SYSTEM_DEFAULT, source: "default" };
  }
}
