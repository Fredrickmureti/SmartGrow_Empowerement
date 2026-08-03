/**
 * Phase C + F guard.
 *
 * C — proof of dispatch is captured through `wms_capture_dispatch_proof`
 *     ONLY. No surface inserts into `wms_dispatch_proofs`, and the client
 *     never decides whether proof is required: it mirrors the server's
 *     `satisfied` flag, which the FSM independently enforces.
 *
 * F — the dispatch and yard surfaces are event-driven. No `refetchInterval`
 *     remains on the manifest / trailer / yard queries, and the realtime
 *     sync hook invalidates the exact key prefixes those pages register.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const BAY = read("src/pages/warehouse/LoadingBay.tsx");
const YARD = read("src/pages/warehouse/YardControlTower.tsx");
const MOBILE = read("src/pages/warehouse-mobile/MobileDispatch.tsx");
const OPS = read("src/features/warehouse/aggregates/useDomainOperations.ts");
const FORM = read("src/features/warehouse/dispatch/DispatchProofForm.tsx");
const SYNC = read("src/features/warehouse/realtime/useWmsRealtimeSync.ts");

describe("wms dispatch proof (Phase C)", () => {
  it("no surface writes wms_dispatch_proofs directly", () => {
    for (const [name, src] of [["LoadingBay", BAY], ["MobileDispatch", MOBILE], ["DispatchProofForm", FORM]] as const) {
      expect(src, `${name} must go through the RPC`).not.toContain('from("wms_dispatch_proofs")');
    }
  });

  it("capture goes through wms_capture_dispatch_proof", () => {
    expect(OPS).toContain("wms_capture_dispatch_proof");
    expect(OPS).toContain("dispatchProofArgs");
  });

  it("the dispatch button mirrors the server rule rather than inventing one", () => {
    expect(BAY).toContain("proofStatus.satisfied");
    expect(BAY).toContain("proofSatisfied");
    // The client must not hardcode the requirement.
    expect(BAY).not.toMatch(/require_dispatch_proof\s*=\s*true/);
  });
});

describe("wms dispatch liveness (Phase F)", () => {
  it("no 15s polls remain on the dispatch and yard surfaces", () => {
    for (const [name, src] of [["LoadingBay", BAY], ["YardControlTower", YARD]] as const) {
      expect(src, `${name} still polls`).not.toMatch(/refetchInterval:\s*15_?000/);
    }
  });

  it("realtime invalidates the key prefixes the Loading Bay actually registers", () => {
    for (const key of ["wms-manifest", "wms-manifest-cartons", "wms-manifest-shortage", "wms-manifest-proof"]) {
      expect(SYNC, `missing invalidation for ${key}`).toContain(`["${key}"]`);
    }
  });

  it("trailer visits and yard slots are subscribed", () => {
    expect(SYNC).toContain("wms_trailer_visits:");
    expect(SYNC).toContain("wms_yard_slots:");
    expect(SYNC).toContain('["wms-trailer-visits"]');
    expect(SYNC).toContain('["wms-yard-slots"]');
  });
});
