import { normalizeError } from "@/services/resilience";
/**
 * useTableOrder - Persistent DB-backed order for restaurant table sessions
 * 
 * Replaces the in-memory usePOSCart when in restaurant mode (table context present).
 * Creates a draft pos_transaction (status='pending') tied to the table session,
 * and persists every item add/remove/update to pos_transaction_items in real-time.
 * 
 * This enables:
 * - Orders that survive navigation/refresh
 * - Multi-terminal access to the same table order
 * - Pre-payment kitchen order creation
 * - Proper merge/split/transfer operations
 */

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { toast } from "sonner";
import type { CartItem, CartCustomer, CartState, CartItemModifier } from "./usePOSCart";

interface UseTableOrderOptions {
  tableSessionId: string;
  registerId: string;
  shiftId: string;
  tableNumber?: string;
}

interface TransactionRow {
  id: string;
  transaction_number: string;
  status: string;
  payment_status: string;
  subtotal: number;
  tax_amount: number;
  discount_amount: number | null;
  total: number;
  customer_id: string | null;
  customer_name: string | null;
  notes: string | null;
  version: number;
  table_session_id: string | null;
  tip_amount: number | null;
  branch_id: string | null;
}

interface TransactionItemRow {
  id: string;
  transaction_id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  discount_type: string | null;
  discount_value: number | null;
  tax_rate: number | null;
  tax_amount: number | null;
  line_total: number;
  cost_price: number | null;
  sort_order: number | null;
  tax_rate_id: string | null;
  etims_tax_code: string | null;
}

