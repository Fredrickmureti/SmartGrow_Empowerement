/**
 * ReceiptRoute — route-owned sibling for `/pos/terminal/:registerId/receipt`.
 *
 * Slice C.2 of the workstation-decomposition plan (`.lovable/plan.md`).
 *
 * Why this exists:
 *   `POSTerminal.tsx` still mounts `ReceiptWorkspace` internally when
 *   `terminalState.phase === "receipt"`, but that only works while
 *   POSTerminal is on screen. Once the `receipt` sibling is routed here
 *   directly, POSTerminal unmounts on receipt-phase URLs and the email
 *   dialog + reprint side-effects would disappear with it. This route
 *   is self-sufficient: it reads the completed transaction and print
 *   policy from `ReceiptDataContext` (mounted by TerminalShell above)
 *   and owns the email `<SendDocumentDialog>` locally so the surface
 *   stays functional without POSTerminal.
 *
 * Non-goals:
 *   - Does NOT clear cart state on New Sale; the reducer's `newSale`
 *     dispatch is what returns the terminal to `ready`. Cart resets
 *     that used to hang off the local `setCompletedTransaction(null)`
 *     in POSTerminal are subsumed by clearing the receipt context
 *     transaction, which is what `handleNewSale` below does.
 */

import { useState, useCallback } from "react";
import { ReceiptWorkspace } from "./ReceiptWorkspace";
import { useReceiptData } from "./ReceiptDataContext";
import { SendDocumentDialog } from "@/components/common/SendDocumentDialog";

export function ReceiptRoute() {
  const { transaction, setTransaction, policy } = useReceiptData();
  const [showEmail, setShowEmail] = useState(false);

  const handleNewSale = useCallback(() => {
    setTransaction(null);
  }, [setTransaction]);

  return (
    <>
      <ReceiptWorkspace
        transaction={transaction}
        policy={policy}
        onEmail={() => setShowEmail(true)}
        onNewSale={handleNewSale}
      />

      {transaction && (
        <SendDocumentDialog
          open={showEmail}
          onOpenChange={setShowEmail}
          document={{
            documentType: "pos_receipt",
            documentId: transaction.id,
            documentNumber: transaction.transaction_number,
            recipientName: transaction.customer_name,
            total: transaction.total_amount,
          }}
        />
      )}
    </>
  );
}

export default ReceiptRoute;
