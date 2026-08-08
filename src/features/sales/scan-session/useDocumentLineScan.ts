/**
 * useDocumentLineScan — the single scan→line application hook shared by every
 * Sales document form (Estimate, Proforma, Sales Order, Invoice, Credit Note,
 * Sales Return, Delivery Note).
 *
 * Before this hook existed, only the Invoice form knew how to turn a
 * `ResolvedScan` into a line, so every other document silently ignored the
 * workspace-wide scan transport. Copy-pasting the invoice's 80-line
 * `handleScanResolved` into six more files would guarantee drift, so the
 * semantics live here once:
 *
 *  - `doc_author` single-scan rule: a scan for a product ALREADY on the draft
 *    does not silently bump its quantity — it flashes the line so the operator
 *    types the intended quantity. Only new products append a line.
 *    (POS is the deliberate exception; it is a till, not a document author.)
 *  - Scan Session batches ARE authoritative: the operator reviewed the
 *    quantities, so they replace the line quantity as-is.
 *  - `verify` mode (fulfilment documents): scans never create lines. A scan
 *    ticks off a planned line, and anything the host refuses — unknown item,
 *    over-delivery beyond the ordered quantity — surfaces as a toast instead
 *    of quietly mutating the document.
 *
 * The merge/append mechanics themselves stay in `applyScanToLines`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { applyScanToLines } from "@/services/scanner/applyScanToLines";
import type { ResolvedScan } from "@/hooks/scanner";
import { computeLine } from "@/lib/invoiceLineMath";

export type ScanSessionEntry = { resolved: ResolvedScan; quantity: number };

export interface DocumentLineScanOptions<TLine> {
  /** Line-state setter of the host form. */
  setLines: React.Dispatch<React.SetStateAction<TLine[]>>;
  /** Does this line already represent the scanned product? */
  matchLine: (line: TLine, resolved: ResolvedScan) => boolean;
  /**
   * Build a new line for a product not yet on the document. Required in
   * `capture` mode; never called in `verify` mode.
   */
  buildLine?: (resolved: ResolvedScan, quantity: number, lines: TLine[]) => TLine;
  /** Trailing placeholder row that a scan should replace rather than follow. */
  isEmptyLine?: (line: TLine) => boolean;
  /**
   * Patch for a line the scan landed on. Return `null` to REFUSE the scan
   * (e.g. over-delivery); the hook then raises `rejectMessage`.
   * In `capture` mode this only runs for reviewed Scan Session batches —
   * single scans intentionally leave the line untouched.
   */
  applyToExisting: (
    line: TLine,
    quantity: number,
    resolved: ResolvedScan,
    /** `scan` = one live scan (add to what is already on the line);
     *  `session` = a reviewed batch quantity (authoritative, replaces). */
    source: "scan" | "session",
  ) => Partial<TLine> | null;
  mode?: "capture" | "verify";
  /**
   * Fulfilment forms (delivery notes / pickings) count physical units, so a
   * repeat scan SHOULD bump the line instead of only flashing it. Priced
   * author-time documents leave this off to keep `doc_author` semantics.
   */
  incrementOnSingleScan?: boolean;
  /** Message when `applyToExisting` refuses the scan. */
  rejectMessage?: (line: TLine, resolved: ResolvedScan) => string;
  /** Message when a `verify` scan matches no planned line. */
  notOnDocumentMessage?: (resolved: ResolvedScan) => string;
}

export interface DocumentLineScanApi {
  handleScanResolved: (resolved: ResolvedScan) => void;
  handleScanSessionCommit: (entries: ScanSessionEntry[]) => void;
  /** Index of the line the last scan touched — host flashes this row. */
  flashIndex: number | null;
  /** Stable ref to the latest resolver, for effects that seed buffered scans. */
  handleScanResolvedRef: React.MutableRefObject<(resolved: ResolvedScan) => void>;
}

