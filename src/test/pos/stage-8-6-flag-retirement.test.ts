/**
 * Stage 8.6 — assert that the dropped pos_security_settings flag/threshold
 * column names do not reappear anywhere under src/, except:
 *   - the documentation block in usePOSSecuritySettings.ts (lists them as removed)
 *   - the generated supabase types file (regenerated from DB; will self-clean)
 *   - the legacy stage-5-void.test.ts (kept as historical fixture)
 */
import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

const BANNED = [
  "require_manager_pin_for_void",
  "void_requires_manager_above_amount",
  "require_manager_pin_for_return",
  "return_requires_manager_above_amount",
  "cash_out_requires_manager_above_amount",
  "safe_drop_requires_manager_above_amount",
  "bank_deposit_requires_manager_above_amount",
  "require_manager_pin_for_discount",
  "discount_limit_requires_approval",
  "shift_variance_requires_manager_above_amount",
];

const ALLOWED_FILES = new Set([
  "src/hooks/pos/usePOSSecuritySettings.ts",
  "src/integrations/supabase/types.ts",
  "src/test/pos/stage-5-void.test.ts",
  "src/test/pos/stage-8-6-flag-retirement.test.ts",
]);

describe("Stage 8.6 — flag retirement", () => {
  for (const flag of BANNED) {
    it(`no live source references "${flag}"`, () => {
      let output = "";
      try {
        output = execSync(
          `rg -l --no-messages "${flag}" src/`,
          { encoding: "utf8" },
        );
      } catch {
        // rg exits 1 when no matches — that's the green path.
        return;
      }
      const offenders = output
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((p) => !ALLOWED_FILES.has(p));
      expect(offenders).toEqual([]);
    });
  }
});
