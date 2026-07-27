/**
 * Wave 7.2 — dispatchPosReceipt unit tests.
 *
 * A POS receipt reprint is fiscal paper being re-issued: it must always come
 * from the frozen snapshot, must land on the correct document kind for the
 * copy, and must never silently render bytes outside the intent pipeline.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (...a: unknown[]) => from(...(a as [])) },
}));

const ensureDocumentRecord = vi.fn(async () => "rec-1");
const submitDocumentIntent = vi.fn(async () => ({
  document_record_id: "rec-1",
  intent_id: "int-1",
  scenario: "default",
  job_ids: ["job-1"],
  target_count: 1,
}));

vi.mock("@/services/documents/ensureDocumentRecord", () => ({
  ensureDocumentRecord: (...a: unknown[]) =>
    ensureDocumentRecord(...(a as [])),
}));
vi.mock("@/services/documents/submitIntent", () => ({
  submitDocumentIntent: (...a: unknown[]) => submitDocumentIntent(...(a as [])),
}));

import { dispatchPosReceipt } from "@/features/pos/receipts/dispatchPosReceipt";

const payload = {
  schema_version: 1,
  transaction: {
    id: "txn-1",
    receipt_number: "R-2026-0001",
    transacted_at: "2026-07-20T10:15:00Z",
    status: "PAID",
    currency: "KES",
    total_amount: 1160,
  },
  items: [],
  payments: [],
  business: { id: "biz-1" },
  branch: { id: "br-1" },
  organization: { id: "org-1" },
  customer: { id: "cust-1", name: "Jane" },
  cashier: { id: "u-1", name: "Ann", email: null },
  register: { id: "reg-1", code: "R1" },
  business_receipt_settings: null,
  register_receipt_settings: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  maybeSingle.mockResolvedValue({ data: { payload }, error: null });
});

describe("dispatchPosReceipt", () => {
  it("reads the frozen snapshot rather than live tables", async () => {
    await dispatchPosReceipt({ transactionId: "txn-1" });
    expect(from).toHaveBeenCalledWith("pos_receipt_snapshots");
    expect(eq).toHaveBeenCalledWith("transaction_id", "txn-1");
  });

  it("routes the customer copy to pos.receipt_customer with frozen tenancy", async () => {
    const result = await dispatchPosReceipt({ transactionId: "txn-1" });
    const arg = ensureDocumentRecord.mock.calls[0][0] as Record<string, any>;
    expect(arg.kindCode).toBe("pos.receipt_customer");
    expect(arg.organizationId).toBe("org-1");
    expect(arg.businessId).toBe("biz-1");
    expect(arg.branchId).toBe("br-1");
    expect(arg.sourceModule).toBe("pos");
    expect(arg.sourceDocId).toBe("txn-1");
    expect(arg.documentNumber).toBe("R-2026-0001");
    expect(arg.documentDate).toBe("2026-07-20");
    expect(arg.partyKind).toBe("customer");
    expect(arg.partyId).toBe("cust-1");
    expect(result).toEqual({ documentRecordId: "rec-1", targetCount: 1 });
  });

  it("routes the merchant copy to its own kind", async () => {
    await dispatchPosReceipt({ transactionId: "txn-1", copy: "merchant" });
    const arg = ensureDocumentRecord.mock.calls[0][0] as Record<string, any>;
    expect(arg.kindCode).toBe("pos.receipt_merchant");
    expect(arg.sourceDocType).toBe("receipt_merchant");
    expect((arg.snapshot as any).document_type_label).toBe("MERCHANT COPY");
  });

  it("defaults to a reprint trigger and submits exactly one intent", async () => {
    await dispatchPosReceipt({ transactionId: "txn-1" });
    expect(submitDocumentIntent).toHaveBeenCalledTimes(1);
    expect(submitDocumentIntent.mock.calls[0][0]).toEqual({
      documentRecordId: "rec-1",
      triggeredSource: "reprint",
    });
  });

  it("refuses to fabricate a receipt when no frozen snapshot exists", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      dispatchPosReceipt({ transactionId: "txn-x" }),
    ).rejects.toThrow(/No frozen receipt snapshot/);
    expect(ensureDocumentRecord).not.toHaveBeenCalled();
  });

  it("falls back to the caller organization only when the snapshot lacks one", async () => {
    maybeSingle.mockResolvedValue({
      data: { payload: { ...payload, organization: null } },
      error: null,
    });
    await dispatchPosReceipt({
      transactionId: "txn-1",
      organizationId: "org-fallback",
    });
    const arg = ensureDocumentRecord.mock.calls[0][0] as Record<string, any>;
    expect(arg.organizationId).toBe("org-fallback");
  });

  it("throws when no organization can be resolved at all", async () => {
    maybeSingle.mockResolvedValue({
      data: { payload: { ...payload, organization: null } },
      error: null,
    });
    await expect(
      dispatchPosReceipt({ transactionId: "txn-1" }),
    ).rejects.toThrow(/cannot resolve organization/);
  });
});