export function useDocumentLineScan<TLine>(
  options: DocumentLineScanOptions<TLine>,
): DocumentLineScanApi {
  const {
    setLines,
    matchLine,
    buildLine,
    isEmptyLine,
    applyToExisting,
    mode = "capture",
    incrementOnSingleScan,
    rejectMessage,
    notOnDocumentMessage,
  } = options;

  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const flash = useCallback((index: number) => {
    setFlashIndex(index);
    window.setTimeout(() => setFlashIndex(null), 800);
  }, []);

  // Keep the latest callbacks in a ref so the returned handlers stay stable
  // even when the host re-creates its closures every render.
  const optsRef = useRef(options);
  useEffect(() => {
    optsRef.current = options;
  });

  const applyVerify = useCallback(
    (resolved: ResolvedScan, quantity: number, source: "scan" | "session") => {
      const o = optsRef.current;
      setLines((prev) => {
        const index = prev.findIndex((line) => o.matchLine(line, resolved));
        if (index < 0) {
          toast.error(
            o.notOnDocumentMessage?.(resolved) ??
              `${resolved.name} is not on this document`,
          );
          return prev;
        }
        const patch = o.applyToExisting(prev[index], quantity, resolved, source);
        if (patch === null) {
          toast.error(
            o.rejectMessage?.(prev[index], resolved) ??
              `${resolved.name} is already fully accounted for`,
          );
          return prev;
        }
        const next = [...prev];
        next[index] = { ...next[index], ...patch };
        flash(index);
        return next;
      });
    },
    [flash, setLines],
  );

  const applyCapture = useCallback(
    (
      resolved: ResolvedScan,
      quantity: number,
      authoritative: boolean,
      source: "scan" | "session",
    ) => {
      const o = optsRef.current;
      setLines((prev) => {
        let refused: TLine | null = null;
        const result = applyScanToLines<TLine>({
          lines: prev,
          scanQuantity: quantity,
          matchLine: (line) => o.matchLine(line, resolved),
          buildLine: (q) => {
            if (!o.buildLine) {
              throw new Error("useDocumentLineScan: buildLine is required in capture mode");
            }
            return o.buildLine(resolved, q, prev);
          },
          // doc_author intent: a single scan never silently changes an
          // existing line's quantity. A reviewed session batch does, and so
          // do fulfilment forms that opt into `incrementOnSingleScan`.
          incrementLine: (existing, q) => {
            if (!authoritative) return {};
            const patch = o.applyToExisting(existing, q, resolved, source);
            if (patch === null) {
              refused = existing;
              return {};
            }
            return patch;
          },
          replaceTrailingEmpty: !!o.isEmptyLine,
          isEmptyLine: o.isEmptyLine,
        });
        if (refused) {
          toast.error(
            o.rejectMessage?.(refused, resolved) ??
              `${resolved.name} is already fully accounted for`,
          );
          return prev;
        }
        flash(result.affectedIndex);
        return result.next;
      });
    },
    [flash, setLines],
  );

  const handleScanResolved = useCallback(
    (resolved: ResolvedScan) => {
      const quantity = resolved.scanQuantity ?? 1;
      if (mode === "verify") applyVerify(resolved, quantity, "scan");
      else applyCapture(resolved, quantity, !!incrementOnSingleScan, "scan");
    },
    [applyCapture, applyVerify, incrementOnSingleScan, mode],
  );

  const handleScanSessionCommit = useCallback(
    (entries: ScanSessionEntry[]) => {
      if (entries.length === 0) return;
      for (const { resolved, quantity } of entries) {
        if (mode === "verify") applyVerify(resolved, quantity, "session");
        else applyCapture(resolved, quantity, true, "session");
      }
    },
    [applyCapture, applyVerify, mode],
  );

  const handleScanResolvedRef = useRef(handleScanResolved);
  useEffect(() => {
    handleScanResolvedRef.current = handleScanResolved;
  }, [handleScanResolved]);

  return { handleScanResolved, handleScanSessionCommit, flashIndex, handleScanResolvedRef };
}

/**
 * The minimum priced-line contract every Sales document row satisfies
 * (Estimate, Proforma, Sales Order, Invoice, Credit Note, Sales Return).
 * Derived columns (`tax_amount`, `line_total`, `discount_percent`,
 * `sort_order`) differ per table, so they are patched only when the host's
 * row actually carries them — the tax-exclusive math contract in
 * `src/lib/invoiceLineMath.ts` stays the single source either way.
 */
export interface PricedScanLine {
  product_id?: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
}

/**
 * usePricedLineScan — `useDocumentLineScan` pre-wired for priced sales lines.
 * Hosts pass their line setter plus a `buildLine` seeder so the new row is
 * shaped exactly like the rows that form's own "Add Item" button creates.
 */
export function usePricedLineScan<TLine extends PricedScanLine>(
  setLines: React.Dispatch<React.SetStateAction<TLine[]>>,
  buildLine: (resolved: ResolvedScan, quantity: number, lines: TLine[]) => TLine,
): DocumentLineScanApi {
  return useDocumentLineScan<TLine>({
    setLines,
    matchLine: (line, resolved) => !!line.product_id && line.product_id === resolved.productId,
    buildLine,
    isEmptyLine: (line) =>
      !line.product_id &&
      !line.description &&
      (line.quantity ?? 0) <= 1 &&
      (line.unit_price ?? 0) === 0,
    applyToExisting: (line, quantity) => {
      const patch: Record<string, unknown> = { quantity };
      const row = line as unknown as Record<string, unknown>;
      if ("line_total" in row || "tax_amount" in row) {
        const { line_total, tax_amount } = computeLine({
          quantity,
          unit_price: line.unit_price,
          discount_percent: Number(row.discount_percent ?? 0),
          tax_rate: line.tax_rate,
        });
        if ("line_total" in row) patch.line_total = line_total;
        if ("tax_amount" in row) patch.tax_amount = tax_amount;
      }
      return patch as Partial<TLine>;
    },
  });
}

/**
 * scanUnitPrice / scanTaxRate — one place to read the price and tax a scan
 * carries (weighted-EAN embedded price wins over the product's list price).
 */
export function scanUnitPrice(resolved: ResolvedScan): number {
  return resolved.embeddedPrice ?? resolved.sellingPrice ?? 0;
}

export function scanTaxRate(resolved: ResolvedScan): number {
  return resolved.taxRate ?? 0;
}

/**
 * scanCostPrice — purchasing counterpart of `scanUnitPrice`. Buying documents
 * seed the line from the product's cost, never its selling price. Any
 * vendor-specific price list still overrides this afterwards through the
 * host form's own pricing logic — the scanner never prices a line itself.
 */
export function scanCostPrice(resolved: ResolvedScan): number {
  return resolved.costPrice ?? 0;
}
