/**
 * Architecture guard: nothing in src/ may directly UPDATE employees.user_id.
 * All link / unlink writes MUST go through link_employee_to_user /
 * unlink_employee_from_user RPCs so the audit + protection triggers run.
 *
 * If this test fails, the writer is bypassing the identity-change pipeline
 * and re-introducing the original admin-lockout regression.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, files);
    else if (/\.(ts|tsx)$/.test(entry)) files.push(p);
  }
  return files;
}

describe("no direct employees.user_id mutation", () => {
  it("never writes user_id via .from('employees').update(...) outside accept-invitation edge", () => {
    const files = walk("src");
    const offenders: string[] = [];
    const pattern = /\.from\(\s*["']employees["']\s*\)[\s\S]{0,200}\.update\(\s*\{[\s\S]{0,400}user_id/;
    for (const f of files) {
      if (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
      const src = readFileSync(f, "utf8");
      if (pattern.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe("EmployeeLinkDialog candidate assembly is server-side (Wave H F4)", () => {
  // The picker MUST call get_linkable_users_for_employee and MUST NOT
  // read profiles / user_roles / platform_admins / organizations /
  // employees directly. Server-side assembly is what stops user
  // identities and role labels from leaking to the browser.
  const dialogPath = "src/components/employees/EmployeeLinkDialog.tsx";
  const src = readFileSync(dialogPath, "utf8");

  it("calls the get_linkable_users_for_employee RPC", () => {
    expect(src).toMatch(/get_linkable_users_for_employee/);
  });

  it("does not read user-identity tables directly", () => {
    const banned = [
      /\.from\(\s*["']profiles["']/,
      /\.from\(\s*["']user_roles["']/,
      /\.from\(\s*["']platform_admins["']/,
      /\.from\(\s*["']organizations["']/,
      /\.from\(\s*["']employees["']/,
    ];
    for (const re of banned) {
      expect(src, `${dialogPath} must not contain ${re}`).not.toMatch(re);
    }
  });
});

describe("no stale /auth route references", () => {
  // The app's login route is `/login`. There is no `/auth` route in the
  // router. Any `navigate("/auth"...)` or `<Navigate to="/auth"...>` after
  // sign-out lands users on the 404 page. Keep `/login` as the single
  // source of truth for the unauthenticated landing.
  it("never redirects to a non-existent /auth route from app code", () => {
    const files = walk("src");
    const offenders: string[] = [];
    const navigatePattern = /navigate\(\s*["']\/auth["']/;
    const componentPattern = /<\s*Navigate[^>]*\bto\s*=\s*["']\/auth["']/;
    for (const f of files) {
      if (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
      // /auth/callback is a real route — allow that prefix.
      const src = readFileSync(f, "utf8");
      if (navigatePattern.test(src) || componentPattern.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
