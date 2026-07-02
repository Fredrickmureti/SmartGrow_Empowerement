/**
 * ScannerTelemetry — wave-6 close-out tests.
 *
 * Covers initial fetch, verdict filter refetch, and the empty/error
 * render branches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

let rpcCalls: Array<{ name: string; args: any }> = [];
let nextResult: { data: any; error: any } = { data: [], error: null };

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      return nextResult;
    }),
  },
}));

import ScannerTelemetryPage from "@/pages/pos/ScannerTelemetry";

beforeEach(() => {
  rpcCalls = [];
  nextResult = { data: [], error: null };
});

describe("ScannerTelemetry", () => {
  it("calls list_scan_events on mount with default filters", async () => {
    render(<ScannerTelemetryPage />);
    await waitFor(() => expect(rpcCalls.length).toBeGreaterThanOrEqual(1));
    expect(rpcCalls[0].name).toBe("list_scan_events");
    expect(rpcCalls[0].args).toMatchObject({ p_limit: 200, p_verdict: null });
  });

  it("refetches when a verdict chip is clicked", async () => {
    render(<ScannerTelemetryPage />);
    await waitFor(() => expect(rpcCalls.length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "error" }));
    await waitFor(() => expect(rpcCalls.length).toBe(2));
    expect(rpcCalls[1].args.p_verdict).toBe("error");
  });

  it("renders the empty state when no rows return", async () => {
    render(<ScannerTelemetryPage />);
    await waitFor(() =>
      expect(screen.getByText(/no scan events match/i)).toBeInTheDocument(),
    );
  });

  it("renders a returned row with masked code + verdict badge", async () => {
    nextResult = {
      data: [
        {
          id: "evt-1",
          received_at: new Date().toISOString(),
          decoded_at: null,
          register_id: "11111111-2222-3333-4444-555555555555",
          session_id: null,
          device_id: null,
          source: "camera",
          code_masked: "1234…",
          verdict: "ok",
          workflow: "receiving",
          latency_ms: 42,
        },
      ],
      error: null,
    };
    render(<ScannerTelemetryPage />);
    await waitFor(() => expect(screen.getByText("1234…")).toBeInTheDocument());
    expect(screen.getAllByText("ok").length).toBeGreaterThan(0);
    expect(screen.getByText("receiving")).toBeInTheDocument();
  });

  it("surfaces an RPC error", async () => {
    nextResult = { data: null, error: { message: "permission denied" } };
    render(<ScannerTelemetryPage />);
    await waitFor(() =>
      expect(screen.getByText(/permission denied/i)).toBeInTheDocument(),
    );
  });
});
