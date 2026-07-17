/**
 * Capability registry consistency test.
 *
 * Guardrails to keep the capability layer honest as more integration
 * points are added:
 *
 * 1. Every capability declared in `Capability` has a provider entry in
 *    `CAPABILITY_PROVIDERS`.
 * 2. Every provider `appId` refers to a real app in `APP_REGISTRY`.
 * 3. Every provider app declares the capability in its `provides`
 *    array (so the registry is the single source of truth — no
 *    "phantom" provider apps).
 * 4. No retired app id appears as a provider.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITY_PROVIDERS } from "@/lib/apps/capabilities";
import { APP_REGISTRY, getAppById } from "@/lib/apps/registry";

// Retired app ids (kept in sync with docs/architecture/APP_LIFECYCLE.md).
const RETIRED_APP_IDS = new Set(["recruitment", "sign", "spreadsheets", "documents"]);

describe("app capability registry", () => {
  it("every capability points at a real, non-retired app", () => {
    for (const [cap, appId] of Object.entries(CAPABILITY_PROVIDERS)) {
      expect(RETIRED_APP_IDS.has(appId), `${cap} → retired app ${appId}`).toBe(false);
      expect(getAppById(appId), `${cap} → unknown appId ${appId}`).toBeTruthy();
    }
  });

  it("provider apps declare the capabilities they own", () => {
    for (const [cap, appId] of Object.entries(CAPABILITY_PROVIDERS)) {
      const app = getAppById(appId);
      expect(app?.provides ?? [], `${appId}.provides missing ${cap}`).toContain(cap);
    }
  });

  it("no app declares a capability it does not own", () => {
    for (const app of APP_REGISTRY) {
      for (const cap of app.provides ?? []) {
        expect(
          CAPABILITY_PROVIDERS[cap],
          `${app.id} claims ${cap} but registry maps it elsewhere`,
        ).toBe(app.id);
      }
    }
  });
});
