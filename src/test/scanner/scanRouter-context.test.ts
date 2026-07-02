/**
 * scanRouter — active workspace context drives scan_events emission.
 *
 * Group C #3: every consumed scan with an active register/session
 * context lands in `scan_events` via `log_scan_event`; without context
 * the RPC is skipped (the DB fn would drop the row anyway).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn().mockResolvedValue({ error: null }) },
}));

import { supabase } from "@/integrations/supabase/client";
import { scanRouter } from "@/services/pos/scanRouter";
import { scanBus, type ScanEvent } from "@/services/pos/scanBus";

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

function makeEvent(over: Partial<ScanEvent> = {}): ScanEvent {
  return {
    raw: "1234567890",
    code: "1234567890",
    quantity: 1,
    at: 1_700_000_000_000,
    source: "keyboard",
    ...over,
  };
}

describe("scanRouter — scan_events emission (Group C #3)", () => {
  beforeEach(() => {
    scanRouter._clear();
    rpc.mockClear();
  });

  it("calls log_scan_event when a register context is active", () => {
    scanRouter.register({
      id: "cart",
      priority: 0,
      workflow: "identity",
      onScan: () => {},
    });
    scanRouter.setActiveContext({ register_id: "reg-1" });
    scanBus.emit(makeEvent());
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("log_scan_event");
    expect((args as { p: Record<string, unknown> }).p).toMatchObject({
      register_id: "reg-1",
      session_id: null,
      code: "1234567890",
      source: "wedge",
      verdict: "ok",
      workflow: "identity",
    });
  });

  it("calls log_scan_event when a session context is active", () => {
    scanRouter.register({ id: "count", priority: 10, onScan: () => {} });
    scanRouter.setActiveContext({ session_id: "sess-1" });
    scanBus.emit(makeEvent({ code: "9999999999", raw: "9999999999", at: 1_700_000_001_000, source: "camera" }));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls[0][1] as { p: Record<string, unknown> }).p).toMatchObject({
      session_id: "sess-1",
      register_id: null,
      source: "camera",
    });
  });

  it("skips the RPC when no context is active", () => {
    scanRouter.register({ id: "cart", priority: 0, onScan: () => {} });
    scanBus.emit(makeEvent());
    expect(rpc).not.toHaveBeenCalled();
  });

  it("skips the RPC after the context is cleared", () => {
    scanRouter.register({ id: "cart", priority: 0, onScan: () => {} });
    scanRouter.setActiveContext({ register_id: "reg-1" });
    scanRouter.setActiveContext(null);
    scanBus.emit(makeEvent());
    expect(rpc).not.toHaveBeenCalled();
  });

  it("never throws when no target is registered (no emission either)", () => {
    scanRouter.setActiveContext({ register_id: "reg-1" });
    expect(() => scanBus.emit(makeEvent())).not.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls log_scan_event when only a workspace context is active", () => {
    scanRouter.register({
      id: "products",
      priority: 5,
      workflow: "identity",
      onScan: () => {},
    });
    scanRouter.setActiveContext({ workspace_id: "products" });
    scanBus.emit(makeEvent({ code: "7501055361007", raw: "7501055361007" }));
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("log_scan_event");
    expect((args as { p: Record<string, unknown> }).p).toMatchObject({
      workspace_id: "products",
      register_id: null,
      session_id: null,
      code: "7501055361007",
      verdict: "ok",
    });
  });

  it("audits PhysicalCount scans under workspace_id='physical_count'", () => {
    scanRouter.register({ id: "count", priority: 10, workflow: "count", onScan: () => {} });
    scanRouter.setActiveContext({ workspace_id: "physical_count" });
    scanBus.emit(makeEvent({ code: "PC-1", raw: "PC-1", source: "camera" }));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls[0][1] as { p: Record<string, unknown> }).p).toMatchObject({
      workspace_id: "physical_count",
      register_id: null,
      session_id: null,
      code: "PC-1",
      source: "camera",
    });
  });

  it("audits GRN scans under workspace_id='grn'", () => {
    scanRouter.register({ id: "grn", priority: 10, workflow: "receive", onScan: () => {} });
    scanRouter.setActiveContext({ workspace_id: "grn" });
    scanBus.emit(makeEvent({ code: "GRN-1", raw: "GRN-1" }));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls[0][1] as { p: Record<string, unknown> }).p).toMatchObject({
      workspace_id: "grn",
      register_id: null,
      session_id: null,
      code: "GRN-1",
    });
  });
});
