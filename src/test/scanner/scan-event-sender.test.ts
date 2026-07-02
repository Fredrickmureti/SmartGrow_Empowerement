/**
 * Desk-side scan_events telemetry sender — wire-contract + swallow-errors test.
 *
 * The sender is fire-and-forget: any RPC rejection (rate limit, RLS, network)
 * MUST NOT throw or surface in the UI. The payload shape is the source of
 * truth for `log_scan_event(p jsonb)` and must stay in sync with the DB fn.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn() },
}));

import { supabase } from "@/integrations/supabase/client";
import {
  buildScanEventPayload,
  sendScanEvent,
} from "@/services/scanner/scanEventTelemetry";

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

const base = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  registerId: null,
  deviceId: "phone-abc",
  code: "1234567890",
  seq: 42,
  decodedAt: 1_700_000_000_000,
  verdict: "ok" as const,
  workflow: "identity" as const,
  source: "phone" as const,
};

beforeEach(() => {
  rpc.mockReset();
});

describe("scan_events telemetry payload", () => {
  it("emits the documented field shape", () => {
    const p = buildScanEventPayload(base);
    expect(p).toEqual({
      session_id: base.sessionId,
      register_id: null,
      device_id: "phone-abc",
      code: "1234567890",
      seq: 42,
      decoded_at: new Date(base.decodedAt).toISOString(),
      verdict: "ok",
      workflow: "identity",
      source: "phone",
    });
  });

  it("nulls absent workflow / register_id without throwing", () => {
    const p = buildScanEventPayload({ ...base, workflow: undefined, registerId: undefined });
    expect(p.workflow).toBeNull();
    expect(p.register_id).toBeNull();
  });
});

describe("sendScanEvent", () => {
  it("calls log_scan_event exactly once with the built payload", async () => {
    rpc.mockResolvedValueOnce({ error: null });
    await sendScanEvent(base);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("log_scan_event");
    expect(args).toEqual({ p: buildScanEventPayload(base) });
  });

  it("does not throw when the RPC rejects", async () => {
    rpc.mockRejectedValueOnce(new Error("rate-limited"));
    await expect(sendScanEvent(base)).resolves.toBeUndefined();
  });

  it("does not throw when the RPC returns an error envelope", async () => {
    rpc.mockResolvedValueOnce({ error: { message: "rls denied" } });
    await expect(sendScanEvent(base)).resolves.toBeUndefined();
  });
});