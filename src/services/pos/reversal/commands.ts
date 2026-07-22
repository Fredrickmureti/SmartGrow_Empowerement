/**
 * POS Reversal Command Taxonomy — Stage 2 of the POS refund/reversal
 * remediation (see `.lovable/plan.md`).
 *
 * Kill F2 (the collapsed "Reverse" button) by giving every distinct
 * business action a distinct command object with a distinct discriminator.
 * The saga in Stage 4 pattern-matches on `command.type` and dispatches
 * to the correct RPC / event topic — there is no more "was this a void
 * or a refund?" ambiguity.
 *
 * Design rules:
 *   - Commands are plain data. No RPC calls, no toasts, no I/O.
 *   - The `type` field is the ONLY switch consumers use to branch. Do
 *     not add sibling booleans (`isRefund`, `isVoid`, …) — that was the
 *     original defect.
 *   - Every command carries the `TerminalSessionEnvelope` snapshot it
 *     was constructed with, so the dispatcher never has to re-hydrate
 *     ambient context (see Stage 1).
 *   - Every command carries `clientRequestId` for idempotency (see
 *     `no-pos-commit-without-idempotency-key` ESLint rule).
 */

import type { ActiveTerminalSession } from "../session/TerminalSessionEnvelope";
import type { POSReversalReasonCode, POSReversalCommandType } from "./reasonCodes";

/**
 * Fields every reversal command must carry. `envelope` is intentionally
 * the STRICT `ActiveTerminalSession` (ready === true), not the partial
 * `TerminalSessionEnvelope` — commands cannot be constructed against a
 * half-hydrated terminal.
 */
export interface POSReversalCommandBase<T extends POSReversalCommandType> {
  readonly type: T;
  readonly envelope: ActiveTerminalSession;
  readonly clientRequestId: string;
  readonly reasonCode: POSReversalReasonCode;
  /** Human-entered reason captured alongside the manager override. */
  readonly reason: string;
  /**
   * Manager override id — populated after the Stage-3 policy check when
   * the matrix decided approval was required. `null` means the matrix
   * said no approval was needed for this command with these facts.
   */
  readonly managerOverrideId: string | null;
}

/**
 * Same-shift, pre-settlement void. No money has moved, no goods have
 * left the store. Cheapest path — no GL entry, no fiscal notification,
 * no inventory movement. Just marks the sale as void.
 */
export interface VoidSaleCommand
  extends POSReversalCommandBase<"void_sale"> {
  readonly transactionId: string;
  /** Optional per-item voids; empty ⇒ void the whole sale. */
  readonly itemIds: ReadonlyArray<string>;
}

/**
 * Tender-only reversal of a card authorization. Does NOT return goods,
 * does NOT emit a refund receipt. Wraps the existing `pos_card_reverse`
 * RPC (semantics narrowed by Stage 6). Emits `pos.card.reversed`.
 */
export interface ReverseCardAuthorizationCommand
  extends POSReversalCommandBase<"reverse_card_authorization"> {
  readonly paymentId: string;
  readonly originalAuthorizedAmount: string;
}

/**
 * Money-out reversal against a completed sale. Whole or partial. The
 * finance leg maps `reasonCode` via `toAccountingReason` before calling
 * the ADR-0012 payment reversal path. Goods are NOT moved here — use
 * `ReturnGoodsCommand` if inventory is coming back.
 */
export interface RefundSaleCommand
  extends POSReversalCommandBase<"refund_sale"> {
  readonly transactionId: string;
  readonly refundAmount: string;
  readonly currency: string;
  readonly refundTenderMethod:
    | "cash"
    | "card"
    | "bank_transfer"
    | "store_credit"
    | "mobile_money";
  readonly bankAccountId: string | null;
}

export type GoodsDisposition =
  | "sellable"
  | "inspection"
  | "damaged"
  | "quarantine"
  | "vendor_return";

/**
 * Goods coming back into the warehouse. May or may not be accompanied
 * by a refund; if it is, the saga also constructs a `RefundSaleCommand`
 * in the same transaction.
 */
export interface ReturnGoodsCommand
  extends POSReversalCommandBase<"return_goods"> {
  readonly transactionId: string;
  readonly lines: ReadonlyArray<{
    readonly transactionItemId: string;
    readonly quantity: string;
    readonly disposition: GoodsDisposition;
    readonly locationId: string | null;
  }>;
  readonly refund: RefundSaleCommand | null;
}

/**
 * Atomic return + new sale. Guarantees both legs succeed or both roll
 * back — no half-swaps that leave a customer holding a returned item
 * with no replacement.
 */
export interface ExchangeCommand
  extends POSReversalCommandBase<"exchange"> {
  readonly returnLeg: ReturnGoodsCommand;
  readonly newSaleTransactionId: string;
  /** Additional payment collected / refund owed for the price delta. */
  readonly priceDelta: string;
  readonly priceDeltaCurrency: string;
}

/**
 * Issue store credit instead of refunding money out. Balances stay on
 * the ledger as a customer liability.
 */
export interface IssueStoreCreditCommand
  extends POSReversalCommandBase<"issue_store_credit"> {
  readonly transactionId: string;
  readonly creditAmount: string;
  readonly currency: string;
  readonly customerId: string;
  readonly expiresAt: string | null;
}

/**
 * Discriminated union of every reversal command. The Stage-4 saga
 * dispatches on `command.type` — every branch is checked exhaustively
 * so a new command MUST be handled everywhere the union is consumed.
 */
export type POSReversalCommand =
  | VoidSaleCommand
  | ReverseCardAuthorizationCommand
  | RefundSaleCommand
  | ReturnGoodsCommand
  | ExchangeCommand
  | IssueStoreCreditCommand;

/**
 * Type guards. Prefer these to `command.type === "..."` because the
 * guards return the narrowed type without ceremony at call sites.
 */
export const isVoidSale = (c: POSReversalCommand): c is VoidSaleCommand =>
  c.type === "void_sale";
export const isReverseCardAuthorization = (
  c: POSReversalCommand,
): c is ReverseCardAuthorizationCommand =>
  c.type === "reverse_card_authorization";
export const isRefundSale = (c: POSReversalCommand): c is RefundSaleCommand =>
  c.type === "refund_sale";
export const isReturnGoods = (
  c: POSReversalCommand,
): c is ReturnGoodsCommand => c.type === "return_goods";
export const isExchange = (c: POSReversalCommand): c is ExchangeCommand =>
  c.type === "exchange";
export const isIssueStoreCredit = (
  c: POSReversalCommand,
): c is IssueStoreCreditCommand => c.type === "issue_store_credit";
