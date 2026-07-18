/**
 * Wave 2 · Phase C — Card / EMV terminal controller.
 *
 * Client-side FSM wrapper around the `pos_card_*` RPCs. The database
 * enforces legal transitions; this class exists so UI code has ONE
 * well-typed path for authorize → capture → void/reverse and so we can
 * swap the "sim" driver for a real EMV integration (Verifone, Ingenico,
 * Stripe Terminal, MPGS, etc.) without touching PaymentDialog.
 *
 * IMPORTANT: never call `pos_transaction_payments` UPDATE directly for
 * card tenders — always go through these RPCs so the FSM trigger runs.
 */
import { supabase } from "@/integrations/supabase/client";

export type CardAuthState =
  | "idle" | "collecting" | "authorizing"
  | "approved" | "declined" | "captured"
  | "voided" | "refunded" | "failed";

export interface CardAuthResult {
  paymentId: string;
  authId: string;
  vendorTxnId: string;
  authorizedAmount: number;
  cardLastFour?: string | null;
  cardType?: string | null;
  state: CardAuthState;
}

export interface CardDriver {
  /** Drive the physical/virtual terminal for an authorization. */
  authorize(input: {
    amount: number;
    paymentId: string;
    currency?: string;
  }): Promise<{
    authId: string;
    vendorTxnId: string;
    authorizedAmount: number;
    cardLastFour?: string;
    cardType?: string;
  }>;
}

/** Simulator driver — deterministic, safe for e2e tests until a real EMV
 *  SDK is wired up. Approves everything under 50k, declines above. */
export const simCardDriver: CardDriver = {
  async authorize({ amount, paymentId }) {
    if (amount > 50000) throw new Error("SIM_DECLINED");
    return {
      authId: `sim_${paymentId.slice(0, 8)}_${Date.now()}`,
      vendorTxnId: `sim-vt-${crypto.randomUUID()}`,
      authorizedAmount: amount,
      cardLastFour: "4242",
      cardType: "visa",
    };
  },
};

export class CardTerminalController {
  constructor(private readonly driver: CardDriver = simCardDriver) {}

  async authorize(paymentId: string, amount: number, currency?: string): Promise<CardAuthResult> {
    const vendor = await this.driver.authorize({ paymentId, amount, currency });
    const { data, error } = await supabase.rpc("pos_card_authorize", {
      p_payment_id:     paymentId,
      p_authorized:     vendor.authorizedAmount,
      p_auth_id:        vendor.authId,
      p_vendor_txn_id:  vendor.vendorTxnId,
      p_card_last_four: vendor.cardLastFour ?? null,
      p_card_type:      vendor.cardType ?? null,
    });
    if (error) throw error;
    const row = data as { auth_state: CardAuthState };
    return {
      paymentId,
      authId:           vendor.authId,
      vendorTxnId:      vendor.vendorTxnId,
      authorizedAmount: vendor.authorizedAmount,
      cardLastFour:     vendor.cardLastFour,
      cardType:         vendor.cardType,
      state:            row.auth_state,
    };
  }

  async capture(paymentId: string, amount: number): Promise<CardAuthState> {
    const { data, error } = await supabase.rpc("pos_card_capture", {
      p_payment_id: paymentId,
      p_amount:     amount,
    });
    if (error) throw error;
    return (data as { auth_state: CardAuthState }).auth_state;
  }

  async void(paymentId: string, reason?: string): Promise<CardAuthState> {
    const { data, error } = await supabase.rpc("pos_card_void", {
      p_payment_id: paymentId,
      p_reason:     reason ?? null,
    });
    if (error) throw error;
    return (data as { auth_state: CardAuthState }).auth_state;
  }

  async reverse(paymentId: string, reason?: string): Promise<CardAuthState> {
    const { data, error } = await supabase.rpc("pos_card_reverse", {
      p_payment_id: paymentId,
      p_reason:     reason ?? null,
    });
    if (error) throw error;
    return (data as { auth_state: CardAuthState }).auth_state;
  }
}

export const cardTerminal = new CardTerminalController();
