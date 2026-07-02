/**
 * Architecture guard (H3) — pack upgrades must have a rollback path.
 * Verifies:
 *  - the `rollback_pack_upgrade_atomic` RPC is defined in a migration,
 *  - the `rollback-localization-pack-upgrade` edge function exists,
 *  - the edge function uses the same shared auth helper as
 *    `apply-localization-pack-upgrade` (no bespoke auth path).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";

const REPO = path.resolve(__dirname, "../../..");
const MIGRATIONS = path.join(REPO, "supabase/migrations");
const FUNC = path.join(REPO, "supabase/functions/rollback-localization-pack-upgrade/index.ts");
const APPLY_FUNC = path.join(REPO, "supabase/functions/apply-localization-pack-upgrade/index.ts");

describe("pack-upgrade-rollback", () => {
  it("defines rollback_pack_upgrade_atomic in a migration", () => {
    const hit = readdirSync(MIGRATIONS).some((f) =>
      readFileSync(path.join(MIGRATIONS, f), "utf8").includes(
        "FUNCTION public.rollback_pack_upgrade_atomic",
      ),
    );
    expect(hit).toBe(true);
  });

  it("ships the rollback edge function", () => {
    expect(existsSync(FUNC)).toBe(true);
    const src = readFileSync(FUNC, "utf8");
    expect(src).toMatch(/rollback_pack_upgrade_atomic/);
    expect(src).toMatch(/requireAuthenticatedUser/);
  });

  it("rollback fn uses the same shared auth helper as apply fn", () => {
    const apply = readFileSync(APPLY_FUNC, "utf8");
    const rollback = readFileSync(FUNC, "utf8");
    const SHARED = "_shared/localizationAuth.ts";
    expect(apply.includes(SHARED)).toBe(true);
    expect(rollback.includes(SHARED)).toBe(true);
  });
});