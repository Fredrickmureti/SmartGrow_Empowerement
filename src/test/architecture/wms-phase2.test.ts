/**
 * Architecture guard — WMS Phase 2 (Receiving → Putaway).
 *
 * Phase 2 introduces two RPCs that MUST own the write side of the
 * receiving → putaway loop:
 *
 *   • receive_goods_to_wms(p_goods_receipt_id, p_staging_location_id)
 *     Mints LPNs, moves receipt stock to a staging bin, ranks
 *     putaway destinations, and inserts `wms_tasks` of type
 *     `putaway`. This is the ONLY sanctioned way to seed putaway
 *     tasks from the ledger.
 *
 *   • complete_putaway_task(p_task_id)
 *     Atomically moves the LPN to the task's destination bin and
 *     transitions the task to `done` while emitting
 *     `warehouse.putaway.completed` on the outbox.
 *
 * Client code that bypasses either RPC breaks the audit trail and
 * the event fabric — reject at CI time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { domainCallRe } from "./wmsGuardUtils";

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

describe("wms phase 2 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("no client code inserts putaway tasks directly (must use receive_goods_to_wms)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Look for supabase.from("wms_tasks").insert({... task_type: "putaway" ...})
      if (
        /from\(\s*["']wms_tasks["']\s*\)/.test(src) &&
        /\.insert\s*\(\s*[\s\S]{0,400}?task_type\s*:\s*["']putaway["']/.test(src)
      ) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Seed putaway tasks via supabase.rpc("receive_goods_to_wms", ...) — never .insert({task_type:"putaway"}):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no client code marks a putaway task done via a bare UPDATE (must use complete_putaway_task)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // .update({state: "done" or state:"done"}) on wms_tasks in a file that ALSO scopes to putaway.
      const touchesTasks = /from\(\s*["']wms_tasks["']\s*\)/.test(src);
      const mentionsPutaway = /task_type\s*[=:]?\s*=?\s*["']putaway["']|["']putaway["']/.test(src);
      const bareDoneUpdate = /\.update\s*\(\s*\{[^}]*state\s*:\s*["']done["']/s.test(src);
      const callsRpc = domainCallRe("complete_putaway_task").test(src);
      if (touchesTasks && mentionsPutaway && bareDoneUpdate && !callsRpc) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(
      offenders,
      `Complete putaway via supabase.rpc("complete_putaway_task", { p_task_id }) — never a bare .update({state:"done"}):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("PutawayQueue calls the completion RPC", () => {
    const src = readFileSync(path.join(SRC, "pages/warehouse/PutawayQueue.tsx"), "utf8");
    expect(domainCallRe("complete_putaway_task").test(src)).toBe(true);
  });

  it("no client code calls the staging RPC directly (posting a session owns it)", () => {
    // Receiving audit Phase 4b: `receive_goods_to_wms` is invoked from inside
    // `wms_post_receiving_session`. No surface may stage a receipt after the fact.
    const offenders = files.filter((f) =>
      domainCallRe("receive_goods_to_wms").test(readFileSync(f, "utf8")),
    );
    expect(
      offenders.map((f) => path.relative(SRC, f)),
      "Stage through wms_post_receiving_session, never receive_goods_to_wms directly",
    ).toEqual([]);
  });
});
