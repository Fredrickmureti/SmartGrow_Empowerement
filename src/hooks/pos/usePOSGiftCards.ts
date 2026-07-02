import { normalizeError } from "@/services/resilience";
/**
 * Gift Card / Store Credit Hook
 * Manages gift card lifecycle: issue, redeem, top-up, check balance
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

export interface GiftCard {
  id: string;
  organization_id: string;
  card_number: string;
  pin: string | null;
  initial_balance: number;
  current_balance: number;
  currency: string;
  status: "active" | "suspended" | "expired" | "depleted";
  issued_to_customer_id: string | null;
  issued_to_name: string | null;
  issued_by: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GiftCardTransaction {
  id: string;
  gift_card_id: string;
  transaction_type: "issue" | "redeem" | "top_up" | "refund" | "adjustment" | "expire";
  amount: number;
  balance_after: number;
  pos_transaction_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

export function usePOSGiftCards() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  // SCOPE-EXEMPT: pos_gift_cards is workspace-scoped (no business_id column).
  // Gift cards are honored at any company in the workspace, like a shared
  // store-credit ledger. Issuance/redemption transactions inherit the same scope.

  // Fetch all gift cards
  const { data: giftCards = [], isLoading } = useQuery({
    queryKey: ["pos-gift-cards", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("pos_gift_cards")
        .select("*")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as GiftCard[];
    },
    enabled: !!orgId,
  });

  // Look up a gift card by number
  const lookupCard = async (cardNumber: string): Promise<GiftCard | null> => {
    if (!orgId) return null;
    const { data, error } = await supabase
      .from("pos_gift_cards")
      .select("*")
      .eq("organization_id", orgId)
        .eq("business_id", businessId)
      .eq("card_number", cardNumber)
      .maybeSingle();
    if (error) throw error;
    return data as GiftCard | null;
  };

  // Issue a new gift card
  const issueCard = useMutation({
    mutationFn: async (input: {
      card_number?: string;
      initial_balance: number;
      customer_id?: string;
      customer_name?: string;
      expires_at?: string;
    }) => {
      if (!orgId || !user?.id) throw new Error("Not authenticated");

      const cardNumber = input.card_number || `GC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

      const { data: card, error } = await supabase
        .from("pos_gift_cards")
        .insert({
          organization_id: orgId,
          business_id: businessId,
          card_number: cardNumber,
          initial_balance: input.initial_balance,
          current_balance: input.initial_balance,
          issued_to_customer_id: input.customer_id || null,
          issued_to_name: input.customer_name || null,
          issued_by: user.id,
          expires_at: input.expires_at || null,
          status: "active",
        })
        .select()
        .single();

      if (error) throw error;

      // Record the issuance transaction
      await supabase.from("pos_gift_card_transactions").insert({
        organization_id: orgId,
          business_id: businessId,
        gift_card_id: card.id,
        transaction_type: "issue",
        amount: input.initial_balance,
        balance_after: input.initial_balance,
        created_by: user.id,
        notes: `Gift card issued: ${cardNumber}`,
      });

      return card as GiftCard;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-gift-cards", orgId] });
      toast.success("Gift card issued");
    },
    onError: (error: Error) => {
      toast.error(`Failed to issue gift card: ${normalizeError(error).message}`);
    },
  });

  // Redeem from gift card
  const redeemCard = useMutation({
    mutationFn: async (input: {
      card_id: string;
      amount: number;
      pos_transaction_id?: string;
    }) => {
      if (!orgId || !user?.id) throw new Error("Not authenticated");

      // Get current balance with lock
      const { data: card, error: fetchErr } = await supabase
        .from("pos_gift_cards")
        .select("*")
        .eq("id", input.card_id)
        .single();

      if (fetchErr) throw fetchErr;
      if (!card) throw new Error("Gift card not found");
      if (card.status !== "active") throw new Error(`Gift card is ${card.status}`);
      if (card.current_balance < input.amount) throw new Error(`Insufficient balance: ${card.current_balance}`);

      const newBalance = card.current_balance - input.amount;
      const newStatus = newBalance <= 0 ? "depleted" : "active";

      const { error: updateErr } = await supabase
        .from("pos_gift_cards")
        .update({ current_balance: newBalance, status: newStatus })
        .eq("id", input.card_id);

      if (updateErr) throw updateErr;

      await supabase.from("pos_gift_card_transactions").insert({
        organization_id: orgId,
          business_id: businessId,
        gift_card_id: input.card_id,
        transaction_type: "redeem",
        amount: -input.amount,
        balance_after: newBalance,
        pos_transaction_id: input.pos_transaction_id || null,
        created_by: user.id,
      });

      return { newBalance, newStatus };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-gift-cards", orgId] });
    },
    onError: (error: Error) => {
      toast.error(`Gift card redemption failed: ${normalizeError(error).message}`);
    },
  });

  // Top up gift card
  const topUpCard = useMutation({
    mutationFn: async (input: { card_id: string; amount: number }) => {
      if (!orgId || !user?.id) throw new Error("Not authenticated");

      const { data: card, error: fetchErr } = await supabase
        .from("pos_gift_cards")
        .select("*")
        .eq("id", input.card_id)
        .single();

      if (fetchErr) throw fetchErr;
      if (!card) throw new Error("Gift card not found");

      const newBalance = card.current_balance + input.amount;

      const { error: updateErr } = await supabase
        .from("pos_gift_cards")
        .update({ current_balance: newBalance, status: "active" })
        .eq("id", input.card_id);

      if (updateErr) throw updateErr;

      await supabase.from("pos_gift_card_transactions").insert({
        organization_id: orgId,
          business_id: businessId,
        gift_card_id: input.card_id,
        transaction_type: "top_up",
        amount: input.amount,
        balance_after: newBalance,
        created_by: user.id,
      });

      return { newBalance };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pos-gift-cards", orgId] });
      toast.success("Gift card topped up");
    },
    onError: (error: Error) => {
      toast.error(`Top-up failed: ${normalizeError(error).message}`);
    },
  });

  return {
    giftCards,
    isLoading,
    lookupCard,
    issueCard,
    redeemCard,
    topUpCard,
  };
}
