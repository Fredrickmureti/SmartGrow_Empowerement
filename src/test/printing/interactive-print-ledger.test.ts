/**
 * Wave B3 (Plan P2 Step 1) — every interactive print fired from
 * `PrintPreviewDialog` must produce a `print_jobs` ledger row.
 *
 * Prior to this wave, the dialog called `printPdfInPage` /
 * `printRawBytes` directly, bypassing `PrintClient.print()` — so the
 * `ask_user` policy branch (and every legacy shadow-path surface still
 * on `useDocumentPrint`) had zero audit coverage. This test locks in
 * the contract of `printClient.recordInteractivePrint()`: it inserts a
 * ledger row via the `print_job_insert` RPC, returns markSent /
 * markFailed handles, and never blocks or throws when the ledger is
 * unavailable.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const rpcMock = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: rpcMock },
}));

describe("printClient.recordInteractivePrint (Plan P2 Step 1)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    vi.resetModules();
  });

  it("inserts a ledger row and exposes markSent/markFailed handles", async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === "print_job_insert") return Promise.resolve({ data: "job-42", error: null });
      return Promise.resolve({ data: null, error: null });
    });
    const { printClient } = await import("@/services/printing/PrintClient");

    const handle = await printClient.recordInteractivePrint({
      documentType: "invoice",
      documentId: "inv-1",
      intent: "a4_document",
      format: "pdf",
      businessId: "biz-1",
      branchId: "br-1",
    });

    expect(handle.jobId).toBe("job-42");
    const insertCall = rpcMock.mock.calls.find((c) => c[0] === "print_job_insert");
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toMatchObject({
      p_business_id: "biz-1",
      p_branch_id: "br-1",
      p_doc_type: "invoice",
      p_doc_id: "inv-1",
      p_intent: "a4_document",
      p_format: "pdf",
    });

    await handle.markSent();
    expect(rpcMock).toHaveBeenCalledWith("print_job_mark_sent", { p_id: "job-42", p_hw_command_id: null });

    await handle.markFailed("boom");
    expect(rpcMock).toHaveBeenCalledWith("print_job_mark_failed", { p_id: "job-42", p_error: "boom" });
  });

  it("returns a no-op handle without touching the ledger when businessId is null", async () => {
    const { printClient } = await import("@/services/printing/PrintClient");
    const handle = await printClient.recordInteractivePrint({
      documentType: "invoice",
      documentId: "inv-1",
      intent: "a4_document",
      format: "pdf",
      businessId: null,
    });
    expect(handle.jobId).toBeNull();
    await handle.markSent();
    await handle.markFailed("x");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("never throws when the ledger RPC errors — printing must not be blocked", async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === "print_job_insert") return Promise.resolve({ data: null, error: { message: "rls" } });
      return Promise.resolve({ data: null, error: null });
    });
    const { printClient } = await import("@/services/printing/PrintClient");
    const handle = await printClient.recordInteractivePrint({
      documentType: "invoice",
      documentId: "inv-1",
      intent: "a4_document",
      format: "pdf",
      businessId: "biz-1",
    });
    expect(handle.jobId).toBeNull();
    await expect(handle.markSent()).resolves.toBeUndefined();
    await expect(handle.markFailed("x")).resolves.toBeUndefined();
  });
});
