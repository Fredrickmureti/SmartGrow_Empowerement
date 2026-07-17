/**
 * Architecture guard — the install operation (now living inside the
 * consolidated `localization-pack` router) must not reference tables
 * that don't exist in the database (`organization_apps`,
 * `available_apps`). The previous gate silently failed because of
 * `.maybeSingle()`, causing every install to skip payroll rule seeding.
 *
 * After consolidation the install logic moved from the standalone
 * `install-localization-pack` edge function into
 * `supabase/functions/localization-pack/ops/install.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const INSTALL_OP_PATH = "supabase/functions/localization-pack/ops/install.ts";

describe("localization-pack install op", () => {
  it("does not reference removed tables organization_apps / available_apps", () => {
    const src = readFileSync(INSTALL_OP_PATH, "utf8");
    expect(src).not.toMatch(/from\(\s*["']organization_apps["']\s*\)/);
    expect(src).not.toMatch(/from\(\s*["']available_apps["']\s*\)/);
  });

  it("supports force_reseed for re-applying templates", () => {
    const src = readFileSync(INSTALL_OP_PATH, "utf8");
    expect(src).toMatch(/force_reseed/);
  });
});
