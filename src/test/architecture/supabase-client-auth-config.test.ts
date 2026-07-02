/**
 * Architecture guard — pin the Supabase browser client auth options that
 * the signup / email-confirmation lifecycle depends on.
 *
 * Background: the signup lifecycle audit (see
 * docs/audit/signup-lifecycle-verdict.md) determined that the email
 * confirmation flow currently relies on the IMPLICIT flow (hash tokens at
 * `/auth/callback#access_token=…`) and on the client auto-detecting that
 * session from the URL. A future agent flipping `flowType` to `'pkce'` or
 * turning `detectSessionInUrl` off would silently break confirmation for
 * every new signup and produce the exact dead-end (`Invalid login
 * credentials`) that the audit was opened to fix.
 *
 * This test reads the source of `src/integrations/supabase/client.ts` and
 * asserts the four required options are present and set correctly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const clientSrc = readFileSync(
  join(process.cwd(), "src/integrations/supabase/client.ts"),
  "utf8",
);

describe("Supabase browser client auth config", () => {
  it("persists the session in localStorage", () => {
    expect(clientSrc).toMatch(/persistSession:\s*true/);
    expect(clientSrc).toMatch(/storage:\s*localStorage/);
  });

  it("auto-refreshes tokens", () => {
    expect(clientSrc).toMatch(/autoRefreshToken:\s*true/);
  });

  it("detects sessions from confirmation-link URLs", () => {
    expect(clientSrc).toMatch(/detectSessionInUrl:\s*true/);
  });

  it("uses the implicit auth flow expected by /auth/callback and /onboarding-setup", () => {
    expect(clientSrc).toMatch(/flowType:\s*['"]implicit['"]/);
  });
});