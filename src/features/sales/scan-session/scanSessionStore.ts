/**
 * scanSessionStore — the pure state machine behind Sales Scan Session.
 *
 * No React, no DOM, no Supabase: a resolved scan goes in, a reviewed
 * picking list comes out. Every behaviour an operator depends on
 * (merge-on-repeat, explicit quantity edits, undo, unknown-code queue,
 * level-aware quantities) is decided here so it can be unit-tested and
 * cannot drift between surfaces.
 *
 * Quantity contract: `ResolvedScan.scanQuantity` already carries the
 * level-aware amount (a case identifier resolves to `qty_in_base_uom`
 * base units, a weighted EAN to its embedded quantity). The session adds
 * that number — it never assumes 1.
 */
import type { ResolvedScan } from "@/hooks/scanner";

export interface ScanSessionLine {
  productId: string;
  name: string;
  sku: string | null;
  unitPrice: number;
  /** Total quantity in the product's base unit of measure. */
  quantity: number;
  /** How many physical scans produced this line. */
  scans: number;
  /** Label for the last scanned level, e.g. "Case of 12". Null for a bare unit. */
  levelLabel: string | null;
  lastScanAt: number;
  /** Kept so committing to a document needs no second lookup. */
  resolved: ResolvedScan;
}

export interface UnknownScan {
  code: string;
  reason: string;
  count: number;
  at: number;
}

export interface ScanSessionState {
  lines: ScanSessionLine[];
  unknown: UnknownScan[];
  /** Bounded undo stack of prior snapshots (most recent last). */
  past: Array<{ lines: ScanSessionLine[]; unknown: UnknownScan[] }>;
}

export type ScanSessionAction =
  | { type: "resolved"; resolved: ResolvedScan; at?: number }
  | { type: "unknown"; code: string; reason: string; at?: number }
  | { type: "setQuantity"; productId: string; quantity: number }
  | { type: "remove"; productId: string }
  | { type: "dismissUnknown"; code: string }
  | { type: "undo" }
  | { type: "clear" }
  | { type: "hydrate"; lines: ScanSessionLine[]; unknown: UnknownScan[] };

const UNDO_DEPTH = 25;

export const emptyScanSession: ScanSessionState = { lines: [], unknown: [], past: [] };

function levelLabel(resolved: ResolvedScan): string | null {
  if (resolved.packagingId && resolved.scanQuantity > 1) {
    return `Pack of ${resolved.scanQuantity}`;
  }
  if (resolved.isWeighted) return "Weighed";
  return null;
}

function pushHistory(state: ScanSessionState): ScanSessionState["past"] {
  const next = [...state.past, { lines: state.lines, unknown: state.unknown }];
  return next.length > UNDO_DEPTH ? next.slice(next.length - UNDO_DEPTH) : next;
}

