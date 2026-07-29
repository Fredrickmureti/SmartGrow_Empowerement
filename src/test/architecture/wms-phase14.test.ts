/**
 * Architecture guard — WMS Phase 14 (E2E harness scaffolding).
 *
 * 14a (this guard):
 *   - Every named spec file exists.
 *   - Each spec names the RPCs it will exercise in a comment block —
 *     grep-verified here so refactors can't silently drop coverage.
 *   - Playwright config lists both `wms` and `wm` projects.
 *   - Seed + auth support helpers exist so 14b–14g don't drift on API.
 *
 * 14b–14g (later): each sub-phase removes its `describe.skip(...)` and
 * lands real assertions. This guard does NOT check that a spec is
 * unskipped — the presence of `describe.skip` is intentional until the
 * matching sub-phase ships. When 14g lands, extend this test to also
 * assert no `describe.skip` remains in `e2e/`.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");

// RPC names below MUST match `pg_proc.proname` exactly. Phase 14a.1 audit
// (2026-07-18) reconciled these against the live schema — do not rename
// without confirming the DB function still exists under the new name.
const SPECS: Array<{ file: string; rpcs: string[] }> = [
  {
    file: "e2e/wms/receive.spec.ts",
    rpcs: [
      "create_goods_receipt",
      "record_goods_receipt_line",
      "complete_goods_receipt_atomic",
    ],
  },
  {
    file: "e2e/wms/putaway.spec.ts",
    rpcs: ["suggest_putaway_locations", "assign_wms_task", "complete_putaway_task"],
  },
  {
    file: "e2e/wms/wave.spec.ts",
    rpcs: ["create_pick_wave", "release_pick_wave", "cancel_pick_wave"],
  },
  {
    file: "e2e/wms/pick-pack-dispatch.spec.ts",
    rpcs: [
      "claim_pick_task",
      "complete_pick_task",
      "open_pack_carton",
      "assign_carton_to_pack",
      "seal_pack_carton",
      "complete_pack_task",
      "open_loading_manifest",
      "load_carton_onto_manifest",
      "close_loading_manifest",
      "dispatch_loading_manifest",
    ],
  },
  {
    file: "e2e/wms/qc.spec.ts",
    rpcs: [
      "open_qc_inspection",
      "accept_qc_inspection",
      "reject_qc_inspection",
      "cancel_qc_inspection",
    ],
  },
  {
    file: "e2e/wms/realtime-contention.spec.ts",
    rpcs: ["wms_claim_next_task", "wms_transition_task"],
  },
  {
    file: "e2e/wms/count.spec.ts",
    rpcs: [
      "create_count_session",
      "record_count_scan",
      "approve_count_variance",
      "post_count_session",
    ],
  },
];


const MOBILE_SPEC = "e2e/wm/offline-drain.spec.ts";
const SUPPORT_FILES = ["e2e/support/auth.ts", "e2e/support/seed.ts"];
const CONFIG_FILE = "playwright.config.ts";

describe("wms phase 14 — E2E harness scaffolding", () => {
  it("playwright.config.ts exists and declares both projects", () => {
    const p = path.join(ROOT, CONFIG_FILE);
    expect(existsSync(p), `${CONFIG_FILE} missing`).toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).toMatch(/name:\s*["']wms["']/);
    expect(src).toMatch(/name:\s*["']wm["']/);
  });

  it("support helpers exist", () => {
    for (const f of SUPPORT_FILES) {
      expect(existsSync(path.join(ROOT, f)), `${f} missing`).toBe(true);
    }
  });

  it("every desktop spec file exists and names its RPCs", () => {
    for (const { file, rpcs } of SPECS) {
      const p = path.join(ROOT, file);
      expect(existsSync(p), `${file} missing`).toBe(true);
      const src = readFileSync(p, "utf8");
      for (const rpc of rpcs) {
        expect(src, `${file} must reference RPC ${rpc}`).toContain(rpc);
      }
    }
  });

  it("mobile offline-drain spec file exists", () => {
    expect(existsSync(path.join(ROOT, MOBILE_SPEC)), `${MOBILE_SPEC} missing`).toBe(true);
  });

  it("no e2e spec still uses describe.skip (Phase 14i)", () => {
    // Enumerate the directory rather than the SPECS table so a newly added
    // spec cannot ship scaffolded-out.
    const allSpecs = [
      ...readdirSync(path.join(ROOT, "e2e/wms"))
        .filter((f) => f.endsWith(".spec.ts"))
        .map((f) => `e2e/wms/${f}`),
      ...readdirSync(path.join(ROOT, "e2e/wm"))
        .filter((f) => f.endsWith(".spec.ts"))
        .map((f) => `e2e/wm/${f}`),
    ];
    expect(allSpecs.length).toBeGreaterThanOrEqual(SPECS.length + 1);
    for (const f of allSpecs) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      expect(src, `${f} still uses describe.skip — unskip when the sub-phase ships`)
        .not.toMatch(/describe\.skip\s*\(/);
    }
  });
});
