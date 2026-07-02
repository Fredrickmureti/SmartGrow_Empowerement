/**
 * useDrawerPolicy — single canonical resolver for whether/when the cash drawer
 * should be physically kicked, and whether a reason must be collected.
 *
 * This is the ONLY place this logic lives. PaymentDialog, ReceiptPreviewDialog,
 * CashDrawerDialog, PrinterService, and POSTerminal all consume the policy
 * exposed here — never duplicate the rule.
 *
 * Inputs: per-register settings + cashier permissions.
 * Output: pure helpers. No side effects.
 */

import { useMemo } from "react";

export type DrawerKickContext =
  | "auto_sale_kick"
  | "no_sale"
  | "cash_movement"
  | "manual_open"
  | "reprint"
  | "return"
  | "void";

export interface DrawerPolicyInput {
  register: {
    auto_open_drawer_on_cash?: boolean | null;
    auto_open_drawer_on_non_cash?: boolean | null;
    require_reason_on_no_sale?: boolean | null;
    confirm_before_drawer_open?: boolean | null;
    /** L1: fire drawer on cash refunds. Default false. */
    drawer_kick_on_return?: boolean | null;
    /** L1: fire drawer on cash voids. Default false. */
    drawer_kick_on_void?: boolean | null;
    /** L1: fire drawer on reprint. Default false. */
    drawer_kick_on_reprint?: boolean | null;
  } | null | undefined;
  cashier: {
    can_open_cash_drawer?: boolean | null;
  } | null | undefined;
}

export interface PaymentSplitTender {
  /**
   * Normalized tender method. Anything matching CASH_TENDER_METHODS counts as cash.
   * mpesa/mobile_money/card/voucher/credit/bank_transfer/other are all non-cash.
   */
  method: string;
  amount: number;
}

const CASH_TENDER_METHODS = new Set(["cash"]);

export function isCashTender(method: string): boolean {
  return CASH_TENDER_METHODS.has((method ?? "").toLowerCase());
}

export function useDrawerPolicy(input: DrawerPolicyInput) {
  return useMemo(() => {
    const autoCash = input.register?.auto_open_drawer_on_cash ?? true;
    const autoNonCash = input.register?.auto_open_drawer_on_non_cash ?? false;
    const requireReasonNoSale = input.register?.require_reason_on_no_sale ?? true;
    const confirmBeforeOpen = input.register?.confirm_before_drawer_open ?? false;
    const cashierAllowed = input.cashier?.can_open_cash_drawer ?? true;
    const kickOnReturn = input.register?.drawer_kick_on_return ?? false;
    const kickOnVoid = input.register?.drawer_kick_on_void ?? false;
    const kickOnReprint = input.register?.drawer_kick_on_reprint ?? false;

    /**
     * Should the drawer auto-fire after a successful sale, given the tender mix?
     */
    function shouldKickDrawer(payments: PaymentSplitTender[]): boolean {
      if (!cashierAllowed) return false;
      if (!payments || payments.length === 0) return false;
      const hasCash = payments.some((p) => isCashTender(p.method) && p.amount > 0);
      return hasCash ? autoCash : autoNonCash;
    }

    /**
     * L1 — context-aware drawer decision for non-sale contexts. The drawer
     * stays closed for card/mobile refunds, voids, and reprints unless the
     * register has explicitly opted in AND the original tender mix is cash.
     *
     * - auto_sale_kick: delegate to shouldKickDrawer (legacy semantics).
     * - return:  kick only if drawer_kick_on_return  AND original mix had cash
     * - void:    kick only if drawer_kick_on_void    AND original mix had cash
     * - reprint: kick only if drawer_kick_on_reprint AND original mix had cash
     * - no_sale / manual_open / cash_movement: caller explicitly asked, kick.
     */
    function shouldKickForContext(
      context: DrawerKickContext,
      payments: PaymentSplitTender[] = [],
    ): boolean {
      if (!cashierAllowed) return false;
      const hasCash = payments.some((p) => isCashTender(p.method) && p.amount > 0);
      switch (context) {
        case "auto_sale_kick":
          return shouldKickDrawer(payments);
        case "return":
          return kickOnReturn && hasCash;
        case "void":
          return kickOnVoid && hasCash;
        case "reprint":
          return kickOnReprint && hasCash;
        case "no_sale":
        case "manual_open":
        case "cash_movement":
          return true;
        default:
          return false;
      }
    }

    function requiresReason(context: DrawerKickContext): boolean {
      switch (context) {
        case "cash_movement":
          return true;
        case "no_sale":
          return requireReasonNoSale;
        default:
          return false;
      }
    }

    return {
      shouldKickDrawer,
      shouldKickForContext,
      requiresReason,
      cashierAllowed,
      confirmBeforeOpen,
    };
  }, [input.register, input.cashier]);
}
