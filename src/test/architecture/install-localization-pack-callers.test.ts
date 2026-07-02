/**
 * Architecture guard — all frontend callers of install-localization-pack
 * MUST go through invokeWithAuth so the user JWT is attached deterministically
 * and missing-session is surfaced as NotAuthenticatedError.
 *
 * Raw `supabase.functions.invoke("install-localization-pack", ...)` is banned
 * because it silently falls back to the anon key when no session is hydrated.
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
    it(`${file} uses invokeWithAuth, not raw supabase.functions.invoke`, () => {
      const src = readFileSync(file, "utf8");
      // The literal string "install-localization-pack" appears.
      expect(src).toMatch(/install-localization-pack/);
      // It must NOT be invoked via supabase.functions.invoke.
      const rawCall =
        /supabase\.functions\.invoke\(\s*["']install-localization-pack["']/;
      expect(src).not.toMatch(rawCall);
      // It MUST be invoked via invokeWithAuth.
      const authCall = /invokeWithAuth\(\s*["']install-localization-pack["']/;
      expect(src).toMatch(authCall);
    });
  }
});
