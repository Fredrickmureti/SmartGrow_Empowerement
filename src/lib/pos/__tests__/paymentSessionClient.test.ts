/**
 * paymentSessionClient — RPC contract tests (Wave 3 · Phase 2).
 *
 * Pins the argument shape and error surface for every session-lifecycle
 * RPC. The architecture guard already ensures no other file calls these
 * RPCs; here we lock the wire format so a future refactor can't silently
 * change the arguments the server expects.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import {
  openSession,
  recordTender,
  reverseTender,
  commitSession,
  cancelSession,
  newIdempotencyKey,
  POSPaymentSessionError,
  paymentSessionClient,
} from "@/lib/pos/paymentSessionClient";

beforeEach(() => {
  rpcMock.mockReset();
});

describe("paymentSessionClient", () => {
  describe("newIdempotencyKey", () => {
    it("mints unique keys per call with the requested prefix", () => {
      const a = newIdempotencyKey("test");
      const b = newIdempotencyKey("test");
      expect(a).not.toBe(b);
      expect(a.startsWith("test:")).toBe(true);
    });

    it("defaults the prefix", () => {
      expect(newIdempotencyKey().startsWith("pos.session:")).toBe(true);
    });
  });

  describe("openSession", () => {
    it("forwards typed args to pos_payment_session_open and returns the session id", async () => {
      rpcMock.mockResolvedValueOnce({ data: "sess-1", error: null });
      const id = await openSession({
        registerId: "reg-1",
        grandTotal: 1000,
        currency: "KES",
        idempotencyKey: "key-1",
        tipAmount: 50,
        cashierId: "cash-1",
      });
      expect(id).toBe("sess-1");
      expect(rpcMock).toHaveBeenCalledWith("pos_payment_session_open", {
        p_register_id: "reg-1",
        p_grand_total: 1000,
        p_currency: "KES",
        p_idempotency_key: "key-1",
        p_tip_amount: 50,
        p_cashier_id: "cash-1",
        p_settlement_currency: "KES",
        p_tip_policy: "none",
        p_fx_rate: 1,
      });


    });

    it("defaults tip_amount to 0 when omitted", async () => {
      rpcMock.mockResolvedValueOnce({ data: "sess-2", error: null });
      await openSession({
        registerId: "reg-1",
        grandTotal: 500,
        currency: "KES",
        idempotencyKey: "k",
      });
      expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_tip_amount: 0 });
    });

    it("refuses an empty idempotency key without calling the RPC", async () => {
      await expect(
        openSession({
          registerId: "reg-1",
          grandTotal: 1,
          currency: "KES",
          idempotencyKey: "",
        }),
      ).rejects.toBeInstanceOf(POSPaymentSessionError);
      expect(rpcMock).not.toHaveBeenCalled();
    });

    it("wraps RPC errors as POSPaymentSessionError with rpc + code", async () => {
      rpcMock.mockResolvedValueOnce({
        data: null,
        error: { message: "boom", code: "22023", hint: "h", details: "d" },
      });
      const err = await openSession({
        registerId: "r",
        grandTotal: 1,
        currency: "KES",
        idempotencyKey: "k",
      }).catch((e) => e);
      expect(err).toBeInstanceOf(POSPaymentSessionError);
      expect(err.rpc).toBe("pos_payment_session_open");
      expect(err.code).toBe("22023");
      expect(err.hint).toBe("h");
    });
  });

  describe("recordTender", () => {
    it("threads the tender jsonb and idempotency key", async () => {
      rpcMock.mockResolvedValueOnce({ data: "tender-1", error: null });
      const tid = await recordTender({
        sessionId: "sess-1",
        idempotencyKey: "key-t1",
        tender: {
          tender_kind: "cash",
          method_key: "cash",
          amount: 200,
          tendered_amount: 250,
          change_given: 50,
        },
      });
      expect(tid).toBe("tender-1");
      expect(rpcMock).toHaveBeenCalledWith("pos_payment_session_record_tender", {
        p_session_id: "sess-1",
        p_idempotency_key: "key-t1",
        p_tender: expect.objectContaining({
          tender_kind: "cash",
          method_key: "cash",
          amount: 200,
        }),
      });
    });

    it("refuses an empty idempotency key", async () => {
      await expect(
        recordTender({
          sessionId: "s",
          idempotencyKey: "",
          tender: { tender_kind: "cash", method_key: "cash", amount: 1 },
        }),
      ).rejects.toBeInstanceOf(POSPaymentSessionError);
      expect(rpcMock).not.toHaveBeenCalled();
    });
  });

  describe("reverseTender", () => {
    it("calls pos_payment_session_reverse_tender with the reason and override envelope", async () => {
      rpcMock.mockResolvedValueOnce({ data: null, error: null });
      await reverseTender({ sessionId: "s", tenderId: "t", reason: "cashier voided" });
      expect(rpcMock).toHaveBeenCalledWith("pos_payment_session_reverse_tender", {
        p_session_id: "s",
        p_tender_id: "t",
        p_reason: "cashier voided",
        p_manager_override_id: null,
        p_organization_id: null,
        p_business_id: null,
        p_shift_id: null,
      });
    });

    it("threads the manager override envelope when supplied", async () => {
      rpcMock.mockResolvedValueOnce({ data: null, error: null });
      await reverseTender({
        sessionId: "s",
        tenderId: "t",
        reason: "manager approved",
        managerOverrideId: "ovr-1",
        organizationId: "org-1",
        businessId: "biz-1",
        shiftId: "shift-1",
      });
      expect(rpcMock).toHaveBeenCalledWith("pos_payment_session_reverse_tender", {
        p_session_id: "s",
        p_tender_id: "t",
        p_reason: "manager approved",
        p_manager_override_id: "ovr-1",
        p_organization_id: "org-1",
        p_business_id: "biz-1",
        p_shift_id: "shift-1",
      });
    });
  });


  describe("commitSession", () => {
    it("forwards the envelope as p_transaction_envelope and returns the full envelope", async () => {
      const serverEnvelope = {
        success: true,
        idempotent_replay: false,
        session_id: "sess-1",
        transaction_id: "txn-1",
        transaction_number: "R-0001",
        change: 0,
        branch_id: "br-1",
      };
      rpcMock.mockResolvedValueOnce({ data: serverEnvelope, error: null });
      const envelope = {
        shift_id: "sh-1",
        items: [{ product_id: "p1", quantity: 1 }],
        subtotal: 100,
        tax_amount: 16,
        discount_amount: 0,
      };
      const result = await commitSession({ sessionId: "sess-1", envelope });
      expect(result.transaction_id).toBe("txn-1");
      expect(result.transaction_number).toBe("R-0001");
      expect(result.session_id).toBe("sess-1");
      expect(rpcMock).toHaveBeenCalledWith("pos_payment_session_commit", {
        p_session_id: "sess-1",
        p_transaction_envelope: envelope,
      });
    });

    it("surfaces server errors on commit", async () => {
      rpcMock.mockResolvedValueOnce({
        data: null,
        error: { message: "not balanced", code: "check_violation" },
      });
      await expect(
        commitSession({
          sessionId: "s",
          envelope: { shift_id: "sh", items: [], subtotal: 0, tax_amount: 0 },
        }),
      ).rejects.toMatchObject({
        rpc: "pos_payment_session_commit",
        code: "check_violation",
      });
    });
  });


  describe("cancelSession", () => {
    it("calls pos_payment_session_cancel with the reason", async () => {
      rpcMock.mockResolvedValueOnce({ data: null, error: null });
      await cancelSession({ sessionId: "s", reason: "customer walked away" });
      expect(rpcMock).toHaveBeenCalledWith("pos_payment_session_cancel", {
        p_session_id: "s",
        p_reason: "customer walked away",
      });
    });
  });

  describe("namespaced export", () => {
    it("exposes the same functions as the named exports", () => {
      expect(paymentSessionClient.openSession).toBe(openSession);
      expect(paymentSessionClient.recordTender).toBe(recordTender);
      expect(paymentSessionClient.reverseTender).toBe(reverseTender);
      expect(paymentSessionClient.commitSession).toBe(commitSession);
      expect(paymentSessionClient.cancelSession).toBe(cancelSession);
      expect(paymentSessionClient.newIdempotencyKey).toBe(newIdempotencyKey);
    });
  });
});
