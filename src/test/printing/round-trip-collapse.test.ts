/**
 * Phase 3 guardrail — the interactive path must not re-introduce the
 * sequential hops we collapsed.
 *
 * A POS receipt dispatch used to cost four awaited round trips before a
 * single byte was rendered: `ensure_document_record` RPC →
 * `submit-document-intent` Edge Function (cold boot) → `print_jobs`
 * SELECT → `businesses` SELECT. All four are now one
 * `document_materialize_and_submit_intent` RPC, and the ledger close is
 * one batched `print_jobs_settle` instead of two RPCs per copy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const functionsInvoke = vi.fn();
const from = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
    functions: { invoke: (...args: unknown[]) => functionsInvoke(...args) },
  },
}));

vi.mock("@/services/observability/trace", () => ({
  withTrace: (_meta: unknown, fn: () => unknown) => fn(),
  withSpan: (_name: string, fn: () => unknown) => fn(),
  annotateTrace: () => undefined,
}));

vi.mock("@/services/printing/render", () => ({
  renderDocumentRecord: vi.fn(async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    medium: "escpos",
    mimeType: "application/octet-stream",
    artifactId: null,
  })),
  renderPreviewSnapshot: vi.fn(),
}));

vi.mock("@/services/printing/dispatch", () => ({
  toDevice: vi.fn(async () => ({ success: true, transport: "thermal" })),
  toPage: vi.fn(async () => ({ success: true, transport: "pdf-browser" })),
  toDownload: vi.fn(() => ({ success: true, transport: "download" })),
  pdfTransport: () => "pdf-browser",
  NO_DEVICE_BOUND: "NO_DEVICE_BOUND",
}));

describe("Phase 3 round-trip collapse", () => {
  beforeEach(() => {
    vi.resetModules();
    rpc.mockReset();
    functionsInvoke.mockReset();
    from.mockReset();
  });

  it("materializes, submits and reads back jobs in ONE rpc — no edge hop", async () => {
    rpc.mockResolvedValue({
      data: {
        document_record_id: "rec-1",
        organization_id: "org-1",
        intent_id: "int-1",
        scenario: "default",
        target_count: 1,
        job_ids: ["job-1"],
        jobs: [
          {
            id: "job-1",
            business_id: "biz-1",
            document_record_id: "rec-1",
            disposition: "print",
            medium: "escpos",
            hardware_role: "receipt",
            copies: 1,
            status: "queued",
            render_params: {},
          },
        ],
      },
      error: null,
    });

    const { printSourceDocumentIntent } = await import(
      "@/services/printing/PrintService"
    );

    const result = await printSourceDocumentIntent({
      kindCode: "pos.receipt_customer",
      organizationId: "org-1",
      sourceModule: "pos",
      sourceDocType: "receipt",
      sourceDocId: "txn-1",
      businessId: "biz-1",
    });

    expect(result.document_record_id).toBe("rec-1");
    expect(functionsInvoke).not.toHaveBeenCalled();

    const rpcNames = rpc.mock.calls.map((c) => c[0]);
    expect(rpcNames).toContain("document_materialize_and_submit_intent");
    expect(rpcNames).not.toContain("ensure_document_record");
    expect(rpcNames).not.toContain("submit_document_intent");
    // Exactly one enqueue hop, plus the ledger transitions of the drain.
    expect(
      rpcNames.filter((n) => n === "document_materialize_and_submit_intent"),
    ).toHaveLength(1);
    // No `businesses` SELECT: the org came back with the submission.
    expect(from).not.toHaveBeenCalledWith("businesses");
  });

  it("settles every copy of a print in one batched ledger call", async () => {
    const { settleJobs } = await import("@/services/printing/jobs");
    rpc.mockResolvedValue({ data: 3, error: null });

    await settleJobs(["a", null, "b", undefined, "c"]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("print_jobs_settle", {
      p_ids: ["a", "b", "c"],
      p_hw_command_id: null,
    });
  });

  it("is a no-op when there is nothing to settle", async () => {
    const { settleJobs } = await import("@/services/printing/jobs");
    await settleJobs([null, undefined]);
    expect(rpc).not.toHaveBeenCalled();
  });
});
