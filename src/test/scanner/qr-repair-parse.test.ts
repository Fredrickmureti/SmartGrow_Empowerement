import { describe, it, expect } from "vitest";
import { parsePairingUrl } from "@/services/scanner/parsePairingUrl";

describe("parsePairingUrl", () => {
  const TOKEN = "abc123XYZ_token-value-9876543210";

  it("extracts token from canonical /scan/<token> path form", () => {
    expect(parsePairingUrl(`https://app.example.com/scan/${TOKEN}`)).toBe(TOKEN);
  });

  it("extracts token from canonical /scan#<token> fragment form", () => {
    expect(parsePairingUrl(`https://app.example.com/scan#${TOKEN}`)).toBe(TOKEN);
  });

  it("extracts token from canonical path form with trailing slash", () => {
    expect(parsePairingUrl(`https://app.example.com/scan/${TOKEN}/`)).toBe(TOKEN);
  });

  it("extracts token from legacy /pos/scan/<token> path form", () => {
    expect(parsePairingUrl(`https://app.example.com/pos/scan/${TOKEN}`)).toBe(TOKEN);
  });

  it("extracts token from legacy /pos/scan#<token> fragment form", () => {
    expect(parsePairingUrl(`https://app.example.com/pos/scan#${TOKEN}`)).toBe(TOKEN);
  });

  it("extracts token from legacy path form with trailing slash", () => {
    expect(parsePairingUrl(`https://app.example.com/pos/scan/${TOKEN}/`)).toBe(TOKEN);
  });

  it("accepts a bare token (manual paste)", () => {
    expect(parsePairingUrl(TOKEN)).toBe(TOKEN);
  });

  it("returns null for unrelated URLs", () => {
    expect(parsePairingUrl("https://example.com/other/path")).toBeNull();
    expect(parsePairingUrl("https://example.com/pos/foo/bar")).toBeNull();
  });

  it("returns null for empty / nullish", () => {
    expect(parsePairingUrl("")).toBeNull();
    expect(parsePairingUrl(null)).toBeNull();
    expect(parsePairingUrl(undefined)).toBeNull();
    expect(parsePairingUrl("   ")).toBeNull();
  });

  it("rejects too-short tokens", () => {
    expect(parsePairingUrl("https://x.test/scan/short")).toBeNull();
    expect(parsePairingUrl("https://x.test/pos/scan/short")).toBeNull();
    expect(parsePairingUrl("short")).toBeNull();
  });
});
