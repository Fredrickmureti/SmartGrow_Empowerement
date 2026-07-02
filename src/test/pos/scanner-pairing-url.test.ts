import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getPublicAppUrl,
  setPublicAppUrlOverride,
  PRODUCTION_APP_URL,
  __publicAppUrlInternals,
} from "@/lib/publicAppUrl";

const { STORAGE_KEY } = __publicAppUrlInternals;

describe("publicAppUrl resolver", () => {
  beforeEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    delete (window as any).__POS_PUBLIC_APP_URL__;
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    delete (window as any).__POS_PUBLIC_APP_URL__;
    vi.unstubAllEnvs();
  });

  it("prefers the runtime window override", () => {
    (window as any).__POS_PUBLIC_APP_URL__ = "https://runtime.example.com/";
    window.localStorage.setItem(STORAGE_KEY, "https://stored.example.com");
    vi.stubEnv("VITE_PUBLIC_APP_URL", "https://env.example.com");
    expect(getPublicAppUrl()).toBe("https://runtime.example.com");
  });

  it("falls back to the localStorage operator override", () => {
    window.localStorage.setItem(STORAGE_KEY, "https://stored.example.com");
    vi.stubEnv("VITE_PUBLIC_APP_URL", "https://env.example.com");
    expect(getPublicAppUrl()).toBe("https://stored.example.com");
  });

  it("uses VITE_PUBLIC_APP_URL when no override is set", () => {
    vi.stubEnv("VITE_PUBLIC_APP_URL", "https://env.example.com");
    expect(getPublicAppUrl()).toBe("https://env.example.com");
  });

  it("defaults to the production host (never localhost/preview origins)", () => {
    // Post-2026-06-04: location.origin is intentionally NOT considered.
    // A QR scanned from another device must never encode localhost or
    // a preview URL.
    expect(getPublicAppUrl()).toBe(PRODUCTION_APP_URL);
    expect(getPublicAppUrl()).not.toBe(window.location.origin);
  });

  it("normalize rejects non-network protocols", () => {
    expect(__publicAppUrlInternals.normalize("file:///some/path")).toBeNull();
    expect(__publicAppUrlInternals.normalize("app://x")).toBeNull();
    expect(__publicAppUrlInternals.normalize("chrome-extension://abc")).toBeNull();
    expect(__publicAppUrlInternals.normalize("not a url")).toBeNull();
    expect(__publicAppUrlInternals.normalize("  ")).toBeNull();
  });

  it("normalize accepts http and https origins, strips trailing slash", () => {
    expect(__publicAppUrlInternals.normalize("https://x.com/")).toBe("https://x.com");
    expect(__publicAppUrlInternals.normalize("http://accrualflow.systems")).toBe(
      "http://accrualflow.systems",
    );
  });

  it("setPublicAppUrlOverride normalizes and persists", () => {
    setPublicAppUrlOverride("https://operator.example.com/");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("https://operator.example.com");
    expect(getPublicAppUrl()).toBe("https://operator.example.com");
  });

  it("setPublicAppUrlOverride rejects non-network URLs", () => {
    expect(() => setPublicAppUrlOverride("file:///x")).toThrow();
  });

  it("setPublicAppUrlOverride(null) clears", () => {
    window.localStorage.setItem(STORAGE_KEY, "https://x.example.com");
    setPublicAppUrlOverride(null);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("architecture: no location.origin in pairing URL construction", () => {
  it("scanner pairing files do not concatenate location.origin with /pos/scan", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const files = [
      "src/hooks/scanner/useScannerSession.ts",
      "src/components/scanner/ScannerSessionDialog.tsx",
      "src/components/pos/MobileScannerDialog.tsx",
    ];
    for (const rel of files) {
      const content = await fs.readFile(path.resolve(process.cwd(), rel), "utf8");
      const offending = /location\.origin[^]{0,80}\/pos\/scan/.test(content);
      expect(offending, `${rel} must not build pairing URL from location.origin`).toBe(false);
    }
  });
});
