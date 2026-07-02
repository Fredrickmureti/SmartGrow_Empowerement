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

const calculateItemTotals = (
  quantity: number,
  unit_price: number,
  discount_type?: string | null,
  discount_value: number = 0,
  tax_rate: number = 0
) => {
  const gross = quantity * unit_price;
  let discountAmount = 0;
  if (discount_type === "percent") {
    discountAmount = gross * (discount_value / 100);
  } else if (discount_type === "fixed") {
    discountAmount = discount_value;
  }
  const afterDiscount = gross - discountAmount;
  const taxAmount = afterDiscount * (tax_rate / 100);
  const lineTotal = afterDiscount + taxAmount;
  return { discount_amount: discountAmount, tax_amount: taxAmount, line_total: lineTotal };
};

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

  // ========== Calculate totals (same logic as usePOSCart) ==========
  const totals = useMemo(() => {
    const subtotal = items.reduce((sum, item) => {
      const itemGross = item.quantity * item.unit_price;
      let itemDiscount = 0;
      if (item.discount_type === "percent") {
        itemDiscount = itemGross * (item.discount_value / 100);
      } else if (item.discount_type === "fixed") {
        itemDiscount = item.discount_value;
      }
      return sum + (itemGross - itemDiscount);
    }, 0);

    let discountAmount = 0;
    if (cartDiscount) {
      discountAmount = cartDiscount.type === "percent"
        ? subtotal * (cartDiscount.value / 100)
        : cartDiscount.value;
    }

    let taxAmount = 0;
    if (subtotal > 0 && discountAmount > 0) {
      taxAmount = items.reduce((sum, item) => {
        const itemGross = item.quantity * item.unit_price;
        let itemDisc = 0;
        if (item.discount_type === "percent") itemDisc = itemGross * (item.discount_value / 100);
        else if (item.discount_type === "fixed") itemDisc = item.discount_value;
        const itemNet = itemGross - itemDisc;
        const itemCartDiscount = (itemNet / subtotal) * discountAmount;
        return sum + (itemNet - itemCartDiscount) * (item.tax_rate / 100);
      }, 0);
    } else {
      taxAmount = items.reduce((sum, item) => sum + item.tax_amount, 0);
    }

    const total = subtotal - discountAmount + taxAmount;
    return { subtotal, discount_amount: discountAmount, tax_amount: taxAmount, total };
  }, [items, cartDiscount]);

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


  const updateTransactionTotals = useCallback(async (txnId: string, newItems: CartItem[]) => {
    const subtotal = newItems.reduce((sum, item) => {
      const g = item.quantity * item.unit_price;
      let d = 0;
      if (item.discount_type === "percent") d = g * (item.discount_value / 100);
      else if (item.discount_type === "fixed") d = item.discount_value;
      return sum + (g - d);
    }, 0);
    const taxAmount = newItems.reduce((s, i) => s + i.tax_amount, 0);
    const total = subtotal + taxAmount;

    const { data, error } = await supabase
      .from("pos_transactions")
      .update({
        subtotal,
        tax_amount: taxAmount,
        total,
        version: versionRef.current + 1,
        updated_at: new Date().toISOString(),
      } as any)
      .eq("id", txnId)
      .eq("version", versionRef.current)
      .eq("branch_id", branchIdRef.current!) // branch-bind: cross-branch race => 0 rows
      .select("id")
      .maybeSingle();

    if (!data && !error) {
      // Version conflict — another terminal updated this order
      toast.info("Order updated by another terminal. Refreshing...");
      invalidateOrder();
      return;
    }

    versionRef.current += 1;
  }, [invalidateOrder]);

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

      const hasModifiers = product.modifiers && product.modifiers.length > 0;
      const effectivePrice = product.price + (product.modifiers_total || 0);
      const taxRate = product.tax_rate || 0;

      // Check if product already exists (no modifiers) and increment
      if (!hasModifiers) {
        const existingItem = dbItems.find(
          (i) => i.product_id === product.id
        );
        if (existingItem) {
          const newQty = existingItem.quantity + 1;
          const t = calculateItemTotals(newQty, existingItem.unit_price, existingItem.discount_type, existingItem.discount_value || 0, existingItem.tax_rate || 0);
          
          await supabase
            .from("pos_transaction_items")
            .update({
              quantity: newQty,
              tax_amount: t.tax_amount,
              line_total: t.line_total,
            })
            .eq("id", existingItem.id);

          // Update transaction totals
          const updatedItems = items.map(i => 
            i.id === existingItem.id 
              ? { ...i, quantity: newQty, tax_amount: t.tax_amount, line_total: t.line_total }
              : i
          );
          await updateTransactionTotals(transactionId, updatedItems);
          return;
        }
      }

      // Build name with modifier suffix
      const modifierSuffix = product.modifiers?.length
        ? ` (${product.modifiers.map(m => m.modifier_name).join(', ')})`
        : '';

      const t = calculateItemTotals(1, effectivePrice, undefined, 0, taxRate);

      const { data: insertedItem } = await supabase
        .from("pos_transaction_items")
        .insert({
          transaction_id: transactionId,
          business_id: currentBusiness!.id,
          product_id: product.id,
          description: product.name + modifierSuffix,
          quantity: 1,
          unit_price: effectivePrice,
          tax_rate: taxRate,
          tax_amount: t.tax_amount,
          line_total: t.line_total,
          cost_price: product.cost_price || null,
          sort_order: dbItems.length,
          tax_rate_id: product.tax_rate_id || null,
          etims_tax_code: product.etims_tax_code || null,
        })
        .select("id")
        .single();

      // Send to kitchen automatically in restaurant mode
      if (insertedItem && sessionOrg?.id && currentBusiness?.id) {
        supabase
          .from("pos_kitchen_orders")
          .insert({
            organization_id: sessionOrg.id,
            business_id: currentBusiness.id,
            transaction_id: transactionId,
            transaction_item_id: insertedItem.id,
            printer_category: product.category_id === "bar" ? "bar" : "kitchen",
            table_number: tableNumber || null,
            status: "pending",
            priority: 0,
            notes: modifierSuffix ? `Modifiers: ${modifierSuffix}` : null,
          } as any)
          .then(() => {
            queryClient.invalidateQueries({ queryKey: ["pos-kitchen-orders"] });
          });
      }

      // Update transaction totals
      const newItem: CartItem = {
        id: "temp",
        product_id: product.id,
        name: product.name + modifierSuffix,
        quantity: 1,
        unit_price: effectivePrice,
        discount_value: 0,
        tax_rate: taxRate,
        tax_amount: t.tax_amount,
        line_total: t.line_total,
      };
      await updateTransactionTotals(transactionId, [...items, newItem]);
    },
    onSuccess: () => invalidateOrder(),
    onError: (err: Error) => toast.error(`Failed to add item: ${normalizeError(err).message}`),
  });

  // ========== MUTATION: Update quantity ==========
  const updateQuantityMutation = useMutation({
    mutationFn: async ({ itemId, quantity }: { itemId: string; quantity: number }) => {
      if (!transactionId) throw new Error("No active table order");

      if (quantity <= 0) {
        await supabase.from("pos_transaction_items").delete().eq("id", itemId);
        const remaining = items.filter(i => i.id !== itemId);
        await updateTransactionTotals(transactionId, remaining);
        return;
      }

      const item = dbItems.find(i => i.id === itemId);
      if (!item) return;

      const t = calculateItemTotals(quantity, item.unit_price, item.discount_type, item.discount_value || 0, item.tax_rate || 0);

      await supabase
        .from("pos_transaction_items")
        .update({ quantity, tax_amount: t.tax_amount, line_total: t.line_total })
        .eq("id", itemId);

      const updatedItems = items.map(i =>
        i.id === itemId ? { ...i, quantity, tax_amount: t.tax_amount, line_total: t.line_total } : i
      );
      await updateTransactionTotals(transactionId, updatedItems);
    },
    onSuccess: () => invalidateOrder(),
    onError: (err: Error) => toast.error(`Failed to update quantity: ${normalizeError(err).message}`),
  });

  // ========== MUTATION: Remove item ==========
  const removeItemMutation = useMutation({
    mutationFn: async (itemId: string) => {
      if (!transactionId) throw new Error("No active table order");
      await supabase.from("pos_transaction_items").delete().eq("id", itemId);
      const remaining = items.filter(i => i.id !== itemId);
      await updateTransactionTotals(transactionId, remaining);
    },
    onSuccess: () => invalidateOrder(),
    onError: (err: Error) => toast.error(`Failed to remove item: ${normalizeError(err).message}`),
  });

  // ========== MUTATION: Apply item discount ==========
  const applyItemDiscountMutation = useMutation({
    mutationFn: async ({ itemId, discount_type, discount_value }: { itemId: string; discount_type: "percent" | "fixed"; discount_value: number }) => {
      if (!transactionId) throw new Error("No active table order");
      const item = dbItems.find(i => i.id === itemId);
      if (!item) return;

      const t = calculateItemTotals(item.quantity, item.unit_price, discount_type, discount_value, item.tax_rate || 0);

      await supabase
        .from("pos_transaction_items")
        .update({ discount_type, discount_value, tax_amount: t.tax_amount, line_total: t.line_total })
        .eq("id", itemId);

      const updatedItems = items.map(i =>
        i.id === itemId ? { ...i, discount_type, discount_value, tax_amount: t.tax_amount, line_total: t.line_total } : i
      );
      await updateTransactionTotals(transactionId, updatedItems);
    },
    onSuccess: () => invalidateOrder(),
  });

  // ========== MUTATION: Update customer on transaction ==========
  const updateCustomerMutation = useMutation({
    mutationFn: async (newCustomer: CartCustomer | null) => {
      if (!transactionId) return;
      await supabase
        .from("pos_transactions")
        .update({
          customer_id: newCustomer?.id || null,
          customer_name: newCustomer?.name || null,
        })
        .eq("id", transactionId)
        .eq("branch_id", branchIdRef.current!); // branch-bind
    },
    onSuccess: () => invalidateOrder(),
  });

  // ========== MUTATION: Update notes ==========
  const updateNotesMutation = useMutation({
    mutationFn: async (newNotes: string) => {
      if (!transactionId) return;
      await supabase
        .from("pos_transactions")
        .update({ notes: newNotes })
        .eq("id", transactionId)
        .eq("branch_id", branchIdRef.current!); // branch-bind
    },
    onSuccess: () => invalidateOrder(),
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
    // In restaurant mode, clearing cart means removing all items (not deleting the transaction)
    if (!transactionId) return;
    // Delete all items
    supabase
      .from("pos_transaction_items")
      .delete()
      .eq("transaction_id", transactionId)
      .then(() => {
        invalidateOrder();
      });
    setCustomer(null);
    setNotes("");
    setCartDiscount(null);
  }, [transactionId, invalidateOrder]);

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
