/**
 * WMS operation result contract.
 *
 * Every mutating warehouse operation is a guarded server call: the FSMs
 * (`wms_transition_manifest`, `wms_transition_wave`, `wms_lpn_*`) and the
 * replay dispatcher reject illegal work by RAISEing a coded exception.
 * PostgREST hands that back as a plain object — NOT an `Error` — which is
 * why `String(e)` printed `[object Object]` on the floor and why the
 * `WMS_SCAN_SHORTAGE` / row-version branches that tested `instanceof Error`
 * never fired: a real business-rule rejection was displayed as meaningless
 * text and the guard silently fell through.
 *
 * This module is the single translation point. It classifies a failure into
 * a closed outcome set, maps the server's own code to shop-floor copy, and
 * preserves the raw error for logging. It creates no new engine: unmapped
 * infrastructure failures fall through to the shared `normalizeError`
 * (`@/services/resilience`), which already owns offline/auth/permission copy.
 */
import { normalizeError } from "@/services/resilience";

/** What kind of "no" the server said. */
export type WmsFailureKind =
  | "business_rule"
  | "concurrency"
  | "authorization"
  | "validation"
  | "system";

export interface WmsFailure {
  kind: WmsFailureKind;
  /** The server's own code when it raised one (`WMS_SCAN_SHORTAGE`, …). */
  code: string | null;
  /** Shop-floor copy. Never raw SQL/SQLSTATE text. */
  message: string;
  /** Optional second line with the operator's next step. */
  description?: string;
  /** Whether repeating the identical request could succeed. */
  retryable: boolean;
  /** Original error, for logs only. Do not render. */
  cause: unknown;
}

interface Copy {
  kind: WmsFailureKind;
  message: string;
  description?: string;
  retryable?: boolean;
}

/**
 * Coded rejections raised by the WMS routines themselves. Keys are the exact
 * literals the database raises; keep this table in step with the SQL.
 */
const CODED: Record<string, Copy> = {
  WMS_SCAN_SHORTAGE: {
    kind: "business_rule",
    message: "Sealed cartons are missing from this manifest.",
    description: "Load every sealed carton for this wave and sales order before continuing.",
  },
  WMS_PROOF_REQUIRED: {
    kind: "business_rule",
    message: "This warehouse requires proof of dispatch before departure.",
    description: "Capture the seal number and the driver's signature, then dispatch.",
  },
  WMS_NO_CARRIER: {
    kind: "business_rule",
    message: "This load has no carrier assigned.",
    description: "Assign a carrier and service before dispatching.",
  },
  WMS_MANIFEST_CUSTOMER_MISMATCH: {
    kind: "business_rule",
    message: "That carton belongs to a different customer's delivery.",
    description: "This manifest is already committed to another delivery note.",
  },
  WMS_PACK_CARTON_SEALED: {
    kind: "business_rule",
    message: "That carton is already sealed and can no longer be changed.",
  },
  WMS_PACK_CARTON_NOT_FOUND: {
    kind: "business_rule",
    message: "That carton no longer exists.",
  },
  WMS_LPN_NOT_FOUND: {
    kind: "business_rule",
    message: "That licence plate could not be found.",
  },
  WMS_LPN_OVER_CAPACITY: {
    kind: "business_rule",
    message: "That container would go over its weight capacity.",
  },
  WMS_LPN_VERSION_CONFLICT: {
    kind: "concurrency",
    message: "Someone else just changed this licence plate.",
    description: "Refresh and try again.",
  },
  WMS_STAGING_UNRELIEVED_BALANCE: {
    kind: "business_rule",
    message: "Stock is still sitting in staging for this load.",
    description: "Resolve the staging balance before closing the load out.",
  },
  WMS_STAGING_NO_DEFAULT_LOCATION: {
    kind: "business_rule",
    message: "This warehouse has no staging location configured.",
  },
  WMS_EVIDENCE_REQUIRED: {
    kind: "validation",
    message: "Evidence is required before this can be recorded.",
  },
  WMS_RESOLUTION_KIND_REQUIRED: {
    kind: "validation",
    message: "Choose how this exception was resolved.",
  },
  WMS_RESOLUTION_NOTES_REQUIRED: {
    kind: "validation",
    message: "Add a note explaining how this exception was resolved.",
  },
  WMS_EXCEPTION_CLOSED: {
    kind: "business_rule",
    message: "That exception has already been resolved.",
  },
  WMS_PUTAWAY_NO_LPN: {
    kind: "business_rule",
    message: "Put-away needs a licence plate to move.",
  },
  WMS_BAD_SERVICE: {
    kind: "validation",
    message: "That carrier service is not valid for this carrier.",
  },
  WMS_SSCC_NOT_FOUND: { kind: "business_rule", message: "That SSCC is not known to this warehouse." },
  WMS_SSCC_VOIDED: { kind: "business_rule", message: "That SSCC has been voided." },
  WMS_SSCC_REPRINT_REASON_REQUIRED: {
    kind: "validation",
    message: "Give a reason before reprinting this label.",
  },
  WMS_PACKAGING_NOT_FOUND: { kind: "validation", message: "That packaging level is not configured." },
  WMS_PACKAGING_INVALID: { kind: "validation", message: "That packaging level cannot be used here." },
  WMS_PACKAGING_MISMATCH: { kind: "validation", message: "That packaging does not match the product." },
  WMS_PACKAGING_RETIRED: { kind: "validation", message: "That packaging level has been retired." },
  WMS_PKG_STALE: {
    kind: "concurrency",
    message: "Someone else just changed this packaging record.",
    description: "Refresh and try again.",
  },
  WMS_PKG_IN_USE: { kind: "business_rule", message: "That packaging type is in use and cannot be removed." },
  WMS_PKG_NOT_FOUND: { kind: "business_rule", message: "That packaging type no longer exists." },
  WMS_PKG_NOT_USABLE: { kind: "business_rule", message: "That packaging type cannot be used here." },
  WMS_PKG_FORBIDDEN: { kind: "authorization", message: "You cannot change packaging for this warehouse." },
  WMS_PKG_AUTH: { kind: "authorization", message: "You are not signed in to this warehouse." },
  WMS_FORBIDDEN: { kind: "authorization", message: "You do not have access to this warehouse operation." },
  WMS_COUNT_EMPTY_SCOPE: { kind: "validation", message: "That count covers nothing to count." },
  WMS_COUNT_INVALID_SCOPE: { kind: "validation", message: "That count scope is not valid." },
  WMS_REPLAY_BAD_RPC: {
    kind: "system",
    message: "This action could not be sent to the server.",
    retryable: false,
  },
  WMS_REPLAY_UNSUPPORTED_RPC: {
    kind: "system",
    message: "This action is not available on this device.",
    retryable: false,
  },
};

