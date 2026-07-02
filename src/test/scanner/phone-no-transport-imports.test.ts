/**
 * Architecture guard: `MobileScannerPage` is a pure realtime client.
 *
 * It must NEVER import scan transport primitives (`scanBus`,
 * `scanRouter`, or the desk-side `usePOSScannerChannel`/`useScanChannel`
 * hooks). The phone speaks only the realtime broadcast contract; coupling
 * it to in-process buses would silently fork the routing logic the
 * desktop terminal depends on.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const FILE = path.resolve(
  __dirname,
  "../..",
  "pages/pos/MobileScannerPage.tsx",
);

const FORBIDDEN = [
  "@/services/pos/scanBus",
  "@/services/pos/scanRouter",
  "@/hooks/pos/usePOSScannerChannel",
  "@/hooks/pos/useScanChannel",
  "@/services/pos/scanFeedbackBus",
];

describe("phone scanner page transport isolation", () => {
  const src = readFileSync(FILE, "utf8");

  it.each(FORBIDDEN)("does not import %s", (mod) => {
    const re = new RegExp(`from\\s+["']${mod.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}["']`);
    expect(re.test(src)).toBe(false);
  });

  it("does communicate exclusively via the supabase realtime channel", () => {
    expect(/from\s+["']@\/integrations\/supabase\/client["']/.test(src)).toBe(true);
  });
});