export function scanSessionReducer(
  state: ScanSessionState,
  action: ScanSessionAction,
): ScanSessionState {
  switch (action.type) {
    case "resolved": {
      const at = action.at ?? Date.now();
      const qty = Number(action.resolved.scanQuantity) || 1;
      const idx = state.lines.findIndex((l) => l.productId === action.resolved.productId);
      const past = pushHistory(state);
      if (idx >= 0) {
        const lines = state.lines.slice();
        const existing = lines[idx];
        lines[idx] = {
          ...existing,
          quantity: existing.quantity + qty,
          scans: existing.scans + 1,
          levelLabel: levelLabel(action.resolved) ?? existing.levelLabel,
          lastScanAt: at,
          resolved: action.resolved,
        };
        // Newest activity first — the operator's eye stays at the top.
        const [moved] = lines.splice(idx, 1);
        return { lines: [moved, ...lines], unknown: state.unknown, past };
      }
      const line: ScanSessionLine = {
        productId: action.resolved.productId,
        name: action.resolved.name,
        sku: action.resolved.sku,
        unitPrice: action.resolved.embeddedPrice ?? action.resolved.sellingPrice,
        quantity: qty,
        scans: 1,
        levelLabel: levelLabel(action.resolved),
        lastScanAt: at,
        resolved: action.resolved,
      };
      return { lines: [line, ...state.lines], unknown: state.unknown, past };
    }
    case "unknown": {
      const at = action.at ?? Date.now();
      const code = action.code.trim();
      if (!code) return state;
      const idx = state.unknown.findIndex((u) => u.code === code);
      if (idx >= 0) {
        const unknown = state.unknown.slice();
        unknown[idx] = { ...unknown[idx], count: unknown[idx].count + 1, at, reason: action.reason };
        return { ...state, unknown };
      }
      return {
        ...state,
        unknown: [{ code, reason: action.reason, count: 1, at }, ...state.unknown].slice(0, 25),
      };
    }
    case "setQuantity": {
      const idx = state.lines.findIndex((l) => l.productId === action.productId);
      if (idx < 0) return state;
      const qty = Number(action.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return {
          lines: state.lines.filter((l) => l.productId !== action.productId),
          unknown: state.unknown,
          past: pushHistory(state),
        };
      }
      const lines = state.lines.slice();
      lines[idx] = { ...lines[idx], quantity: qty };
      return { lines, unknown: state.unknown, past: pushHistory(state) };
    }
    case "remove":
      if (!state.lines.some((l) => l.productId === action.productId)) return state;
      return {
        lines: state.lines.filter((l) => l.productId !== action.productId),
        unknown: state.unknown,
        past: pushHistory(state),
      };
    case "dismissUnknown":
      return { ...state, unknown: state.unknown.filter((u) => u.code !== action.code) };
    case "undo": {
      if (state.past.length === 0) return state;
      const past = state.past.slice();
      const prev = past.pop()!;
      return { lines: prev.lines, unknown: prev.unknown, past };
    }
    case "clear":
      return emptyScanSession;
    case "hydrate":
      return { lines: action.lines, unknown: action.unknown, past: [] };
    default:
      return state;
  }
}

export interface ScanSessionTotals {
  lineCount: number;
  unitCount: number;
  value: number;
}

export function scanSessionTotals(state: ScanSessionState): ScanSessionTotals {
  return state.lines.reduce<ScanSessionTotals>(
    (acc, l) => ({
      lineCount: acc.lineCount + 1,
      unitCount: acc.unitCount + l.quantity,
      value: acc.value + l.quantity * l.unitPrice,
    }),
    { lineCount: 0, unitCount: 0, value: 0 },
  );
}

/** Entries handed to a document (invoice draft) on commit. */
export function scanSessionCommitEntries(state: ScanSessionState) {
  // Oldest scan first so line order matches the order things were picked.
  return state.lines
    .slice()
    .sort((a, b) => a.lastScanAt - b.lastScanAt)
    .map((l) => ({ resolved: l.resolved, quantity: l.quantity }));
}

export function scanSessionStorageKey(
  businessId: string | null | undefined,
  userId: string | null | undefined,
): string {
  return `sales.scan.session:${businessId ?? "_"}:${userId ?? "_"}`;
}

export function serializeScanSession(state: ScanSessionState): string {
  return JSON.stringify({ lines: state.lines, unknown: state.unknown, v: 1 });
}

export function deserializeScanSession(raw: string | null): {
  lines: ScanSessionLine[];
  unknown: UnknownScan[];
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { lines?: unknown; unknown?: unknown };
    const lines = Array.isArray(parsed.lines) ? (parsed.lines as ScanSessionLine[]) : [];
    const unknown = Array.isArray(parsed.unknown) ? (parsed.unknown as UnknownScan[]) : [];
    const valid = lines.filter(
      (l) => !!l && typeof l.productId === "string" && Number.isFinite(Number(l.quantity)) && !!l.resolved,
    );
    if (valid.length === 0 && unknown.length === 0) return null;
    return { lines: valid, unknown };
  } catch {
    return null;
  }
}
