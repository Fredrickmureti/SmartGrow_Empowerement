/**
 * usePOSCartAdapter - Unified cart interface for retail and restaurant modes
 * 
 * In retail mode (no tableSessionId): uses in-memory usePOSCart
 * In restaurant mode (tableSessionId present): uses persistent useTableOrder
 * 
 * Both provide the same CartItem-based interface so the terminal doesn't care.
 */

import { usePOSCart } from "./usePOSCart";
import { useTableOrder } from "./useTableOrder";

interface AdapterOptions {
  tableSessionId: string | null;
  registerId: string;
  shiftId: string;
  tableNumber?: string;
}

export function usePOSCartAdapter({ tableSessionId, registerId, shiftId, tableNumber }: AdapterOptions) {
  // Always call both hooks (React rules), but only use one
  const retailCart = usePOSCart();
  const tableOrder = useTableOrder({
    tableSessionId: tableSessionId || "__none__",
    registerId,
    shiftId,
    tableNumber,
  });

  const isRestaurantMode = !!tableSessionId;

  if (isRestaurantMode) {
    return {
      ...tableOrder,
      isRestaurantMode: true as const,
      transactionId: tableOrder.transactionId,
      draftTransactionNumber: tableOrder.draftTransactionNumber,
      isOrderLoading: tableOrder.isLoading,
    };
  }

  return {
    ...retailCart,
    isRestaurantMode: false as const,
    transactionId: undefined as string | undefined,
    draftTransactionNumber: undefined as string | undefined,
    isOrderLoading: false,
  };
}
