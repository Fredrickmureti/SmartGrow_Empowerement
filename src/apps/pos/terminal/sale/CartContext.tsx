/**
 * CartContext — workstation-scoped cart ownership.
 *
 * Step 6 (cart-ownership lift): `usePOSCartAdapter` used to be invoked
 * inside `POSTerminal.tsx`, which meant the cart's identity was tied
 * to the monolith's mount lifecycle. That blocked route-owned sibling
 * workspaces (`SaleWorkspace`, `ReceiptRoute`, future
 * `TenderWorkspace`) because swapping the element behind
 * `/pos/terminal/:registerId/*` would unmount `POSTerminal` and drop
 * cart state.
 *
 * The provider mounts at `TerminalShell` — peer of
 * `ReceiptDataProvider` — so cart state survives every sibling route
 * swap under the shell. `registerId` and `shiftId` come in as props
 * (the shell resolves both from `useParams`/`usePOSShifts`).
 * `tableSessionId` + `tableNumber` are read here from URL search
 * params to preserve the exact call shape the monolith used at
 * `POSTerminal.tsx:231`.
 *
 * The provider re-exports the `usePOSCartAdapter` return object
 * unchanged (see the Step-6 technical note: cart provider must expose
 * the exact adapter shape). Consumers call `useCart()` and get the
 * same ~40-method surface `POSTerminal` currently threads into JSX.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { usePOSCartAdapter } from "@/hooks/pos/usePOSCartAdapter";

type CartValue = ReturnType<typeof usePOSCartAdapter>;

const CartContext = createContext<CartValue | null>(null);

interface CartProviderProps {
  registerId: string;
  shiftId: string;
  children: ReactNode;
}

export function CartProvider({ registerId, shiftId, children }: CartProviderProps) {
  const [searchParams] = useSearchParams();
  const tableSessionId = searchParams.get("session");
  const tableNumber = searchParams.get("tableNumber");

  const cart = usePOSCartAdapter({
    tableSessionId: tableSessionId || null,
    registerId,
    shiftId,
    tableNumber: tableNumber || undefined,
  });

  return <CartContext.Provider value={cart}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error(
      "useCart() must be called inside <CartProvider> (mounted by TerminalShell)",
    );
  }
  return ctx;
}