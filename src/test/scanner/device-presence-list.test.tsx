/**
 * DevicePresenceList — wave-5 close-out tests.
 *
 * Covers the "Active" pill TTL behavior (which is the deferred contract
 * we wired up this loop) and the AI/fallback Suggest path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/integrations/supabase/client", () => {
  const rpcResults: Record<string, any> = {
    list_scan_events: { data: [{ workflow: "receiving" }, { workflow: "receiving" }], error: null },
    pos_rename_scanner_device: { data: { label: "Receiving · iPhone" }, error: null },
  };
  return {
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
      rpc: (name: string) => Promise.resolve(rpcResults[name] ?? { data: null, error: null }),
      functions: {
        invoke: vi.fn(async () => ({
          data: { suggestions: ["Receiving · iPhone", "Till 2 Backup", "Bay 3 Phone"], source: "ai" },
          error: null,
        })),
      },
    },
  };
});

import { DevicePresenceList } from "@/components/scanner/DevicePresenceList";

const device = {
  user_id: "dev-1",
  device_label: "iPhone",
  online_at: new Date().toISOString(),
};

describe("DevicePresenceList — Active pill TTL", () => {
  beforeEach(() => vi.useRealTimers());

  it("shows the Active badge for a recent scan and hides it past TTL", async () => {
    const recent = { "dev-1": Date.now() - 5_000 };
    const { rerender } = render(
      <DevicePresenceList sessionId="reg-1" devices={[device]} lastScanByDevice={recent} />,
    );
    expect(await screen.findByText("Active")).toBeInTheDocument();

    rerender(
      <DevicePresenceList
        sessionId="reg-1"
        devices={[device]}
        lastScanByDevice={{ "dev-1": Date.now() - 60_000 }}
      />,
    );
    await waitFor(() => expect(screen.queryByText("Active")).not.toBeInTheDocument());
  });

  it("renders no badge when no device activity is reported", () => {
    render(<DevicePresenceList sessionId="reg-1" devices={[device]} />);
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });
});

describe("DevicePresenceList — Suggest chip", () => {
  it("opens rename editor and shows AI-backed suggestions", async () => {
    render(<DevicePresenceList sessionId="reg-1" registerName="Till 2" devices={[device]} />);
    fireEvent.click(screen.getByLabelText("Rename scanner"));
    fireEvent.click(screen.getByText("Suggest"));
    expect(await screen.findByText("Receiving · iPhone")).toBeInTheDocument();
  });
});