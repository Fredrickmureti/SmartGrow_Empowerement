/**
 * Architecture guard: the AcceptInvitation page must NOT contain a
 * "I have an account / I'm new here" tab pair. Routing between the
 * signup and login branches is decided server-side by the
 * `resolve-invitation` edge function and surfaced via `useInvitation`'s
 * `route` field. See docs/audit/2026-06-13-invitation-architecture.md.
 *
 * This test prevents a regression where someone re-introduces the tabbed
 * UI and forces invitees to self-classify — the exact anti-pattern that
 * the architecture audit removed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("AcceptInvitation server-driven routing", () => {
  const src = readFileSync(
    join(process.cwd(), "src/pages/AcceptInvitation.tsx"),
    "utf-8",
  );

  it("does not import Tabs primitives", () => {
    expect(src).not.toMatch(/from\s+["']@\/components\/ui\/tabs["']/);
  });

  it("does not render TabsTrigger / TabsContent", () => {
    expect(src).not.toMatch(/<TabsTrigger\b/);
    expect(src).not.toMatch(/<TabsContent\b/);
    expect(src).not.toMatch(/<Tabs\b/);
  });

  it("does not contain the 'I have an account / I'm new here' anti-pattern strings", () => {
    expect(src).not.toMatch(/I have an account/i);
    expect(src).not.toMatch(/I'm new here/i);
  });

  it("renders branches based on the server-resolved `route`", () => {
    expect(src).toMatch(/route === ["']login["']/);
    expect(src).toMatch(/route === ["']signup["']/);
  });

  it("uses validate-invitation as the single server-driven router endpoint", () => {
    const hook = readFileSync(
      join(process.cwd(), "src/hooks/useInvitation.ts"),
      "utf-8",
    );
    // validate-invitation now returns the server-decided `route` field.
    // We MUST call it; we must NOT call a separate resolve-invitation
    // endpoint (which has been removed to stay within the function quota).
    expect(hook).toMatch(/functions\.invoke\(["']validate-invitation["']/);
    expect(hook).not.toMatch(/functions\.invoke\(["']resolve-invitation["']/);
  });

  it("does not pass a client-supplied user_id to accept-invitation", () => {
    const page = readFileSync(
      join(process.cwd(), "src/pages/AcceptInvitation.tsx"),
      "utf-8",
    );
    const hook = readFileSync(
      join(process.cwd(), "src/hooks/useInvitation.ts"),
      "utf-8",
    );
    // The server now derives identity from the Authorization JWT. Passing
    // user_id from the browser would re-introduce an impersonation vector.
    expect(page).not.toMatch(/accept-invitation[\s\S]{0,400}user_id\s*:/);
    expect(hook).not.toMatch(/accept-invitation[\s\S]{0,400}user_id\s*:/);
  });
});
