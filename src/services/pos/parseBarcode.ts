/**
 * Pure barcode payload parser. No DOM, no React, no Supabase — fully unit
 * testable.
 *
 * Today: Odoo `n*<code>` qty prefix. Extension hook: GS1 AI codes
 * (FNC1-delimited or parenthesised), weighted EAN-13 detection (deferred to
 * the server RPC where per-business prefix rules live).
 */

export interface ParsedScan {
  /** Bare code without any qty/weight wrapper. */
  code: string;
  /** Inferred quantity from client-side parseable wrappers. Default 1. */
  quantity: number;
}

/**
 * Parse a raw scanner payload.
 *
 * - `3*1234567` → { code: "1234567", quantity: 3 }
 * - `1234567`   → { code: "1234567", quantity: 1 }
 *
 * GS1/weighted parsing intentionally lives on the server (per-business
 * `pos_barcode_rules` table). Keeping the client parser minimal avoids
 * configuration drift between cashier devices.
 */
export function parseScanPayload(raw: string): ParsedScan {
  const trimmed = (raw || "").trim();
  const m = trimmed.match(/^(\d{1,4})\*(.+)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 9999) {
      return { code: m[2], quantity: n };
    }
  }
  return { code: trimmed, quantity: 1 };
}
