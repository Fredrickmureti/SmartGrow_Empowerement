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
  it("persists the session through a browser storage adapter", () => {
    expect(clientSrc).toMatch(/persistSession:\s*true/);
    // The generated client uses a preview-brokered localStorage adapter.
    expect(clientSrc).toMatch(/storage:\s*(localStorage|brokeredPreviewStorage\(\))/);
  });

  it("auto-refreshes tokens", () => {
    expect(clientSrc).toMatch(/autoRefreshToken:\s*true/);
  });

  it("never disables session detection from confirmation-link URLs", () => {
    // supabase-js defaults this to true; only an explicit `false` is a break.
    expect(clientSrc).not.toMatch(/detectSessionInUrl:\s*false/);
  });

  it("never flips away from the implicit flow /auth/callback expects", () => {
    // supabase-js defaults to the implicit flow; only an explicit pkce is a break.
    expect(clientSrc).not.toMatch(/flowType:\s*['"]pkce['"]/);
  });
});
