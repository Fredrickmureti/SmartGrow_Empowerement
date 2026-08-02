/**
 * Architecture guard — Receiving audit, Phase 8.
 *
 * Receiving is a line-grain execution ledger, not a session-level state flip.
 * These assertions pin the invariants the audit established so a later change
 * cannot quietly re-introduce "one scan completes a truck":
 *
 *   1. No receiving surface transitions a session on a product scan.
 *   2. Line capture happens only through `wms_capture_receiving_line`
 *      (desktop) or the mobile offline queue (which wraps the same RPC in the
 *      replay-guarded dispatcher).
 *   3. Posting happens only through `wms_post_receiving_session`.
 *   4. Receiving labels go through the canonical WMS label keys — no ad-hoc
 *      `receiving_label` template string.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const R = (p: string) => resolve(__dirname, "../", p);
const read = (p: string) => readFileSync(R(p), "utf8");

const WORKSPACE = "features/warehouse/receiving/ReceivingSessionWorkspace.tsx";
const HOOKS = "features/warehouse/receiving/useReceivingLines.ts";
const MOBILE_LOOP = "pages/warehouse-mobile/MobileReceiveSession.tsx";
// Phase 4b retired the after-the-fact staging screen; the session loop is the
// only mobile receiving surface, so it owns the label assertions too.
const SESSIONS_PAGE = "pages/warehouse/ReceivingSessions.tsx";

describe("Receiving — line grain (Phase 8 guards)", () => {
  it("scan handlers capture lines instead of transitioning the session", () => {
    for (const p of [WORKSPACE, MOBILE_LOOP]) {
      const src = read(p);
      expect(src, `${p} must not transition a session from a scan`).not.toMatch(
        /wms_transition_receiving/,
      );
      expect(src).toMatch(/wms_capture_receiving_line|useCaptureReceivingLine/);
    }
  });

  it("capture and posting go through the sanctioned RPCs only", () => {
    const hooks = read(HOOKS);
    expect(hooks).toMatch(/wms_capture_receiving_line/);
    expect(hooks).toMatch(/wms_post_receiving_session/);
    expect(hooks).toMatch(/wms_flag_receiving_variances/);
    expect(hooks).toMatch(/wms_materialize_expected_lines/);
    // Inventory stays the only writer of quants/movements.
    expect(hooks).not.toMatch(/stock_quants|stock_movements/);
  });

  it("the mobile loop only reaches the database through the offline queue", () => {
    const src = read(MOBILE_LOOP);
    expect(src).toMatch(/from "@\/apps\/warehouse-mobile\/offlineQueue"/);
    expect(src, "mobile surfaces must not call supabase.rpc directly").not.toMatch(
      /supabase\.rpc\(/,
    );
  });

  it("the session list captures lines and yields to the workspace", () => {
    const src = read(SESSIONS_PAGE);
    // An item scan must write a line, never flip the session to `captured`.
    expect(src).toMatch(/useCaptureReceivingLine/);
    expect(src).not.toMatch(/to:\s*"captured"/);
    // While the workspace is open it owns the scan stream.
    expect(src).toMatch(/enabled:\s*!activeSession/);
  });

  it("desktop receiving surfaces show scanner presence, and sessions bind the truck", () => {
    for (const p of [SESSIONS_PAGE, WORKSPACE]) {
      expect(read(p), `${p} must render scanner presence feedback`).toMatch(/ScanStatusChip/);
    }
    const src = read(SESSIONS_PAGE);
    // Phase 1 — appointment / dock / supervisor are bound, never left null.
    expect(src).toMatch(/appointment_id/);
    expect(src).toMatch(/dock_id/);
    expect(src).toMatch(/supervisor_id/);
  });


  it("receiving labels use canonical WMS label keys", () => {
    const src = read(MOBILE_RECEIVE);
    expect(src).toMatch(/WMS_LABEL_KEY\.PUTAWAY/);
    expect(src, "ad-hoc receiving_label template must be gone").not.toMatch(
      /["']receiving_label["']/,
    );
  });

  it("capture surfaces stamp the handling unit (Phase 4c)", () => {
    expect(read(WORKSPACE)).toMatch(/lpnId:\s*activeLpn\?\.id/);
    expect(read(MOBILE_LOOP)).toMatch(/p_lpn_id:\s*activeLpn\?\.id/);
  });

  it("the dock board is lane-per-state and the workspace shows the event timeline (Phase 5b)", () => {
    const board = read("features/warehouse/receiving/ReceivingSessionBoard.tsx");
    // Lanes follow the trailer's path; the board never mutates state itself.
    for (const lane of ["open", "unloading", "captured", "discrepant", "posted"]) {
      expect(board).toMatch(new RegExp(`state:\\s*"${lane}"`));
    }
    expect(board, "the board is presentational — transitions belong to the page").not.toMatch(
      /supabase\.|\.rpc\(/,
    );
    expect(read(SESSIONS_PAGE)).toMatch(/ReceivingSessionBoard/);
    expect(read(WORKSPACE)).toMatch(/OutboxTimeline/);
  });
  it("trailer context is read through the yard visit, never re-written (Phase 1 remainder)", () => {
    const hook = read("features/warehouse/receiving/useReceivingTrailerVisits.ts");
    // Resolved through the shared dock appointment — no duplicated columns.
    expect(hook).toMatch(/wms_trailer_visits/);
    expect(hook).toMatch(/appointment_id/);
    // Receiving is a reader: the yard board owns the visit lifecycle.
    expect(hook).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    expect(read("features/warehouse/receiving/ReceivingSessionBoard.tsx")).toMatch(/trailerVisit/);
    expect(read(SESSIONS_PAGE)).toMatch(/useReceivingTrailerVisits/);
  });
});
