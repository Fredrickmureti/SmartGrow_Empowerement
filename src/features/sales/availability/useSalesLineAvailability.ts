/**
 * useSalesLineAvailability — the ONE way a Sales editor asks
 * "can these lines be fulfilled?".
 *
 * Before Phase 5 this logic existed only inside `InvoiceCreatePage` and
 * `InvoiceEditPage`, copy-pasted between them; Sales Orders, Delivery Notes,
 * Estimates and Proformas let an operator commit quantities blind. Every
 * editor now funnels through this hook, so the badge the operator reads, the
 * summary they confirm and the value the submit guard tests are, by
 * construction, the same number.
 *
 * CONTRACTS
 *  - The number is server-owned (ADR 0142). This hook only *reads*
 *    `product.available`, which `useBranchScopedProducts` fetches from
 *    `list_products_with_branch_stock` → `resolve_stock_availability_batch`.
 *    It never derives availability from `quantity - reserved`.
 *  - `line.quantity` is ALWAYS base units (Phase 3 quantity contract), and
 *    `available` is base units too, so the comparison is unit-correct for
 *    packaged and alternate-UoM lines.
 *  - Whether a shortfall blocks is a commercial policy, not a stock fact —
 *    see `salesStockPolicy.ts`.
 */
import { useCallback, useMemo, useState } from "react";
import {
  evaluateStock,
  type StockEvalResult,
} from "@/components/inventory/StockAvailabilityIndicator";
import {
  SALES_DOCUMENT_LABEL,
  stockPolicyFor,
  type SalesDocumentKind,
  type SalesStockPolicy,
} from "./salesStockPolicy";

/** The product fields the check needs — satisfied by `BranchScopedProduct`. */
export interface AvailabilityProduct {
  id: string;
  name: string;
  type?: string | null;
  track_inventory?: boolean | null;
  reorder_level?: number | null;
  /** Server-resolved, branch-scoped availability in base units. */
  available?: number | null;
  /** Legacy fallback for callers not yet on the branch-scoped list. */
  stock_quantity?: number | null;
}

/** The line fields the check needs. */
export interface AvailabilityLine {
  product_id?: string | null;
  /** Base units — never the display/pack quantity. */
  quantity: number;
}

export interface LineStockEval {
  index: number;
  product: AvailabilityProduct;
  result: StockEvalResult;
}

export interface SalesLineAvailability {
  policy: SalesStockPolicy;
  /** Per-line evaluation, index-aligned with the lines passed in. */
  evals: Array<LineStockEval | null>;
  /** Only the lines whose requested quantity exceeds availability. */
  oversoldLines: LineStockEval[];
  hasOversell: boolean;
  /** True when policy is `commit` and at least one line is short. */
  requiresConfirmation: boolean;
  confirmed: boolean;
  setConfirmed: (value: boolean) => void;
  /**
   * Call at the top of submit. Returns an operator-facing message when the
   * document must not be saved yet, or `null` when it may proceed.
   */
  blockingReason: () => string | null;
  /** Convenience for submit handlers that throw. */
  assertSellable: () => void;
}

interface Args {
  kind: SalesDocumentKind;
  lines: AvailabilityLine[];
  products: AvailabilityProduct[];
  /** e.g. "Nairobi branch" — quoted back in the blocking message. */
  scopeLabel?: string;
}

export function useSalesLineAvailability({
  kind,
  lines,
  products,
  scopeLabel,
}: Args): SalesLineAvailability {
  const [confirmed, setConfirmed] = useState(false);
  const policy = stockPolicyFor(kind);

  const evals = useMemo<Array<LineStockEval | null>>(() => {
    if (policy === "none") return lines.map(() => null);
    return lines.map((line, index) => {
      const product = line.product_id
        ? products.find((p) => p.id === line.product_id)
        : undefined;
      if (!product) return null;
      const result = evaluateStock({
        trackInventory: product.track_inventory,
        productType: product.type,
        onHand: product.available ?? product.stock_quantity ?? 0,
        reorderLevel: product.reorder_level,
        requestedQty: line.quantity,
      });
      if (result.status === "untracked") return null;
      return { index, product, result };
    });
  }, [policy, lines, products]);

  const oversoldLines = useMemo(
    () =>
      evals.filter(
        (e): e is LineStockEval =>
          !!e && (e.result.status === "exceeded" || e.result.status === "out"),
      ),
    [evals],
  );

  const hasOversell = oversoldLines.length > 0;
  const requiresConfirmation = policy === "commit" && hasOversell;

  const blockingReason = useCallback(() => {
    if (!requiresConfirmation || confirmed) return null;
    const where = scopeLabel ? ` in ${scopeLabel}` : "";
    return `One or more lines exceed available stock${where}. Tick the oversell confirmation to proceed with this ${SALES_DOCUMENT_LABEL[kind]}.`;
  }, [requiresConfirmation, confirmed, scopeLabel, kind]);

  const assertSellable = useCallback(() => {
    const reason = blockingReason();
    if (reason) throw new Error(reason);
  }, [blockingReason]);

  return {
    policy,
    evals,
    oversoldLines,
    hasOversell,
    requiresConfirmation,
    confirmed,
    setConfirmed,
    blockingReason,
    assertSellable,
  };
}
