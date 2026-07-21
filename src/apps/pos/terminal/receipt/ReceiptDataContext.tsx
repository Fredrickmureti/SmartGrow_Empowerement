/**
 * ReceiptDataContext — workstation-scoped store for the completed
 * transaction and resolved print policy that the receipt phase needs.
 *
 * Step 3 Slice C.1 (Phase B in `.lovable/plan.md`).
 *
 * Why this exists:
 *   Slice B left `PostPaymentSurface` as the shared workstation surface
 *   for both `ReceiptWorkspace` (active receipt) and `HistoryWorkspace`
 *   (reprint). Slice C's goal is to make `/pos/terminal/:id/receipt` a
 *   route-owned sibling that mounts `ReceiptWorkspace` directly — not
 *   through the `POSTerminal` monolith. Doing that requires the
 *   completed transaction snapshot and resolved `PrintPolicyHint` to
 *   live somewhere the route sibling can read WITHOUT `POSTerminal`
 *   being on screen.
 *
 * Contract:
 *   - Provider is mounted by `TerminalShell` so every child of
 *     `/pos/terminal/:registerId/*` can consume it (including the
 *     future route-owned `ReceiptRoute`).
 *   - `transaction` is the completed transaction payload every receipt
 *     surface (`ReceiptPreviewBody`, `PostPaymentSurface`) consumes.
 *     Its shape is a superset compatible with `LiveTransactionInput`
 *     AND `ReceiptPreviewTransaction` so both `ReceiptWorkspace` and
 *     `ReceiptPreviewSheet` can accept it without casts. Nullable —
 *     nothing is completed yet.
 *   - `setTransaction` is the *only* mutator; `POSTerminal` (until
 *     Step 6 finishes decomposition) writes to it after tender
 *     completion and clears it on `newSale`.
 *   - `policy` is the stable `PrintPolicyHint` resolved from the
 *     tenant's document print policy + bound device. Computed HERE so
 *     the receipt route doesn't have to duplicate the hook wiring.
 *
 * Non-goals (Slice C.1):
 *   - Does NOT swap the receipt route to a route-owned element yet
 *     (that is Slice C.2). This slice only relocates receipt state
 *     ownership so the route swap becomes a mechanical change.
 *   - Does NOT alter cart, shift, or hardware state — those still
 *     live in their existing hooks.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useResolvedPrintPolicyWithDevice } from "@/hooks/useDocumentPrintPolicies";
import type { PrintPolicyHint } from "./PostPaymentSurface";

/**
 * Superset of the two downstream receipt-transaction contracts
 * (`LiveTransactionInput` for `PostPaymentSurface` / `ReceiptWorkspace`,
 * and `ReceiptPreviewTransaction` for `ReceiptPreviewSheet`). Kept
 * inline here — not in the receipt document model — because it is a
 * *terminal* payload owned by the sale/tender pipeline; the document
 * model stays a pure UI/render contract.
 */
export interface CompletedPOSTransaction {
  id: string;
  transaction_number: string;
  total_amount: number;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  created_at: string;
  customer_name?: string;
  cashier_name?: string;
  register_id?: string;
  invoice_id?: string | null;
  invoice_number?: string | null;
  etims_cu_number?: string | null;
  etims_qr_data?: string | null;
  payment_method?: string;
  is_voided?: boolean;
  is_refund?: boolean;
  original_transaction_number?: string | null;
  items: Array<{
    product_name: string;
    sku?: string;
    quantity: number;
    unit_price: number;
    discount_amount?: number;
    line_total: number;
    display_quantity?: number | null;
    packaging_label?: string | null;
  }>;
  payments: Array<{
    payment_method: string;
    amount: number;
    tendered_amount?: number;
    change_given?: number;
    reference?: string;
  }>;
}

interface ReceiptDataContextValue {
  transaction: CompletedPOSTransaction | null;
  setTransaction: (t: CompletedPOSTransaction | null) => void;
  policy: PrintPolicyHint;
}

const ReceiptDataContext = createContext<ReceiptDataContextValue | null>(null);

interface ReceiptDataProviderProps {
  businessId: string | undefined;
  branchId: string | null | undefined;
  children: ReactNode;
}

export function ReceiptDataProvider({ businessId, branchId, children }: ReceiptDataProviderProps) {
  const [transaction, setTransactionState] = useState<CompletedPOSTransaction | null>(null);

  const { policy: posReceiptPolicy, device: posReceiptDevice } =
    useResolvedPrintPolicyWithDevice(businessId, branchId ?? null, "pos_receipt");

  const policy = useMemo<PrintPolicyHint>(
    () => ({
      auto_print: !!posReceiptPolicy.auto_print,
      render_mode: (posReceiptPolicy.render_mode === "escpos" ? "escpos" : "pdf") as "pdf" | "escpos",
      paper_format: posReceiptPolicy.paper_format as "58mm" | "80mm" | "a4" | "a5" | "letter",
      device_id: posReceiptDevice?.id ?? null,
      device_label:
        posReceiptDevice?.display_name ??
        (posReceiptDevice ? `${posReceiptDevice.role} (${posReceiptDevice.transport})` : null),
    }),
    [
      posReceiptPolicy.auto_print,
      posReceiptPolicy.render_mode,
      posReceiptPolicy.paper_format,
      posReceiptDevice?.id,
      posReceiptDevice?.display_name,
      posReceiptDevice?.role,
      posReceiptDevice?.transport,
    ],
  );

  const setTransaction = useCallback((t: CompletedPOSTransaction | null) => setTransactionState(t), []);

  const value = useMemo<ReceiptDataContextValue>(
    () => ({ transaction, setTransaction, policy }),
    [transaction, setTransaction, policy],
  );

  return <ReceiptDataContext.Provider value={value}>{children}</ReceiptDataContext.Provider>;
}

export function useReceiptData(): ReceiptDataContextValue {
  const ctx = useContext(ReceiptDataContext);
  if (!ctx) {
    throw new Error(
      "useReceiptData must be used inside <ReceiptDataProvider>. " +
        "Every POS terminal surface under /pos/terminal/:registerId is mounted below TerminalShell, which provides it.",
    );
  }
  return ctx;
}
