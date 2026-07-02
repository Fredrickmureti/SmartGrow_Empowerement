/**
 * Stage 2 regression guard (updated 2026-06 audit):
 * The phone-side scanner pairing URL MUST be declared in BOTH routers and
 * MUST NOT live under the POS subscription gate. Per ADR 0017 the scanner
 * is ERP-wide infrastructure (Inventory, Sales, Purchases all use it);
 * mounting it under `/pos/*` causes `SubscriptionProtectedRoute` to bounce
 * non-POS tenants to `/dashboard`.
 *
 * Canonical URL: `/scan/:token`. Legacy `/pos/scan/:token` must redirect.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("scan-route mirrored across SPA and TanStack + outside POS gate", () => {
  it("SPA App.tsx declares <Route path='/scan/:token' /> at top level (not under /pos/*)", () => {
    const src = readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");
    expect(src).toMatch(/path=["']\/scan\/:token["']/);
    expect(src).toMatch(/MobileScannerPage/);
  });

  it("SPA App.tsx keeps a back-compat redirect from /pos/scan/:token", () => {
    const src = readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");
    expect(src).toMatch(/path=["']\/pos\/scan\/:token["']/);
    expect(src).toMatch(/LegacyScanRedirect/);
  });

  it("the scan route is NOT inside the requiredFeature=\"pos\" subtree", () => {
    const src = readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");
    // Locate the POS feature-gated subtree and assert the scan route
    // declaration appears BEFORE it (top-level), so its match in react-router
    // v6 cannot accidentally fall through to the gated /pos/* element.
    const scanIdx = src.indexOf('path="/scan/:token"');
    const posGateIdx = src.search(/requiredFeature=["']pos["']/);
    expect(scanIdx).toBeGreaterThan(-1);
    expect(posGateIdx).toBeGreaterThan(-1);
    expect(scanIdx).toBeLessThan(posGateIdx);
  });

  it("TanStack canonical route file exists at src/routes/scan.$token.tsx", () => {
    const p = resolve(__dirname, "../../routes/scan.$token.tsx");
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).toMatch(/createFileRoute\(["']\/scan\/\$token["']\)/);
    expect(src).toMatch(/MobileScannerPage/);
    // Must be SSR-safe — MobileScannerPage touches navigator/localStorage.
    expect(src).toMatch(/ClientOnly/);
  });

  it("TanStack legacy /pos/scan/$token redirects to /scan/$token", () => {
    const p = resolve(__dirname, "../../routes/pos.scan.$token.tsx");
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).toMatch(/createFileRoute\(["']\/pos\/scan\/\$token["']\)/);
    expect(src).toMatch(/redirect/);
    expect(src).toMatch(/\/scan\//);
  });

  it("MobileScannerPage never navigates into the POS-gated /pos/scan namespace", () => {
    // navigate("/pos/scan") (post-claim cleanup) or navigate(`/pos/scan/${t}`)
    // (repair / unauthed redirect) re-enters the route tree and bounces
    // non-POS tenants through SubscriptionProtectedRoute to /dashboard.
    // The page must stay within the top-level /scan/:token namespace.
    const src = readFileSync(
      resolve(__dirname, "../../pages/pos/MobileScannerPage.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/navigate\(\s*["'`]\/pos\/scan/);
    // Also guard the unauthed sign-in CTA's redirect target.
    expect(src).not.toMatch(/redirect\s*=\s*[`"']\/pos\/scan/);
  });

  it("MobileScannerPage post-claim cleanup uses history.replaceState (not navigate)", () => {
    // Stripping the burned single-use token via navigate() would re-enter
    // the route tree; history.replaceState keeps the component mounted and
    // the realtime channel alive.
    const src = readFileSync(
      resolve(__dirname, "../../pages/pos/MobileScannerPage.tsx"),
      "utf8",
    );
    expect(src).toMatch(/history\.replaceState\([^)]*["'`]\/scan/);
  });
});
