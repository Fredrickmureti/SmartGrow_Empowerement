/**
 * Phase 5.4 / 5.5 guardrails.
 *
 * 5.4 — a paper job is terminal when the host print dialog takes the bytes.
 *       `toPage` must surface that moment so the ledger settles there instead
 *       of waiting however long a human takes to dismiss the OS dialog.
 * 5.5 — a claimed row on a host-dialog transport is stranded, not replayable:
 *       the sweeper must close it as `abandoned` rather than reprint it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const printPdfInPage = vi.fn();
const strandJobs = vi.fn(async (ids: string[]) => ids.length);
const dispatchQueuedJob = vi.fn(async () => ({ transport: "thermal" as const }));

vi.mock("@/services/printing/pdfUtils", () => ({
  printPdfInPage: (...args: unknown[]) => printPdfInPage(...args),
  downloadPdfBlob: vi.fn(),
}));

vi.mock("@/services/hardware/execForIntent", () => ({
  execForIntent: vi.fn(async () => ({ success: true })),
  NO_DEVICE_BOUND: "no_device_bound",
}));

describe("Phase 5.4 — PDF settles at host handoff", () => {
  beforeEach(() => {
    vi.resetModules();
    printPdfInPage.mockReset();
  });

  it("toPage reports the handoff before the dialog closes", async () => {
    let releaseDialog!: () => void;
    printPdfInPage.mockImplementation(
      (_blob: Blob, opts?: { onHandedToHost?: () => void }) =>
        new Promise<void>((resolve) => {
          opts?.onHandedToHost?.();
          releaseDialog = () => resolve();
        }),
    );

    const { toPage } = await import("@/services/printing/dispatch");
    let handedOff = false;
    const pending = toPage(new Blob(["%PDF"]), {
      onHandedToHost: () => {
        handedOff = true;
      },
    });

    await Promise.resolve();
    expect(handedOff).toBe(true);

    releaseDialog();
    const outcome = await pending;
    expect(outcome.success).toBe(true);
  });
});

describe("Phase 5.5 — stranded rows are closed, not reprinted", () => {
  beforeEach(() => {
    vi.resetModules();
    strandJobs.mockClear();
    dispatchQueuedJob.mockClear();
  });

  it("strands host-dialog rows and replays only device rows", async () => {
    const rows = [
      { id: "pdf-1", status: "sent", transport: "pdf-browser", disposition: "print" },
      { id: "pdf-2", status: "sent", transport: "pdf-electron", disposition: "print" },
      { id: "thermal-1", status: "queued", transport: "thermal", disposition: "print" },
    ];

    vi.doMock("@/integrations/supabase/client", () => ({
      supabase: {
        from: () => ({
          select: () => ({
            eq: () => ({
              in: () => ({
                lt: () => ({
                  order: () => ({
                    limit: async () => ({ data: rows, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
      },
    }));
    vi.doMock("@/services/printing/jobs", () => ({
      strandJobs: (...args: unknown[]) => strandJobs(...(args as [string[]])),
    }));
    vi.doMock("@/services/printing/PrintService", () => ({
      dispatchQueuedJob: (...args: unknown[]) => dispatchQueuedJob(...(args as [])),
      resolveOrganizationId: async () => "org-1",
    }));

    const { sweepAbandonedPrintJobs } = await import("@/services/printing/recovery");
    const res = await sweepAbandonedPrintJobs("biz-1");

    expect(strandJobs).toHaveBeenCalledTimes(1);
    expect(strandJobs.mock.calls[0][0]).toEqual(["pdf-1", "pdf-2"]);
    expect(res.stranded).toBe(2);
    expect(dispatchQueuedJob).toHaveBeenCalledTimes(1);
    expect(res.recovered).toBe(1);
  });
});
