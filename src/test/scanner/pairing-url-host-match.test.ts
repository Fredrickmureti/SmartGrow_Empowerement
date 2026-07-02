/**
 * publicAppUrl: production-host-first resolution (2026-06-04).
 *
 * The QR pairing host is always the canonical production URL unless an
 * explicit override is configured. This prevents localhost / preview URLs
 * from ending up inside QR codes that get scanned from a different device.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getPublicAppUrl,
  PRODUCTION_APP_URL,
  __publicAppUrlInternals,
} from "@/lib/publicAppUrl";

const { STORAGE_KEY } = __publicAppUrlInternals;

describe("pairing URL host resolution", () => {
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

  it("defaults to the production host, ignoring localhost origin", () => {
    expect(getPublicAppUrl()).toBe(PRODUCTION_APP_URL);
    expect(getPublicAppUrl()).not.toBe(window.location.origin);
  });

  it("operator localStorage override wins over production default", () => {
    window.localStorage.setItem(STORAGE_KEY, "https://operator.example.com");
    expect(getPublicAppUrl()).toBe("https://operator.example.com");
  });

  it("runtime window override beats every other source", () => {
    (window as any).__POS_PUBLIC_APP_URL__ = "https://runtime.example.com";
    window.localStorage.setItem(STORAGE_KEY, "https://operator.example.com");
    vi.stubEnv("VITE_PUBLIC_APP_URL", "http://accrualflow.systems");
    expect(getPublicAppUrl()).toBe("https://runtime.example.com");
  });

  it("env override wins over the production default", () => {
    vi.stubEnv("VITE_PUBLIC_APP_URL", "https://env.example.com");
    expect(getPublicAppUrl()).toBe("https://env.example.com");
  });
});