/** Uncoded rejections raised as plain text by older guards. */
const TEXTUAL: Array<[RegExp, Copy]> = [
  [/row version mismatch|row_version|_stale\b|version_required/i, {
    kind: "concurrency",
    message: "Someone else just updated this record.",
    description: "Refresh and try again.",
  }],
  [/not authori[sz]ed|permission denied|access denied|not a member/i, {
    kind: "authorization",
    message: "You do not have permission to perform this action.",
  }],
  [/invalid transition|cannot transition|illegal state/i, {
    kind: "business_rule",
    message: "That step is not allowed from the current state.",
    description: "Refresh the record — the floor may have moved it on already.",
  }],
];

function rawText(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e !== "object" || e === null) return "";
  const o = e as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
  return [o.message, o.details, o.hint, o.code]
    .filter((v) => typeof v === "string")
    .join(" | ");
}

/** The `WMS_*` literal the server raised, if any. */
export function wmsErrorCode(e: unknown): string | null {
  const match = /WMS_[A-Z_]+/.exec(rawText(e));
  return match ? match[0] : null;
}

/**
 * Classify any thrown value from a warehouse RPC into a typed failure.
 * Never returns raw server text as the user-facing message.
 */
export function toWmsFailure(e: unknown, fallback = "That action could not be completed"): WmsFailure {
  const code = wmsErrorCode(e);
  if (code && CODED[code]) {
    const copy = CODED[code];
    return {
      kind: copy.kind,
      code,
      message: copy.message,
      ...(copy.description ? { description: copy.description } : {}),
      retryable: copy.retryable ?? false,
      cause: e,
    };
  }

  const text = rawText(e);
  for (const [pattern, copy] of TEXTUAL) {
    if (pattern.test(text)) {
      return {
        kind: copy.kind,
        code,
        message: copy.message,
        ...(copy.description ? { description: copy.description } : {}),
        retryable: copy.retryable ?? false,
        cause: e,
      };
    }
  }

  // Infrastructure failure — the shared normalizer already owns this copy.
  const normalized = normalizeError(e);
  const kind: WmsFailureKind =
    normalized.kind === "permission_denied" || normalized.kind === "auth_expired" || normalized.kind === "auth_invalid"
      ? "authorization"
      : normalized.kind === "validation"
        ? "validation"
        : normalized.kind === "conflict"
          ? "concurrency"
          : "system";
  return {
    kind,
    code,
    message: normalized.kind === "unknown" ? fallback : normalized.message,
    description: normalized.action,
    retryable: normalized.retryable,
    cause: e,
  };
}

/** Convenience for `toast.error(...)` call sites. */
export function wmsErrorToast(
  e: unknown,
  fallback?: string,
): [string, { description?: string }] {
  const failure = toWmsFailure(e, fallback);
  return [
    failure.message,
    failure.description ? { description: failure.description } : {},
  ];
}

/**
 * A PostgREST rejection re-thrown as a real `Error`.
 *
 * Supabase returns `{ message, details, hint, code }` — a plain object. Any
 * handler doing `String(e)` or `e instanceof Error ? … : …` on that printed
 * `[object Object]`. Guarded WMS calls throw this instead: same fields, but
 * an `Error`, so every downstream handler behaves and `toWmsFailure` can
 * still read the coded rejection out of it.
 */
export class WmsRpcError extends Error {
  readonly rpc: string;
  readonly code: string | null;
  readonly details: string | null;
  readonly hint: string | null;

  constructor(rpc: string, source: unknown) {
    const o = (typeof source === "object" && source !== null ? source : {}) as {
      message?: unknown; details?: unknown; hint?: unknown; code?: unknown;
    };
    const text = typeof o.message === "string" && o.message ? o.message : String(source ?? "");
    super(text);
    this.name = "WmsRpcError";
    this.rpc = rpc;
    this.code = typeof o.code === "string" ? o.code : null;
    this.details = typeof o.details === "string" ? o.details : null;
    this.hint = typeof o.hint === "string" ? o.hint : null;
  }
}
