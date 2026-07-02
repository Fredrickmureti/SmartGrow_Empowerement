/**
 * Architecture guard — install-localization-pack must not reference
 * tables that don't exist in the database (`organization_apps`,
 * `available_apps`). The previous gate silently failed because of
 * `.maybeSingle()`, causing every install to skip payroll rule seeding.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("install-localization-pack edge function", () => {
  it("does not reference removed tables organization_apps / available_apps", () => {
    const src = readFileSync(
      "supabase/functions/install-localization-pack/index.ts",
      "utf8",
    );
    expect(src).not.toMatch(/from\(\s*["']organization_apps["']\s*\)/);
    expect(src).not.toMatch(/from\(\s*["']available_apps["']\s*\)/);
  });

  it("supports force_reseed for re-applying templates", () => {
    const src = readFileSync(
      "supabase/functions/install-localization-pack/index.ts",
      "utf8",
    );
    expect(src).toMatch(/force_reseed/);
  });
});