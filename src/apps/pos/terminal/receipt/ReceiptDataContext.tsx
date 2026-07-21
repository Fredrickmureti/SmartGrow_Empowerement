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
 *     `/pos/terminal/:registerId/*` can consume it (including future
 *     route-owned `ReceiptRoute`).
 *   - `transaction` is the live `LiveTransactionInput` payload the
 *     receipt surfaces (`ReceiptPreviewBody`, `PostPaymentSurface`)
 *     consume. Nullable — nothing is completed yet.
 *   - `setTransaction` is the *only* mutator; `POSTerminal` (until
 *     Step 6 finishes decomposition) writes to it after tender
 *     completion and clears it on `newSale`.
 *   - `policy` is the stable `PrintPolicyHint` resolved from the
 *     tenant's document print policy + bound device. Computed HERE so
 *     the receipt route doesn't have to duplicate the hook wiring.
 *
 * Non-goals (Slice C.1):
 *   - Does NOT swap the receipt route to a route-owned element yet
 *     (that is Slice C.2). This slice only relocates the receipt
 *     state ownership so the route swap becomes a mechanical change.
 *   - Does NOT alter cart, shift, or hardware state — those still
 *     live in their existing hooks.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useResolvedPrintPolicyWithDevice } from "@/hooks/useDocumentPrintPolicies";
import type { LiveTransactionInput } from "@/lib/pos/receipt/ReceiptDocumentModel";
import type { PrintPolicyHint } from "./PostPaymentSurface";

interface ReceiptDataContextValue {
  transaction: LiveTransactionInput | null;
  setTransaction: (t: LiveTransactionInput | null) => void;
  policy: PrintPolicyHint;
}

const ReceiptDataContext = createContext<ReceiptDataContextValue | null>(null);

interface ReceiptDataProviderProps {
  businessId: string | undefined;
  branchId: string | null | undefined;
  children: ReactNode;
}

export function ReceiptDataProvider({ businessId, branchId, children }: ReceiptDataProviderProps) {
  const [transaction, setTransactionState] = useState<LiveTransactionInput | null>(null);

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

  const setTransaction = useCallback((t: LiveTransactionInput | null) => setTransactionState(t), []);

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
