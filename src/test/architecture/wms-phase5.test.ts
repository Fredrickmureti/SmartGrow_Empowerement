/**
 * Architecture guard — WMS Phase 5 (Loading & dispatch).
 *
 * Warehouse pages must never mutate loading-manifest tables or the
 * `manifest_id` link on `wms_pack_cartons` directly. Every state
 * transition flows through the sanctioned RPCs below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { checkRpcOwnership, pageCallsRpc } from "./wmsGuardUtils";


const SRC = path.resolve(__dirname, "../..");
const SELF = __filename;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("wms phase 5 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("no client code mutates wms_loading_manifests directly", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/from\(\s*["']wms_loading_manifests["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/.test(src)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders, `Manifests must be opened/closed/dispatched via RPCs:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no client code mutates wms_manifest_cartons directly", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/from\(\s*["']wms_manifest_cartons["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/.test(src)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders, `Load cartons via load_carton_onto_manifest:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no page updates wms_pack_cartons.manifest_id directly", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/from\(\s*["']wms_pack_cartons["']\s*\)\s*\.update\s*\(\s*\{[^}]*manifest_id\s*:/s.test(src)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders, `manifest_id is stamped by load_carton_onto_manifest:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("dispatch pages call the sanctioned RPCs", () => {
    // open_loading_manifest / close_loading_manifest are not on the
    // domain-RPC ban list — those pages still own their call sites.
    expect(pageCallsRpc("LoadingManifestPlanner.tsx", "open_loading_manifest")).toBe(true);
    expect(pageCallsRpc("LoadingBay.tsx", "close_loading_manifest")).toBe(true);
    // Loading + dispatch moved behind typed wrappers (Phase 2.4 §3).
    const a = checkRpcOwnership("LoadingBay.tsx", "useLoadCartonOntoManifest", "load_carton_onto_manifest");
    const b = checkRpcOwnership("LoadingBay.tsx", "useDispatchManifest", "dispatch_loading_manifest");
    expect([a, b].filter(Boolean).join("\n")).toBe("");
  });
});

