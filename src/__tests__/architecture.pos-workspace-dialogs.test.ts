/**
 * Architecture guardrail — POS workspaces must not use `<Dialog>` for
 * phase-changing surfaces (payment, receipt, returns, history).
 *
 * The workstation-states contract (docs/architecture/POS_WORKSTATION_STATES.md)
 * requires phase transitions to be represented as dedicated workspaces
 * routed under `/pos/terminal/:registerId/{tender,receipt,return,history}`
 * — not as `<Dialog>` overlays. Sheets (via `SheetShell`) are legal for
 * sale-scoped side-panels only and are enforced by
 * `SHEETS_ALLOWED_PER_PHASE` in the reducer.
 *
 * This test scans the POS terminal module and fails if a component under
 * `src/apps/pos/terminal/**` imports `Dialog` from `@/components/ui/dialog`
 * — such imports would let a workspace re-introduce the popup pattern
 * that the workstation rewrite is explicitly removing.
 *
 * The legacy monolith at `src/pages/pos/POSTerminal.tsx` is exempt while
 * decomposition is in flight; the exemption is dropped in Step 6.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src/apps/pos/terminal";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("POS workspace modules", () => {
  it("do not import Dialog from @/components/ui/dialog", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const src = readFileSync(file, "utf8");
      if (/from\s+["']@\/components\/ui\/dialog["']/.test(src)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `Workspaces must use SheetShell (sale-scoped) or a routed workspace ` +
        `(phase-scoped) — not Dialog. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
