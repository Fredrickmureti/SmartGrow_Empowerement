/**
 * SalesScanContext integration tests — covers the contracts the prior
 * agent shipped but did not test:
 *   1. Late-mounting controller drains the FIFO replay queue.
 *   2. An open-draft handler never fires when a controller is registered.
 *   3. Auto-open-draft is gated behind `mode === "rapid"`.
 *   4. No double-apply: a scan routed to the open-draft path is NOT also
 *      queued for the next controller to consume.
 *   5. Mode is persisted per (business, user) in localStorage and does
 *      not leak across logins.
 *
 * Strategy: mock `useScanTarget` so the test captures the provider's
 * `onScan` callback and invokes it directly. Mock `useResolveBarcode`
 * so `resolveTagged` returns deterministic hits.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";

// ---- Hook mocks -------------------------------------------------------

let capturedOnScan: ((event: { code: string }) => void) | null = null;
vi.mock("@/hooks/scanner", async () => {
  return {
    useScanTarget: (opts: { onScan: (event: { code: string }) => void }) => {
      capturedOnScan = opts.onScan;
    },
    useResolveBarcode: () => ({
      resolveTagged: async (code: string) => ({
        kind: "hit" as const,
        row: { product_id: `p-${code}`, name: `Product ${code}`, scanQuantity: 1 } as any,
      }),
    }),
  };
});

let currentBusinessId: string = "biz-1";
let currentUserId: string = "user-1";
vi.mock("@/hooks/useBusinesses", () => ({
  useBusinesses: () => ({ currentBusiness: { id: currentBusinessId } }),
}));
vi.mock("@/hooks/useBranches", () => ({
  useBranches: () => ({ currentBranch: { id: "branch-1" } }),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: currentUserId } }),
}));

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@/services/scanner", () => ({
  scanFeedbackBus: { emit: vi.fn() },
}));

vi.mock("@/services/resilience", () => ({
  normalizeError: (e: any) => ({ message: e?.message ?? "err" }),
}));

// Import AFTER mocks are registered.
import {
  SalesScanProvider,
  useSalesScanController,
  useSalesOpenDraftHandler,
  useSalesScanMode,
} from "@/contexts/SalesScanContext";

// ---- Test helpers -----------------------------------------------------

function Controller({ fn }: { fn: (r: any) => void }) {
  useSalesScanController(fn);
  return null;
}
function OpenDraft({ fn }: { fn: (r: any) => void }) {
  useSalesOpenDraftHandler(fn);
  return null;
}
function ModeSetter({ mode }: { mode: "rapid" | "browse" }) {
  const { setMode } = useSalesScanMode();
  useEffect(() => { setMode(mode); }, [mode, setMode]);
  return null;
}

async function flushAsync() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

// ---- Tests ------------------------------------------------------------

describe("SalesScanContext", () => {
  beforeEach(() => {
    capturedOnScan = null;
    toastSpy.mockReset();
    currentBusinessId = "biz-1";
    currentUserId = "user-1";
    localStorage.clear();
  });

  it("late-mounting controller drains buffered scans", async () => {
    const ctrl = vi.fn();
    const { rerender } = render(
      <SalesScanProvider>
        <ModeSetter mode="browse" />
      </SalesScanProvider>,
    );
    expect(capturedOnScan).toBeTypeOf("function");

    // Two scans arrive before any dialog mounts (browse mode -> queued).
    // Resolve serially — `handleScan` is single-flight via `inFlightRef`.
    await act(async () => { capturedOnScan!({ code: "A1" }); });
    await flushAsync();
    await act(async () => { capturedOnScan!({ code: "A2" }); });
    await flushAsync();

    // Late-mounting controller: should receive both queued scans on rAF.
    rerender(
      <SalesScanProvider>
        <ModeSetter mode="browse" />
        <Controller fn={ctrl} />
      </SalesScanProvider>,
    );
    await act(async () => { await nextFrame(); });
    expect(ctrl).toHaveBeenCalledTimes(2);
    expect(ctrl.mock.calls[0][0].product_id).toBe("p-A1");
    expect(ctrl.mock.calls[1][0].product_id).toBe("p-A2");
  });

  it("controller wins over open-draft handler when both registered", async () => {
    const ctrl = vi.fn();
    const openDraft = vi.fn();
    render(
      <SalesScanProvider>
        <ModeSetter mode="rapid" />
        <Controller fn={ctrl} />
        <OpenDraft fn={openDraft} />
      </SalesScanProvider>,
    );
    await act(async () => { capturedOnScan!({ code: "B1" }); });
    await flushAsync();
    expect(ctrl).toHaveBeenCalledTimes(1);
    expect(openDraft).not.toHaveBeenCalled();
  });

  it("auto-open-draft is gated by rapid mode", async () => {
    const openDraft = vi.fn();
    const { rerender } = render(
      <SalesScanProvider>
        <ModeSetter mode="browse" />
        <OpenDraft fn={openDraft} />
      </SalesScanProvider>,
    );
    await act(async () => { capturedOnScan!({ code: "C1" }); });
    await flushAsync();
    expect(openDraft).not.toHaveBeenCalled();

    rerender(
      <SalesScanProvider>
        <ModeSetter mode="rapid" />
        <OpenDraft fn={openDraft} />
      </SalesScanProvider>,
    );
    await flushAsync();
    await act(async () => { capturedOnScan!({ code: "C2" }); });
    await flushAsync();
    expect(openDraft).toHaveBeenCalledTimes(1);
    expect(openDraft.mock.calls[0][0].product_id).toBe("p-C2");
  });

  it("does not double-apply: open-draft path skips the replay queue", async () => {
    const openDraft = vi.fn();
    const lateCtrl = vi.fn();
    const { rerender } = render(
      <SalesScanProvider>
        <ModeSetter mode="rapid" />
        <OpenDraft fn={openDraft} />
      </SalesScanProvider>,
    );
    await act(async () => { capturedOnScan!({ code: "D1" }); });
    await flushAsync();
    expect(openDraft).toHaveBeenCalledTimes(1);

    // The simulated newly-opened dialog now registers a controller. The
    // same scan must NOT be replayed into it.
    rerender(
      <SalesScanProvider>
        <ModeSetter mode="rapid" />
        <OpenDraft fn={openDraft} />
        <Controller fn={lateCtrl} />
      </SalesScanProvider>,
    );
    await act(async () => { await nextFrame(); });
    expect(lateCtrl).not.toHaveBeenCalled();
  });

  it("persists mode per (business, user) and does not leak across logins", async () => {
    const { unmount } = render(
      <SalesScanProvider>
        <ModeSetter mode="rapid" />
      </SalesScanProvider>,
    );
    await flushAsync();
    expect(localStorage.getItem("sales.scan.mode:biz-1:user-1")).toBe("rapid");
    unmount();

    // Same identity → mode rehydrates as rapid.
    let observed: "rapid" | "browse" | null = null;
    function Probe() {
      const { mode } = useSalesScanMode();
      useEffect(() => { observed = mode; }, [mode]);
      return null;
    }
    const { unmount: u2 } = render(
      <SalesScanProvider><Probe /></SalesScanProvider>,
    );
    await flushAsync();
    expect(observed).toBe("rapid");
    u2();

    // Different business → defaults to browse (no leak).
    currentBusinessId = "biz-2";
    observed = null;
    render(
      <SalesScanProvider><Probe /></SalesScanProvider>,
    );
    await flushAsync();
    expect(observed).toBe("browse");
  });
});
