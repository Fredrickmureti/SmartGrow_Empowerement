/**
 * Architecture guard — all frontend callers of install-localization-pack
 * MUST route through the consolidated `localization-pack` router edge
 * function via the typed `invokeLocalizationPack` helper. This ensures
 *   (a) the user JWT is attached deterministically (invokeWithAuth
 *       semantics), and
 *   (b) no caller regresses to the retired standalone edge function.
 *
 * Raw `supabase.functions.invoke("install-localization-pack", ...)` is
 * banned because it silently falls back to the anon key when no session
 * is hydrated AND it targets an edge function that no longer exists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const CALL_SITES = [
  "src/pages/hr/payroll/Setup.tsx",
  "src/components/settings/LocalizationPackSettings.tsx",
  "src/components/onboarding/LocalizationPackPrompt.tsx",
  "src/components/payroll/PayrollSetupGuideDialog.tsx",
];

describe("install-localization-pack frontend callers", () => {
  for (const file of CALL_SITES) {
    it(`${file} routes through invokeLocalizationPack (router), not raw supabase.functions.invoke or the retired standalone function`, () => {
      const src = readFileSync(file, "utf8");
      // The op identifier must still be present (grep continuity).
      expect(src).toMatch(/install-localization-pack/);
      // Must NOT invoke either the retired standalone edge function or
      // the router directly via raw supabase.functions.invoke.
      const rawStandalone =
        /supabase\.functions\.invoke\(\s*["']install-localization-pack["']/;
      const rawRouter =
        /supabase\.functions\.invoke\(\s*["']localization-pack["']/;
      expect(src).not.toMatch(rawStandalone);
      expect(src).not.toMatch(rawRouter);
      // Must go through the typed helper.
      const routerCall =
        /invokeLocalizationPack\(\s*["']install-localization-pack["']/;
      expect(src).toMatch(routerCall);
    });
  }
});