export function useTableOrder({ tableSessionId, registerId, shiftId, tableNumber }: UseTableOrderOptions) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { currentOrg: sessionOrg } = useSession();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  
  const [customer, setCustomer] = useState<CartCustomer | null>(null);
  const [notes, setNotes] = useState("");
  const [cartDiscount, setCartDiscount] = useState<{ type: "percent" | "fixed"; value: number } | null>(null);

  // Track the current version for optimistic concurrency
  const versionRef = useRef<number>(1);
  // Branch the draft transaction was stamped with at creation time. Used to
  // bind every subsequent UPDATE so a context-switch mid-order can't mutate
  // a foreign-branch row (server triggers also block this; the client guard
  // makes the failure mode an obvious 0-row result instead of a 42501).
  const branchIdRef = useRef<string | null>(null);

  // ========== QUERY: Load or create draft transaction for this table session ==========
  const orderQuery = useQuery({
    queryKey: ["table-order", tableSessionId],
    queryFn: async (): Promise<{ transaction: TransactionRow; items: TransactionItemRow[] }> => {
      if (!orgId || !tableSessionId) throw new Error("Missing context");

      // Try to find an existing pending transaction for this table session
      const { data: existing, error: fetchErr } = await supabase
        .from("pos_transactions")
        .select("*")
        .eq("table_session_id", tableSessionId)
        .eq("status", "pending")
        .maybeSingle();

      if (fetchErr) throw fetchErr;

      let transaction: TransactionRow;

      if (existing) {
        transaction = existing as unknown as TransactionRow;
      } else {
        // Create a new draft transaction
        // First get the register code AND branch_id — branch is required for
        // multi-branch isolation (RLS + reports + GL posting all key on it).
        const { data: regData, error: regErr } = await supabase
          .from("pos_registers")
          .select("register_code, branch_id")
          .eq("id", registerId)
          .single();

        if (regErr) throw regErr;
        if (!regData?.branch_id) {
          throw new Error(
            "Register is missing a branch assignment; cannot open a draft table order.",
          );
        }

        const registerCode = regData.register_code || "REG";
        const registerBranchId = regData.branch_id as string;

        // Generate draft transaction number
        const { data: txnNumber, error: numErr } = await supabase.rpc(
          "get_next_draft_transaction_number" as any,
          { p_organization_id: orgId, p_register_code: registerCode }
        );

        if (numErr) throw numErr;

        const { data: newTxn, error: insertErr } = await supabase
          .from("pos_transactions")
          .insert({
            organization_id: orgId,
            business_id: currentBusiness?.id || null,
            // Stamp branch_id from the register, NOT from the active UI
            // branch context — the register is the operational source of
            // truth so a draft cannot drift to the wrong branch even if a
            // user switches context mid-session.
            branch_id: registerBranchId,
            register_id: registerId,
            shift_id: shiftId,
            transaction_number: txnNumber as string,
            transaction_type: "sale",
            status: "pending",
            payment_status: "pending",
            subtotal: 0,
            tax_amount: 0,
            total: 0,
            table_session_id: tableSessionId,
            created_by: user?.id || null,
          } as any)
          .select()
          .single();

        if (insertErr) throw insertErr;
        transaction = newTxn as unknown as TransactionRow;
      }

      // Load items for this transaction
      const { data: items, error: itemsErr } = await supabase
        .from("pos_transaction_items")
        .select("*")
        .eq("transaction_id", transaction.id)
        .order("sort_order", { ascending: true });

      if (itemsErr) throw itemsErr;

      versionRef.current = transaction.version || 1;
      branchIdRef.current = transaction.branch_id ?? null;

      // Restore customer/notes from transaction
      if (transaction.customer_id && transaction.customer_name) {
        setCustomer({ id: transaction.customer_id, name: transaction.customer_name });
      }
      if (transaction.notes) setNotes(transaction.notes);

      return { transaction, items: (items || []) as TransactionItemRow[] };
    },
    enabled: !!orgId && !!tableSessionId && tableSessionId !== "__none__",
    staleTime: 5000, // Re-fetch if data is older than 5s
  });




  const transactionId = orderQuery.data?.transaction?.id;
  const dbItems = orderQuery.data?.items || [];

  // ========== Convert DB items to CartItem format ==========
  const items: CartItem[] = useMemo(() => {
    return dbItems.map((dbItem) => ({
      id: dbItem.id,
      product_id: dbItem.product_id,
      name: dbItem.description,
      quantity: dbItem.quantity,
      unit_price: dbItem.unit_price,
      discount_type: (dbItem.discount_type as "percent" | "fixed" | undefined) || undefined,
      discount_value: dbItem.discount_value || 0,
      tax_rate: dbItem.tax_rate || 0,
      tax_amount: dbItem.tax_amount || 0,
      line_total: dbItem.line_total,
      cost_price: dbItem.cost_price || undefined,
      tax_rate_id: dbItem.tax_rate_id || undefined,
      etims_tax_code: dbItem.etims_tax_code || undefined,
    }));
  }, [dbItems]);

  // ========== Totals: SERVER-AUTHORITATIVE ==========
  // Phase 5. Money is never computed in the browser for a table order.
  // Every mutation round-trips through `pos_sync_table_order`, which prices
  // the cart with `pos_quote_cart` (the same resolver retail checkout uses)
  // and writes the money columns. We simply read them back.
  const txnRow = orderQuery.data?.transaction;
  const totals = useMemo(() => ({
    subtotal: Number(txnRow?.subtotal ?? 0),
    discount_amount: Number(txnRow?.discount_amount ?? 0),
    tax_amount: Number(txnRow?.tax_amount ?? 0),
    total: Number(txnRow?.total ?? 0),
  }), [txnRow?.subtotal, txnRow?.discount_amount, txnRow?.tax_amount, txnRow?.total]);

  // ========== Helper: invalidate order query ==========
  const invalidateOrder = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["table-order", tableSessionId] });
  }, [queryClient, tableSessionId]);

  // ========== REALTIME: Subscribe to changes on this order for multi-terminal sync ==========
  useEffect(() => {
    if (!transactionId) return;

    const channel = supabase
      .channel(`table-order-${transactionId}`)
      .on(
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table: "pos_transaction_items",
          filter: `transaction_id=eq.${transactionId}`,
        },
        () => {
          invalidateOrder();
        }
      )
      .on(
        "postgres_changes" as any,
        {
          event: "UPDATE",
          schema: "public",
          table: "pos_transactions",
          filter: `id=eq.${transactionId}`,
        },
        (payload: any) => {
          if (payload.new?.version && payload.new.version > versionRef.current) {
            versionRef.current = payload.new.version;
            invalidateOrder();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [transactionId, invalidateOrder]);


  // ========== THE SINGLE WRITE SEAM ==========
  // Client sends INTENT (what was ordered). Server returns MONEY.
  type IntentLine = {
    line_id?: string;
    product_id: string | null;
    description: string;
    quantity: number;
    unit_price?: number;          // honoured only for non-catalog lines
    discount_type?: string | null;
    discount_value?: number;
    cost_price?: number;
    etims_tax_code?: string | null;
    packaging_id?: string | null;
    display_uom_id?: string | null;
    display_quantity?: number | null;
  };

  const currentIntent = useCallback((): IntentLine[] => {
    return dbItems.map((row) => ({
      line_id: row.id,
      product_id: row.product_id,
      description: row.description,
      quantity: row.quantity,
      unit_price: row.product_id ? undefined : row.unit_price,
      discount_type: row.discount_type,
      discount_value: row.discount_value ?? 0,
      cost_price: row.cost_price ?? 0,
      etims_tax_code: row.etims_tax_code,
    }));
  }, [dbItems]);

  const syncLines = useCallback(
    async (
      lines: IntentLine[],
      opts?: { contactId?: string | null; notes?: string | null },
    ): Promise<{ lineIds: string[] } | null> => {
      if (!transactionId) throw new Error("No active table order");

      const { data, error } = await supabase.rpc("pos_sync_table_order" as any, {
        p_transaction_id: transactionId,
        p_lines: lines as any,
        p_expected_version: versionRef.current,
        p_cart_discount_type: cartDiscount?.type === "percent" ? "percentage" : cartDiscount?.type ?? null,
        p_cart_discount_value: cartDiscount?.value ?? 0,
        p_contact_id: opts?.contactId ?? customer?.id ?? null,
        p_notes: opts?.notes ?? null,
      });

      if (error) throw error;

      const res = data as any;
      if (!res?.success) {
        // Another terminal edited this table first — never overwrite silently.
        if (res?.current_version) versionRef.current = res.current_version;
        toast.info("Order updated by another terminal. Refreshing…");
        invalidateOrder();
        return null;
      }

      versionRef.current = res.version;
      return { lineIds: (res.line_ids ?? []) as string[] };
    },
    [transactionId, cartDiscount, customer?.id, invalidateOrder],
  );

  // ========== MUTATION: Add item ==========
  const addItemMutation = useMutation({
    mutationFn: async (product: {
      id: string;
      name: string;
      sku?: string;
      price: number;
      tax_rate?: number;
      cost_price?: number;
      tax_rate_id?: string;
      tax_rate_name?: string;
      etims_tax_code?: string;
      category_id?: string;
      modifiers?: CartItemModifier[];
      modifiers_total?: number;
    }) => {
      if (!transactionId) throw new Error("No active table order");

      const modifiers = product.modifiers ?? [];
      const hasModifiers = modifiers.length > 0;
      const intent = currentIntent();

      // Plain re-order of an existing catalog line → bump quantity.
      if (!hasModifiers) {
        const existing = intent.find((l) => l.product_id === product.id && !l.description.startsWith("↳"));
        if (existing) {
          existing.quantity += 1;
          await syncLines(intent);
          return;
        }
      }

      const modifierSuffix = hasModifiers
        ? ` (${modifiers.map((m) => m.modifier_name).join(", ")})`
        : "";

      // The catalog line carries NO price — the server prices it. Modifier
      // surcharges ride as their own non-catalog lines so the money stays
      // server-derived while the surcharge revenue is still captured.
      intent.push({
        product_id: product.id,
        description: product.name + modifierSuffix,
        quantity: 1,
        cost_price: product.cost_price ?? 0,
        etims_tax_code: product.etims_tax_code ?? null,
      });
      const mainLineIndex = intent.length - 1;

      for (const m of modifiers) {
        if (!m.price_adjustment) continue;
        intent.push({
          product_id: null,
          description: `↳ ${m.modifier_name}`,
          quantity: 1,
          unit_price: m.price_adjustment,
        });
      }

      const result = await syncLines(intent);
      if (!result) return;

      const insertedItemId = result.lineIds[mainLineIndex];

      // Fire the kitchen/bar ticket against the persisted line.
      if (insertedItemId && sessionOrg?.id && currentBusiness?.id) {
        await supabase.from("pos_kitchen_orders").insert({
          organization_id: sessionOrg.id,
          business_id: currentBusiness.id,
          transaction_id: transactionId,
          transaction_item_id: insertedItemId,
          printer_category: product.category_id === "bar" ? "bar" : "kitchen",
          table_number: tableNumber || null,
          status: "pending",
          priority: 0,
          notes: modifierSuffix ? `Modifiers: ${modifierSuffix}` : null,
        } as any);
        queryClient.invalidateQueries({ queryKey: ["pos-kitchen-orders"] });
      }
    },
    onSuccess: () => invalidateOrder(),
    onError: (err: Error) => toast.error(`Failed to add item: ${normalizeError(err).message}`),
  });

  // ========== MUTATION: Update quantity ==========
  const updateQuantityMutation = useMutation({
    mutationFn: async ({ itemId, quantity }: { itemId: string; quantity: number }) => {
      const intent = currentIntent();
      const next = quantity <= 0
        ? intent.filter((l) => l.line_id !== itemId)
        : intent.map((l) => (l.line_id === itemId ? { ...l, quantity } : l));
      await syncLines(next);
    },
    onSuccess: () => invalidateOrder(),
    onError: (err: Error) => toast.error(`Failed to update quantity: ${normalizeError(err).message}`),
  });

  // ========== MUTATION: Remove item ==========
  const removeItemMutation = useMutation({
    mutationFn: async (itemId: string) => {
      await syncLines(currentIntent().filter((l) => l.line_id !== itemId));
    },
    onSuccess: () => invalidateOrder(),
    onError: (err: Error) => toast.error(`Failed to remove item: ${normalizeError(err).message}`),
  });

  // ========== MUTATION: Apply item discount ==========
  const applyItemDiscountMutation = useMutation({
    mutationFn: async ({ itemId, discount_type, discount_value }: { itemId: string; discount_type: "percent" | "fixed"; discount_value: number }) => {
      const next = currentIntent().map((l) =>
        l.line_id === itemId
          ? { ...l, discount_type: discount_type === "percent" ? "percentage" : "fixed", discount_value }
          : l,
      );
      await syncLines(next);
    },
    onSuccess: () => invalidateOrder(),
    onError: (err: Error) => toast.error(`Failed to apply discount: ${normalizeError(err).message}`),
  });

  // ========== MUTATION: Update customer on transaction ==========
  // The customer changes the PRICE (price lists, group discounts), so the
  // cart is re-quoted server-side after the contact is stamped.
  const updateCustomerMutation = useMutation({
    mutationFn: async (newCustomer: CartCustomer | null) => {
      if (!transactionId) return;
      const { error } = await supabase
        .from("pos_transactions")
        .update({
          customer_id: newCustomer?.id || null,
          customer_name: newCustomer?.name || null,
        } as any)
        .eq("id", transactionId)
        .eq("branch_id", branchIdRef.current!); // branch-bind
      if (error) throw error;
      await syncLines(currentIntent(), { contactId: newCustomer?.id ?? null });
    },
    onSuccess: () => invalidateOrder(),
    onError: (err: Error) => toast.error(`Failed to set customer: ${normalizeError(err).message}`),
  });

  // ========== MUTATION: Update notes ==========
  const updateNotesMutation = useMutation({
    mutationFn: async (newNotes: string) => {
      if (!transactionId) return;
      const { error } = await supabase
        .from("pos_transactions")
        .update({ notes: newNotes } as any)
        .eq("id", transactionId)
        .eq("branch_id", branchIdRef.current!); // branch-bind
      if (error) throw error;
    },
    onSuccess: () => invalidateOrder(),
    onError: (err: Error) => toast.error(`Failed to save notes: ${normalizeError(err).message}`),
  });

  // ========== Wrapper functions matching usePOSCart interface ==========
  const addItem = useCallback((product: Parameters<typeof addItemMutation.mutate>[0]) => {
    addItemMutation.mutate(product);
  }, [addItemMutation]);

  const updateQuantity = useCallback((itemId: string, quantity: number) => {
    updateQuantityMutation.mutate({ itemId, quantity });
  }, [updateQuantityMutation]);

  const removeItem = useCallback((itemId: string) => {
    removeItemMutation.mutate(itemId);
  }, [removeItemMutation]);

  const applyItemDiscount = useCallback((itemId: string, discount_type: "percent" | "fixed", discount_value: number) => {
    applyItemDiscountMutation.mutate({ itemId, discount_type, discount_value });
  }, [applyItemDiscountMutation]);

  const handleSetCustomer = useCallback((c: CartCustomer | null) => {
    setCustomer(c);
    updateCustomerMutation.mutate(c);
  }, [updateCustomerMutation]);

  const handleSetNotes = useCallback((n: string) => {
    setNotes(n);
    updateNotesMutation.mutate(n);
  }, [updateNotesMutation]);

  const clearCart = useCallback(() => {
    // Restaurant mode: clearing means emptying the bill, not deleting it.
    if (!transactionId) return;
    void syncLines([]).catch((err: Error) =>
      toast.error(`Failed to clear order: ${normalizeError(err).message}`),
    );
    setCustomer(null);
    setNotes("");
    setCartDiscount(null);
  }, [transactionId, syncLines]);

  // A cart-level discount is money: re-quote instead of adjusting locally.
  useEffect(() => {
    if (!transactionId) return;
    void syncLines(currentIntent()).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartDiscount?.type, cartDiscount?.value]);

  // restoreCart is a no-op in persistent mode
  const restoreCart = useCallback((_state: CartState) => {
    // Not applicable - state is always in DB
  }, []);

  const cartState: CartState = useMemo(() => ({
    items,
    customer,
    subtotal: totals.subtotal,
    discount_amount: totals.discount_amount,
    tax_amount: totals.tax_amount,
    total: totals.total,
    notes,
  }), [items, customer, totals, notes]);

  return {
    // Same interface as usePOSCart
    items,
    customer,
    notes,
    itemCount: items.length,
    totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    ...totals,
    cartState,
    addItem,
    updateQuantity,
    applyItemDiscount,
    removeItem,
    clearCart,
    setCustomer: handleSetCustomer,
    setNotes: handleSetNotes,
    setCartDiscount,
    restoreCart,
    
    // Restaurant-specific extras
    transactionId,
    isLoading: orderQuery.isLoading,
    isError: orderQuery.isError,
    draftTransactionNumber: orderQuery.data?.transaction?.transaction_number,
  };
}
