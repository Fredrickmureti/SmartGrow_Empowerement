/**
 * POS Error Channel — single funnel for cashier-facing errors.
 *
 * Stage I (H5). Every RPC/hardware/render failure on the POS terminal
 * should flow through `reportPOSError(...)`. The channel:
 *  - maps the failure to one of three cashier actions (try_again / call_manager / hardware_offline)
 *  - plays an "error" sound cue (existing pos sound system)
 *  - persists the row server-side via `log_pos_error` RPC (best-effort, fire-and-forget)
 *  - emits a window event the `POSErrorBoundary` listens to in order to render UI
 *
 * No raw Postgres / fetch error messages should ever reach the cashier toast.
 */
import { supabase } from "@/integrations/supabase/client";
import { playPOSSound } from "@/lib/pos/sounds";

export type POSErrorKind =
  | "render"
  | "rpc"
  | "hardware"
  | "network"
  | "validation"
  | "permission"
  | "unknown";

export type POSErrorAction = "try_again" | "call_manager" | "hardware_offline";

export interface POSErrorReport {
  kind: POSErrorKind;
  message?: string;
  detail?: unknown;
  /** Context for server-side log + later support triage. */
  registerId?: string;
  shiftId?: string;
  businessId?: string;
  severity?: "warn" | "error" | "fatal";
}

export interface POSErrorEventDetail extends POSErrorReport {
  action: POSErrorAction;
  cashierMessage: string;
  at: number;
}

export const POS_ERROR_EVENT = "pos:error";

/** Map a kind/severity to the cashier-facing action + message. */
export function mapPOSError(report: POSErrorReport): {
  action: POSErrorAction;
  cashierMessage: string;
} {
  switch (report.kind) {
    case "permission":
      return {
        action: "call_manager",
        cashierMessage: "This action needs a manager. Please call a supervisor.",
      };
    case "hardware":
      return {
        action: "hardware_offline",
        cashierMessage: "A device is offline. Sale was not affected.",
      };
    case "validation":
      return {
        action: "try_again",
        cashierMessage: "That doesn't look right. Check the entry and try again.",
      };
    case "network":
      return {
        action: "try_again",
        cashierMessage: "Network is slow. We'll retry when it's back.",
      };
    case "rpc":
    case "render":
    case "unknown":
    default:
      return report.severity === "fatal"
        ? { action: "call_manager", cashierMessage: "Something went wrong. Please call a supervisor." }
        : { action: "try_again", cashierMessage: "Something went wrong. Please try again." };
  }
}

/** Best-effort persistence — never throws, never blocks the UI. */
async function persistError(report: POSErrorReport): Promise<void> {
  if (!report.businessId) return;
  try {
    await supabase.rpc("log_pos_error" as any, {
      p_business_id: report.businessId,
      p_kind: report.kind,
      p_message: report.message ?? null,
      p_detail: (report.detail ?? null) as any,
      p_register_id: report.registerId ?? null,
      p_shift_id: report.shiftId ?? null,
      p_severity: report.severity ?? "error",
      p_user_agent:
        typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 500) : null,
    });
  } catch {
    // Swallow — the cashier already has UX feedback.
  }
}

export function reportPOSError(report: POSErrorReport): POSErrorEventDetail {
  const mapped = mapPOSError(report);
  const detail: POSErrorEventDetail = { ...report, ...mapped, at: Date.now() };

  // 1. Sound cue (no-op if sound disabled by user)
  try {
    playPOSSound("error");
  } catch {
    /* ignore */
  }

  // 2. Tell the boundary
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(POS_ERROR_EVENT, { detail }));
  }

  // 3. Persist server-side (fire-and-forget)
  void persistError(report);

  return detail;
}
