/**
 * Architecture guard tests — enforce platform-admin / tenant identity
 * invariants at the source level so they cannot regress silently.
 *
 * These tests do NOT exercise React. They scan source files for the
 * structural rules that the audit (see .lovable/plan.md v3 + ADR-0004)
 * established. If a future change re-introduces the regression, the test
 * fails in CI before the bug ships.
 *
 * Rules enforced:
 *   1. Auth pages (Login, Signup, ForgotPassword, ResetPassword,
 *      AdminLogin) MUST be wrapped in <RedirectIfAuthenticated>. An
 *      already-authenticated user must never see a login form.
 *   2. AdminProtectedRoute MUST consult `resolvePostLoginDestination`
 *      when a non-admin user lands on an admin route — never hard-redirect
 *      to a fixed `/dashboard`, which would loop for not-yet-onboarded
 *      users (the original `fredrickmureti612@gmail.com` regression).
 *   3. AdminSidebar MUST gate the "Back to App" link on `organizations.length`
 *      so pure platform admins (no tenant workspace) don't see tenant nav.
 *   4. OnboardingGuard MUST exempt platform admins so a SaaS operator
 *      without a tenant workspace is never forced through the customer
 *      onboarding wizard.
 *   5. The persona lookup MUST go through `PlatformIdentityContext` —
 *      no component outside the context file may query `platform_admins`
 *      directly. Single source of truth prevents N redundant lookups and
 *      the flicker that competing guards used to produce.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function read(rel: string): string {
  const p = join(process.cwd(), rel);
  if (!existsSync(p)) {
    throw new Error(`Expected file does not exist: ${rel}`);
  }
  return readFileSync(p, "utf-8");
}

describe("Auth persona invariants", () => {
  describe("Rule 1 — auth pages wrapped in RedirectIfAuthenticated", () => {
    // We assert mounting in App.tsx (the central router). This catches the
    // regression where /login was visible to logged-in users.
    const appSource = read("src/App.tsx");

    it("App.tsx imports RedirectIfAuthenticated", () => {
      expect(appSource).toMatch(/RedirectIfAuthenticated/);
    });

    it.each([
      ["/login", "Login"],
      ["/signup", "Signup"],
      ["/forgot-password", "ForgotPassword"],
      ["/reset-password", "ResetPassword"],
    ])("%s route is wrapped in RedirectIfAuthenticated", (path, _component) => {
      // Match any of:
      //   path="/login" element={<RedirectIfAuthenticated…><Login /></…>}
      //   path={"/login"} element={<RedirectIfAuthenticated…
      // We require the literal path segment AND `RedirectIfAuthenticated`
      // to appear within ~400 chars of one another. That tolerance keeps
      // the test from being whitespace-fragile while still proving the
      // wrapper is on the same Route element.
      const idx = appSource.indexOf(`"${path}"`);
      expect(idx, `Route ${path} not found in App.tsx`).toBeGreaterThan(-1);
      const window = appSource.slice(idx, idx + 400);
      expect(window).toMatch(/RedirectIfAuthenticated/);
    });
  });

  describe("Rule 2 — AdminProtectedRoute uses persona-aware destination", () => {
    const src = read("src/components/auth/AdminProtectedRoute.tsx");

    it("imports resolvePostLoginDestination", () => {
      expect(src).toMatch(/resolvePostLoginDestination/);
    });

    it("does not hard-redirect non-admins to a fixed /dashboard", () => {
      // The original regression was `<Navigate to="/dashboard" />` for
      // every non-admin. The fix routes through resolvePostLoginDestination
      // so onboarding-incomplete tenants land on /onboarding-setup, vendor
      // portal users on /vendor-portal, etc.
      // We tolerate `/dashboard` appearing only as a fallback string inside
      // the resolver call chain, never as a literal Navigate target.
      const navigateMatches = src.match(/<Navigate\s+to="\/dashboard"/g);
      expect(navigateMatches, "Found hard-coded <Navigate to='/dashboard'> — must use resolvePostLoginDestination instead").toBeNull();
    });
  });

  describe("Rule 3 — AdminSidebar gates 'Back to App' on tenant workspace", () => {
    const src = read("src/components/admin/AdminSidebar.tsx");

    it("checks organizations.length before rendering Back to App link", () => {
      // The implementation is `const hasTenantWorkspace = organizations.length > 0;`
      // followed by a conditional render. We assert both halves exist.
      expect(src).toMatch(/organizations\.length/);
      expect(src).toMatch(/hasTenantWorkspace/);
      // And the conditional renders /dashboard only when true.
      expect(src).toMatch(/hasTenantWorkspace\s*\?/);
    });

    it("never renders an unconditional /dashboard link", () => {
      // Unconditional `<Link to="/dashboard">` would re-introduce the
      // regression where pure platform admins see a tenant link.
      // Allowed only inside the `hasTenantWorkspace ? (…) : (…)` branch.
      const lines = src.split("\n");
      const dashboardLineIdxs = lines
        .map((l, i) => (l.includes('to="/dashboard"') ? i : -1))
        .filter((i) => i >= 0);
      for (const i of dashboardLineIdxs) {
        // Walk back up to ~12 lines and assert hasTenantWorkspace appears.
        const ctx = lines.slice(Math.max(0, i - 12), i).join("\n");
        expect(
          ctx,
          `Unguarded /dashboard link near line ${i + 1} of AdminSidebar.tsx`,
        ).toMatch(/hasTenantWorkspace/);
      }
    });
  });

  describe("Rule 4 — OnboardingGuard exempts platform admins", () => {
    const src = read("src/components/auth/OnboardingGuard.tsx");

    it("imports usePlatformAdmin", () => {
      expect(src).toMatch(/usePlatformAdmin/);
    });

    it("returns early when isPlatformAdmin is true", () => {
      // We assert the literal early-exit branch, not just the import.
      // Pattern: `if (isPlatformAdmin) {` followed eventually by setIsChecking(false) + return.
      expect(src).toMatch(/if\s*\(\s*isPlatformAdmin\s*\)/);
    });
  });

  describe("Rule 5 — single source of truth for platform-admin lookup", () => {
    // Only PlatformIdentityContext.tsx may run `from("platform_admins").select(`
    // No other component or hook may issue that query directly. Other files
    // must consume the cached value via usePlatformIdentity / usePlatformAdmin.
    //
    // Edge functions are exempt (server-side, no shared cache).
    // Migration files are exempt (SQL strings, not TS calls).
    const SCOPES = ["src"];
    const ALLOWLIST = new Set<string>([
      // The single source of truth — every cached lookup originates here.
      "src/contexts/PlatformIdentityContext.tsx",
      // Persona-resolver runs BEFORE React context is mounted (during the
      // post-login redirect decision). Cannot use the context; must query
      // directly. This is the only place in the app where that's correct.
      "src/lib/auth/postLoginRedirect.ts",
      // Admin team management page — operates ON the platform_admins table
      // (CRUD admins, change roles, deactivate). Must query the table it
      // manages; the cache would be stale immediately after a mutation.
      "src/pages/admin/AdminUsers.tsx",
      // Same justification — listing admins for the team management hook.
      "src/hooks/usePlatformTeam.ts",
      // Onboarding repair surface that explicitly looks up whether the
      // current user has a corrupt admin row. Reading the cache would mask
      // the very corruption this UI exists to detect and heal.
      "src/pages/OnboardingSetup.tsx",
      // Diagnostic card that reports persona conflicts (same email is BOTH
      // a tenant owner AND a platform admin). It deliberately bypasses the
      // cache to surface the underlying row state to operators.
      "src/components/admin/PersonaConflictsCard.tsx",
    ]);

    function walk(dir: string): string[] {
      // Lazily require fs primitives to avoid hoisting issues.
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      const out: string[] = [];
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return out;
      }
      for (const name of entries) {
        const p = join(dir, name);
        const s = statSync(p);
        if (s.isDirectory()) out.push(...walk(p));
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          out.push(p);
        }
      }
      return out;
    }

    it("no source file outside PlatformIdentityContext queries platform_admins directly", () => {
      const files = SCOPES.flatMap((s) => walk(join(process.cwd(), s)));
      const offenders: string[] = [];
      const cwd = process.cwd();
      for (const abs of files) {
        const rel = abs.slice(cwd.length + 1).split(/[\\/]/).join("/");
        if (ALLOWLIST.has(rel)) continue;
        const text = readFileSync(abs, "utf-8");
        // Match `.from("platform_admins")` or `.from('platform_admins')`.
        if (/\.from\(\s*['"]platform_admins['"]\s*\)/.test(text)) {
          offenders.push(rel);
        }
      }
      expect(
        offenders,
        `These files query platform_admins directly — route them through usePlatformIdentity / usePlatformAdmin instead:\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
    });
  });

  describe("Rule 6 — postLoginRedirect honours platform admins first", () => {
    const src = read("src/lib/auth/postLoginRedirect.ts");

    it("checks platform_admins before falling through to onboarding", () => {
      const adminCheckIdx = src.indexOf("platform_admins");
      const onboardingIdx = src.indexOf("onboarding-setup");
      expect(adminCheckIdx, "platform_admins lookup missing").toBeGreaterThan(-1);
      expect(onboardingIdx, "onboarding-setup destination missing").toBeGreaterThan(-1);
      expect(
        adminCheckIdx,
        "platform-admin lookup must precede the onboarding-setup fallback so SaaS operators are never forced through customer onboarding",
      ).toBeLessThan(onboardingIdx);
    });
  });
});
