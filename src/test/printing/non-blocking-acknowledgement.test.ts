/**
 * Phase 2 guardrail — the cashier must be released at "queued", never at
 * "printer finished". `startPrintDocument` therefore has to resolve while
 * the render/dispatch chain is still in flight.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const openJob = vi.fn();
const renderMock = vi.fn();

vi.mock("@/services/printing/policy", () => ({
  resolvePrintPolicy: vi.fn(async () => ({ renderMode: "escpos", copies: 1, paperFormat: "80mm" })),
}));

vi.mock("@/services/printing/jobs", () => ({
  openJob: (...args: unknown[]) => openJob(...args),
  loadJobs: vi.fn(async () => []),
  claimForForeground: vi.fn(async () => null),
  settleJobs: vi.fn(async () => undefined),
  noopJobHandle: () => ({
    id: null,
    markSent: async () => undefined,
    markAcked: async () => undefined,
    markFailed: async () => undefined,
  }),
}));

vi.mock("@/services/printing/render", () => ({
  renderDocumentRecord: (...args: unknown[]) => renderMock(...args),
  renderPreviewSnapshot: (...args: unknown[]) => renderMock(...args),
}));

vi.mock("@/services/documents/resolveSourceDocumentRecord", () => ({
  resolveSourceDocumentRecordId: vi.fn(async () => "rec-1"),
}));

vi.mock("@/services/observability/trace", () => ({
  withTrace: (_meta: unknown, fn: () => unknown) => fn(),
  withSpan: (_name: string, fn: () => unknown) => fn(),
  annotateTrace: () => undefined,
}));

describe("startPrintDocument", () => {
  beforeEach(() => {
    vi.resetModules();
    openJob.mockReset();
    renderMock.mockReset();
  });

  it("acknowledges once the ledger row exists, before the render settles", async () => {
    let releaseRender!: () => void;
    const renderStarted = new Promise<void>((resolveStarted) => {
      renderMock.mockImplementation(
        () =>
          new Promise((resolveRender) => {
            resolveStarted();
            releaseRender = () =>
              resolveRender({ bytes: new Uint8Array([1]), medium: "escpos" });
          }),
      );
    });

    openJob.mockResolvedValue({
      id: "job-1",
      markSent: async () => undefined,
      markAcked: async () => undefined,
      markFailed: async () => undefined,
    });

    const { startPrintDocument } = await import("@/services/printing/PrintService");

    let completed = false;
    const ack = await startPrintDocument({
      documentType: "pos_receipt",
      documentId: "txn-1",
      businessId: "biz-1",
      medium: "escpos",
    });
    void ack.completion.then(() => {
      completed = true;
    });

    expect(ack.queued).toBe(true);
    expect(ack.jobIds).toEqual(["job-1"]);
    expect(completed).toBe(false);

    await renderStarted;
    expect(completed).toBe(false);
    releaseRender();
  });
});
