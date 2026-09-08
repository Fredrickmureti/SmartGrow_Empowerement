import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guard: the team-invitation email must never identify the application as a
 * foreign/legacy brand and must build its Accept link from the canonical
 * application URL (`app_base_url` via resolveAppBaseUrl), not the current
 * browser/preview origin or a legacy URL.
 */
describe("invitation email branding + accept URL", () => {
  const src = readFileSync("supabase/functions/send-invitation-email/index.ts", "utf8");
  const clientHelper = readFileSync("src/lib/invitations/sendInvitationEmail.ts", "utf8");

  it("contains no legacy platform brands or domains", () => {
    expect(src).not.toMatch(/accrualflow/i);
    expect(src).not.toMatch(/bookflow/i);
    expect(src).not.toMatch(/localhost/i);
  });

  it("builds the accept link from the shared application base URL", () => {
    expect(src).toMatch(/resolveAppBaseUrl\(/);
    expect(src).toMatch(/\/accept-invitation\?token=\$\{encodeURIComponent\(invitation\.token\)\}/);
    expect(src).not.toMatch(/website_url/);
  });

  it("permits only the required production host for emailed and copied links", () => {
    expect(src).toContain('const INVITATION_HOST = "https://www.growastepventures.co.ke"');
    expect(src).toMatch(/appBaseUrl !== INVITATION_HOST/);
    expect(clientHelper).toContain('const INVITATION_BASE_URL = "https://www.growastepventures.co.ke"');
    expect(clientHelper).not.toMatch(/window\.location\.origin/);
    expect(clientHelper).not.toMatch(/lovable\.app/i);
  });

  it("falls back to the organisation name, never a hardcoded brand", () => {
    expect(src).toMatch(/platform_name/);
    expect(src).toMatch(/\|\|\s*orgName/);
  });
});
